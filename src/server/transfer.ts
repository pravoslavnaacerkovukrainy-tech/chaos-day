/**
 * Импорт файла Mac-версии (форматы v1–v9) и экспорт в JSON и Markdown.
 *
 * Импорт идемпотентен по идентификаторам: повторный прогон того же файла
 * не создаёт копий. Неизвестная более новая версия отклоняется с объяснением,
 * а не обрезается молча.
 */
import { randomUUID } from 'node:crypto';
import { isValidDayKey } from './dates.ts';
import { ApiError, MESSAGES } from './errors.ts';
import { num, strOrNull } from './store.ts';
import type { Row, Store } from './store.ts';
import { AREAS, TASK_STATUSES, TASK_STATUS_TITLES } from './types.ts';
import type { Area, DayKey, ImportCounts, ImportReport, TaskStatus } from './types.ts';

export const MAC_FORMAT = 'daylog';
export const MAC_MIN_VERSION = 1;
export const MAC_MAX_VERSION = 9;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Json = Record<string, unknown>;
type CountsKey = keyof ImportCounts;
type Action = 'added' | 'updated' | 'skipped';

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  const result: Json[] = [];
  for (const item of value) {
    const object = asObject(item);
    if (object) result.push(object);
  }
  return result;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asOptionalText(value: unknown): string | null {
  const text = asText(value);
  return text === '' ? null : text;
}

/** UUID из файла Mac приводится к нижнему регистру: Swift пишет их в верхнем. */
function asId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

function asInstant(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = new Date(value.trim()).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) * 1000 : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value / 1000) * 1000;
  }
  return null;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1;
}

function dayKeyInZone(ms: number, timeZone: string): DayKey {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/** Момент времени из файла становится календарным днём в часовом поясе владельца. */
function instantToDayKey(value: unknown, timeZone: string): DayKey | null {
  const ms = asInstant(value);
  return ms === null ? null : dayKeyInZone(ms, timeZone);
}

/** День работы уже хранится календарным ключом и переносится как есть. */
function asStoredDayKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return isValidDayKey(trimmed) ? trimmed : '';
}

function asArea(value: unknown, fallback: Area): Area {
  const raw = typeof value === 'string' ? value : '';
  return (AREAS as readonly string[]).includes(raw) ? (raw as Area) : fallback;
}

function asStatus(value: unknown, fallback: TaskStatus): TaskStatus {
  const raw = typeof value === 'string' ? value : '';
  return (TASK_STATUSES as readonly string[]).includes(raw) ? (raw as TaskStatus) : fallback;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ */
/* Чтение документа                                                    */
/* ------------------------------------------------------------------ */

export interface MacDocument {
  version: number;
  entries: Json[];
  plans: Json[];
  notes: Json[];
  projects: Json[];
  chaos: Json[];
  noteFolders: Json[];
}

export function parseMacDocument(text: string): MacDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(422, 'unreadable_file', MESSAGES.unreadableFile(reason));
  }
  const document = asObject(parsed);
  if (!document) {
    throw new ApiError(422, 'unreadable_file', MESSAGES.unreadableFile('ожидается объект'));
  }
  const format = typeof document.format === 'string' ? document.format : '';
  if (format !== MAC_FORMAT) {
    throw new ApiError(422, 'unsupported_format', MESSAGES.unknownFormat(format));
  }
  const version = Number(document.version);
  if (!Number.isInteger(version) || version < MAC_MIN_VERSION || version > MAC_MAX_VERSION) {
    throw new ApiError(
      422,
      'unsupported_format',
      MESSAGES.unsupportedFormat(document.version ?? 'не указана', MAC_MAX_VERSION),
    );
  }
  return {
    version,
    entries: asArray(document.entries),
    plans: asArray(document.plans),
    notes: asArray(document.notes),
    projects: asArray(document.projects),
    chaos: asArray(document.chaos),
    noteFolders: asArray(document.noteFolders),
  };
}

/* ------------------------------------------------------------------ */
/* Импорт                                                              */
/* ------------------------------------------------------------------ */

export type ImportMode = 'merge' | 'overwrite';

/**
 * В режиме merge существующий объект перезаписывается, только если импортированная
 * отметка времени новее сохранённой. Так повторный импорт того же файла даёт «skipped»,
 * а старый файл не затирает свежие правки.
 */
function decide(storedAt: number | null, incomingAt: number, mode: ImportMode): Action {
  if (storedAt === null) return 'added';
  if (mode === 'overwrite') return 'updated';
  return incomingAt > storedAt ? 'updated' : 'skipped';
}

export function importDocument(store: Store, text: string, mode: ImportMode = 'merge'): ImportReport {
  const document = parseMacDocument(text);
  const timeZone = store.timeZone;
  const now = Date.now();
  const report: ImportReport = {
    source_version: document.version,
    mode,
    added: store.emptyCounts(),
    updated: store.emptyCounts(),
    skipped: store.emptyCounts(),
    warnings: [],
  };
  const warnings = report.warnings;

  const bump = (key: CountsKey, action: Action): void => {
    report[action][key] += 1;
  };

  store.transaction(() => {
    importNoteFolders(store, document, mode, now, warnings, bump);
    importNotes(store, document, mode, now, warnings, bump);
    importProjects(store, document, timeZone, mode, now, warnings, bump);
    importTasks(store, document, timeZone, mode, now, warnings, bump);
    importEntries(store, document, mode, now, warnings, bump);
    importChaos(store, document, mode, now, warnings, bump);
  });

  return report;
}

type Bump = (key: CountsKey, action: Action) => void;

function storedAt(row: Row | undefined, column: string): number | null {
  return row === undefined ? null : num(row, column);
}

/** Папки заметок: сначала родители, затем дети. Осиротевшие становятся корневыми. */
function importNoteFolders(
  store: Store,
  document: MacDocument,
  mode: ImportMode,
  now: number,
  warnings: string[],
  bump: Bump,
): void {
  const ordered: Json[] = [];
  const remaining = [...document.noteFolders];
  const placed = new Set<string | null>([null]);
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const folder = remaining[index];
      if (!folder) continue;
      if (!placed.has(asId(folder.parentID))) continue;
      ordered.push(folder);
      const id = asId(folder.id);
      if (id) placed.add(id);
      remaining.splice(index, 1);
      progress = true;
      break;
    }
  }
  for (const orphan of remaining) {
    warnings.push(
      `Папка заметок ${asId(orphan.id) ?? 'без идентификатора'} ссылается на отсутствующего родителя, она сохранена как папка верхнего уровня.`,
    );
    ordered.push({ ...orphan, parentID: null });
  }

  for (const folder of ordered) {
    const id = asId(folder.id);
    if (!id) {
      warnings.push('Пропущена папка заметок без корректного идентификатора.');
      continue;
    }
    const name = asText(folder.name) || 'Без имени';
    const parentId = asId(folder.parentID);
    const existing = store.folderRowById(id);
    const action = existing
      ? mode === 'overwrite'
        ? 'updated'
        : 'skipped'
      : 'added';
    if (action === 'added') store.insertFolderRaw(id, name, parentId);
    else if (action === 'updated') store.updateFolderRaw(id, name, parentId);
    bump('note_folders', action);
  }
}

function importNotes(
  store: Store,
  document: MacDocument,
  mode: ImportMode,
  now: number,
  warnings: string[],
  bump: Bump,
): void {
  for (const note of document.notes) {
    const id = asId(note.id);
    if (!id) {
      warnings.push('Пропущена заметка без корректного идентификатора.');
      continue;
    }
    let folderId = asId(note.folderID);
    if (folderId !== null && store.folderRowById(folderId) === undefined) {
      warnings.push(`Заметка ${id} ссылается на несуществующую папку, она оставлена в «Без папки».`);
      folderId = null;
    }
    const createdAt = asInstant(note.createdAt) ?? now;
    const updatedAt = asInstant(note.updatedAt) ?? createdAt;
    const title = asText(note.title) || 'Без названия';
    const body = typeof note.body === 'string' ? note.body : '';
    const pinned = asBool(note.pinned);
    const action = decide(storedAt(store.noteRowById(id), 'updated_at'), updatedAt, mode);
    if (action === 'added') {
      store.insertNoteRaw({
        id, title, body, folder_id: folderId, pinned, created_at: createdAt, updated_at: updatedAt,
      });
    } else if (action === 'updated') {
      store.updateNoteRaw({ id, title, body, folder_id: folderId, pinned, updated_at: updatedAt });
    }
    bump('notes', action);
  }
}

function importProjects(
  store: Store,
  document: MacDocument,
  timeZone: string,
  mode: ImportMode,
  now: number,
  warnings: string[],
  bump: Bump,
): void {
  for (const project of document.projects) {
    const id = asId(project.id);
    if (!id) {
      warnings.push('Пропущен проект без корректного идентификатора.');
      continue;
    }
    const createdAt = asInstant(project.createdAt) ?? now;
    const updatedAt = asInstant(project.updatedAt) ?? createdAt;
    const values = {
      id,
      title: asText(project.title) || 'Без названия',
      outcome: asText(project.outcome),
      area: asArea(project.area, 'personal'),
      uncertainty: asText(project.uncertainty),
      review_date: instantToDayKey(project.reviewDate, timeZone),
      next_action_id: asId(project.nextActionID),
      archived: asBool(project.archived),
      created_at: createdAt,
      updated_at: updatedAt,
    };
    const action = decide(storedAt(store.getProjectRow(id), 'updated_at'), updatedAt, mode);
    if (action === 'added') store.insertProjectRaw(values);
    else if (action === 'updated') store.updateProjectRaw(values);
    bump('projects', action);
  }
}

function importTasks(
  store: Store,
  document: MacDocument,
  timeZone: string,
  mode: ImportMode,
  now: number,
  warnings: string[],
  bump: Bump,
): void {
  for (const plan of document.plans) {
    const id = asId(plan.id);
    if (!id) {
      warnings.push('Пропущена задача без корректного идентификатора.');
      continue;
    }
    const organization = asObject(plan.organization);
    const createdAt = asInstant(plan.createdAt) ?? now;
    const updatedAt = asInstant(plan.updatedAt) ?? createdAt;

    let projectId = organization ? asId(organization.projectID) : null;
    let area = asArea(organization?.area, 'personal');
    const projectRow = projectId === null ? undefined : store.getProjectRow(projectId);
    if (projectId !== null && projectRow === undefined) {
      warnings.push(`Задача ${id} ссылается на несуществующий проект, связь снята.`);
      projectId = null;
    } else if (projectRow) {
      // Проект задаёт сферу задачи.
      area = asArea(strOrNull(projectRow, 'area'), area);
    }

    const status = asStatus(organization?.status, 'ready');
    const steps = Array.isArray(plan.steps) ? plan.steps : null;
    const stepsJson = JSON.stringify(
      (steps ?? []).map((raw) => {
        const step = asObject(raw);
        return {
          id: asId(step?.id) ?? randomUUID(),
          text: asText(step?.text),
          completed_at: step ? isoOrNull(asInstant(step.completedAt)) : null,
        };
      }),
    );

    const values = store.makeTaskValues({
      id,
      text: asText(plan.text) || 'Без названия',
      day: asStoredDayKey(plan.day),
      deadline: organization ? instantToDayKey(organization.deadline, timeZone) : null,
      review_date: organization ? instantToDayKey(organization.reviewDate, timeZone) : null,
      area,
      project_id: projectId,
      status,
      waiting_for: organization ? asOptionalText(organization.waitingFor) : null,
      promised_to: organization ? asOptionalText(organization.promisedTo) : null,
      at_risk: organization && asBool(organization.atRisk) ? 1 : 0,
      // Причина живёт только вместе со статусом «Снято».
      removal_reason: status === 'removed' ? asOptionalText(organization?.removalReason) : null,
      details: organization ? asOptionalText(organization.details) : null,
      steps_json: stepsJson,
      completed_at: asInstant(plan.completedAt),
      entry_id: asId(plan.entryID),
      created_at: createdAt,
      updated_at: updatedAt,
    });

    const action = decide(storedAt(store.taskRowById(id), 'updated_at'), updatedAt, mode);
    if (action === 'added') store.upsertTaskValues(values, 'insert');
    else if (action === 'updated') store.upsertTaskValues(values, 'update');
    bump('tasks', action);
  }
}

function importEntries(
  store: Store,
  document: MacDocument,
  mode: ImportMode,
  now: number,
  warnings: string[],
  bump: Bump,
): void {
  for (const entry of document.entries) {
    const id = asId(entry.id);
    if (!id) {
      warnings.push('Пропущена запись дневника без корректного идентификатора.');
      continue;
    }
    const createdAt = asInstant(entry.createdAt) ?? now;
    const updatedAt = asInstant(entry.updatedAt) ?? createdAt;
    const timestamp = asInstant(entry.timestamp) ?? createdAt;
    let planId = asId(entry.planID);
    if (planId !== null && store.taskRowById(planId) === undefined) {
      warnings.push(`Запись дневника ${id} ссылается на несуществующую задачу, связь снята.`);
      planId = null;
    }
    const text = asText(entry.text) || 'Без текста';
    const context = asOptionalText(entry.context);
    const action = decide(storedAt(store.entryRowById(id), 'updated_at'), updatedAt, mode);
    if (action === 'added') {
      store.insertEntryRaw({ id, text, context, timestamp, plan_id: planId, created_at: createdAt, updated_at: updatedAt });
    } else if (action === 'updated') {
      store.updateEntryRaw(id, { text, context, timestamp, plan_id: planId, updated_at: updatedAt });
    }
    bump('entries', action);
  }
}

function importChaos(
  store: Store,
  document: MacDocument,
  mode: ImportMode,
  now: number,
  warnings: string[],
  bump: Bump,
): void {
  for (const item of document.chaos) {
    const id = asId(item.id);
    if (!id) {
      warnings.push('Пропущена строка места хаоса без корректного идентификатора.');
      continue;
    }
    const createdAt = asInstant(item.createdAt) ?? now;
    const text = asText(item.text) || 'Без текста';
    const urgent = asBool(item.urgent);
    const action = decide(storedAt(store.chaosRowById(id), 'created_at'), createdAt, mode);
    if (action === 'added') store.insertChaosRaw(id, text, urgent, createdAt);
    else if (action === 'updated') store.updateChaosRaw(id, text, urgent);
    bump('chaos', action);
  }
}

/* ------------------------------------------------------------------ */
/* Экспорт JSON: формат Mac, чтобы файл читался клиентом               */
/* ------------------------------------------------------------------ */

/** Swift ISO8601DateFormatter не понимает доли секунды, поэтому они не пишутся. */
function macIso(iso: string | null): string | null {
  return iso === null ? null : iso.replace(/\.\d{3}Z$/, 'Z');
}

function upper(id: string): string {
  return id.toUpperCase();
}

function needsReviewFields(plans: Json[]): boolean {
  const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  return plans.some((plan) => {
    const organization = asObject(plan.organization);
    if (!organization) return false;
    return (
      asBool(organization.atRisk) ||
      organization.status === 'removed' ||
      filled(organization.promisedTo) ||
      filled(organization.removalReason)
    );
  });
}

export function computeMacVersion(
  entries: Json[],
  plans: Json[],
  notes: Json[],
  projects: Json[],
  chaos: Json[],
  noteFolders: Json[],
): number {
  const needsV2 = plans.length > 0 || entries.some((entry) => asId(entry.planID) !== null);
  const needsV3 = notes.length > 0;
  const needsV4 =
    projects.length > 0 ||
    plans.some((plan) => asObject(plan.organization) !== null || asStoredDayKey(plan.day) === '');
  const base = plans.some((plan) => Array.isArray(plan.steps))
    ? 5
    : needsV4
      ? 4
      : needsV3
        ? 3
        : needsV2
          ? 2
          : 1;
  if (noteFolders.some((folder) => asId(folder.parentID) !== null)) return 9;
  if (noteFolders.length > 0) return 8;
  if (needsReviewFields(plans)) return 7;
  return chaos.length === 0 ? base : 6;
}

/** Календарный день уходит в файл как полдень UTC, чтобы не зависеть от пояса. */
function dayKeyToUtcIso(day: DayKey): string {
  return `${day}T12:00:00Z`;
}

export function exportJson(store: Store): string {
  const state = store.getState();

  const entries = state.entries.map((entry) => ({
    id: upper(entry.id),
    text: entry.text,
    ...(entry.context === null ? {} : { context: entry.context }),
    timestamp: macIso(entry.timestamp),
    createdAt: macIso(entry.created_at),
    updatedAt: macIso(entry.updated_at),
    ...(entry.plan_id === null ? {} : { planID: upper(entry.plan_id) }),
  }));

  const plans = state.tasks.map((task) => {
    const organization: Json = { area: task.area, status: task.status };
    if (task.project_id !== null) organization.projectID = upper(task.project_id);
    if (task.waiting_for !== null) organization.waitingFor = task.waiting_for;
    if (task.promised_to !== null) organization.promisedTo = task.promised_to;
    if (task.at_risk) organization.atRisk = true;
    if (task.removal_reason !== null) organization.removalReason = task.removal_reason;
    if (task.review_date !== null) organization.reviewDate = dayKeyToUtcIso(task.review_date);
    if (task.deadline !== null) organization.deadline = dayKeyToUtcIso(task.deadline);
    if (task.details !== null) organization.details = task.details;

    const plan: Json = {
      id: upper(task.id),
      text: task.text,
      day: task.day,
      createdAt: macIso(task.created_at),
      updatedAt: macIso(task.updated_at),
    };
    if (task.completed_at !== null) plan.completedAt = macIso(task.completed_at);
    if (task.entry_id !== null) plan.entryID = upper(task.entry_id);
    // Блок organization пишется только когда несёт сведения сверх умолчаний,
    // иначе файл без нужды поднял бы версию до v4.
    if (Object.keys(organization).length > 2) plan.organization = organization;
    if (task.steps.length > 0) {
      plan.steps = task.steps.map((step) => {
        const item: Json = { id: upper(step.id), text: step.text };
        if (step.completed_at !== null) item.completedAt = macIso(step.completed_at);
        return item;
      });
    }
    return plan;
  });

  const projects = state.projects.map((project) => {
    const item: Json = {
      id: upper(project.id),
      title: project.title,
      outcome: project.outcome,
      area: project.area,
      uncertainty: project.uncertainty,
      archived: project.archived,
      createdAt: macIso(project.created_at),
      updatedAt: macIso(project.updated_at),
    };
    if (project.review_date !== null) item.reviewDate = dayKeyToUtcIso(project.review_date);
    if (project.next_action_id !== null) item.nextActionID = upper(project.next_action_id);
    return item;
  });

  const chaos = state.chaos.map((item) => ({
    id: upper(item.id),
    text: item.text,
    createdAt: macIso(item.created_at),
    urgent: item.urgent,
  }));

  const noteFolders = state.note_folders.map((folder) => {
    const item: Json = { id: upper(folder.id), name: folder.name };
    if (folder.parent_id !== null) item.parentID = upper(folder.parent_id);
    return item;
  });

  const notes = state.notes.map((note) => {
    const item: Json = {
      id: upper(note.id),
      title: note.title,
      body: note.body,
      createdAt: macIso(note.created_at),
      updatedAt: macIso(note.updated_at),
      pinned: note.pinned,
    };
    if (note.folder_id !== null) item.folderID = upper(note.folder_id);
    return item;
  });

  const version = computeMacVersion(
    entries as unknown as Json[],
    plans as Json[],
    notes as Json[],
    projects as Json[],
    chaos as unknown as Json[],
    noteFolders as Json[],
  );

  const document: Json = {
    format: MAC_FORMAT,
    version,
    exportedAt: macIso(state.now),
    entries,
  };
  if (plans.length > 0) document.plans = plans;
  if (notes.length > 0) document.notes = notes;
  if (projects.length > 0) document.projects = projects;
  if (chaos.length > 0) document.chaos = chaos;
  if (noteFolders.length > 0) document.noteFolders = noteFolders;

  return `${JSON.stringify(document, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* Экспорт Markdown                                                    */
/* ------------------------------------------------------------------ */

/** Одна заметка не должна ломать документ: экранируем заголовки и закрываем ограды кода. */
export function escapeMarkdownBody(body: string): string {
  let fences = 0;
  const result = body.split('\n').map((line) => {
    let out = line;
    if (line.replace(/^ +/, '').startsWith('#')) {
      const index = out.indexOf('#');
      if (index >= 0) out = `${out.slice(0, index)}\\${out.slice(index)}`;
    }
    if (line.trim().startsWith('```')) fences += 1;
    return out;
  });
  let text = result.join('\n');
  if (fences % 2 !== 0) text += '\n```';
  return text;
}

function quote(text: string | null | undefined): string {
  const value = (text ?? '').trim();
  return value === '' ? '—' : value.replace(/\s+/g, ' ');
}

function shortTime(iso: string): string {
  return iso.slice(11, 16);
}

function areaTitle(area: Area): string {
  return area === 'work' ? 'Работа' : 'Личное';
}

export function exportMarkdown(store: Store): string {
  const state = store.getState();
  const lines: string[] = [];

  lines.push('# Хаос Дня — экспорт', '');
  lines.push(`Дата выгрузки: ${state.today}`);
  lines.push(`Часовой пояс: ${state.timezone}`);
  lines.push(
    `Записей дневника: ${state.entries.length}; задач: ${state.tasks.length}; проектов: ${state.projects.length}; заметок: ${state.notes.length}; строк места хаоса: ${state.chaos.length}.`,
    '',
  );

  lines.push('## Место хаоса', '');
  if (state.chaos.length === 0) lines.push('Сейчас здесь ничего нет.');
  else for (const item of state.chaos) lines.push(`- ${item.urgent ? '**Не может ждать.** ' : ''}${quote(item.text)}`);
  lines.push('');

  lines.push('## Проекты', '');
  if (state.projects.length === 0) {
    lines.push('Сейчас здесь ничего нет.');
  } else {
    for (const project of state.projects) {
      const next = state.tasks.find((task) => task.id === project.next_action_id);
      lines.push(`### ${quote(project.title)}`, '');
      lines.push(`- Результат: ${quote(project.outcome)}`);
      lines.push(`- Сфера: ${areaTitle(project.area)}`);
      if (project.uncertainty !== '') lines.push(`- Что нужно выяснить: ${quote(project.uncertainty)}`);
      if (project.review_date) lines.push(`- Дата пересмотра: ${project.review_date}`);
      lines.push(`- Следующий шаг: ${next ? quote(next.text) : '—'}`);
      if (project.archived) lines.push('- В архиве');
      lines.push('');
    }
  }

  lines.push('## Задачи', '');
  if (state.tasks.length === 0) {
    lines.push('Сейчас здесь ничего нет.');
  } else {
    for (const task of state.tasks) {
      const marks = [TASK_STATUS_TITLES[task.status]];
      if (task.is_completed) marks.push('выполнена');
      if (task.at_risk) marks.push('обещание под угрозой');
      const project = state.projects.find((item) => item.id === task.project_id);
      lines.push(`### ${quote(task.text)}`, '');
      lines.push(`- Статус: ${marks.join(', ')}`);
      lines.push(`- Сфера: ${areaTitle(task.area)}`);
      if (task.day !== '') lines.push(`- День работы: ${task.day}`);
      if (task.deadline) lines.push(`- Срок результата: ${task.deadline}`);
      if (task.review_date) lines.push(`- Дата пересмотра: ${task.review_date}`);
      if (task.promised_to) lines.push(`- Кому обещано: ${quote(task.promised_to)}`);
      if (task.waiting_for) lines.push(`- Кого или чего ждать: ${quote(task.waiting_for)}`);
      if (task.details) lines.push(`- Подробности: ${quote(task.details)}`);
      if (task.removal_reason) lines.push(`- Причина снятия: ${quote(task.removal_reason)}`);
      if (task.completed_at) lines.push(`- Выполнена: ${task.completed_at.slice(0, 10)} ${shortTime(task.completed_at)}`);
      if (project) lines.push(`- Проект: ${quote(project.title)}`);
      if (task.steps.length > 0) {
        lines.push('- Шаги:');
        for (const step of task.steps) {
          lines.push(`  - ${step.completed_at === null ? '[ ]' : '[x]'} ${quote(step.text)}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Дни', '');
  if (state.entries.length === 0) {
    lines.push('Сейчас здесь ничего нет.');
  } else {
    const byDay = new Map<DayKey, typeof state.entries>();
    for (const entry of state.entries) {
      const list = byDay.get(entry.day) ?? [];
      list.push(entry);
      byDay.set(entry.day, list);
    }
    for (const day of [...byDay.keys()].sort()) {
      lines.push(`### ${day}`, '');
      for (const entry of byDay.get(day) ?? []) {
        lines.push(`- ${shortTime(entry.timestamp)} ${quote(entry.text)}`);
        if (entry.context) lines.push(`  - На чём остановился: ${quote(entry.context)}`);
      }
      lines.push('');
    }
  }

  lines.push('## Заметки', '');
  if (state.notes.length === 0) {
    lines.push('Сейчас здесь ничего нет.');
  } else {
    const folderName = new Map(state.note_folders.map((folder) => [folder.id, folder.name]));
    for (const note of state.notes) {
      const folder = note.folder_id ? folderName.get(note.folder_id) ?? 'Без папки' : 'Без папки';
      lines.push(`### ${quote(note.title)}`, '');
      lines.push(`Папка: ${folder}${note.pinned ? ' · закреплена' : ''}`, '');
      if (note.body.trim() !== '') lines.push(escapeMarkdownBody(note.body), '');
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function exportFileName(prefix: string, today: DayKey, extension: string): string {
  return `${prefix}-${today}.${extension}`;
}
