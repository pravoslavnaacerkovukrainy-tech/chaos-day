import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  COOKIE_NAME,
  assertPasswordShape,
  createSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from './auth.ts';
import {
  dayKeyFromDate,
  isoOf,
  isValidTimeZone,
  optionalDayKey,
  parseIso,
  requireIso,
  todayKey,
  workDayKey,
} from './dates.ts';
import { ApiError, MESSAGES, fail } from './errors.ts';
import { isOpen, reviewGroups, searchOrganizer, sortPlans, tasksForDay, visibleTasks } from './review.ts';
import {
  AREAS,
  SELECTABLE_TASK_STATUSES,
  TASK_STATUSES,
} from './types.ts';
import type {
  Area,
  ChaosItem,
  DiaryEntry,
  DayKey,
  ImportCounts,
  Iso,
  Note,
  NoteFolder,
  Project,
  ReviewGroup,
  Snapshot,
  Task,
  TaskStatus,
  TaskStep,
  UUID,
} from './types.ts';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 4000;
const MAX_STEP_TEXT = 500;
const MAX_STEPS = 100;

export const DEFAULT_TIMEZONE = 'Europe/Kyiv';

/* ------------------------------------------------------------------ */
/* Разбор строк SQLite                                                 */
/* ------------------------------------------------------------------ */

export function str(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

export function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

export function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

export function num(row: Row, key: string): number {
  const value = row[key];
  return value === null || value === undefined ? 0 : Number(value);
}

export function bool(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

/* ------------------------------------------------------------------ */
/* Проверка входящих значений                                          */
/* ------------------------------------------------------------------ */

export function cleanText(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', MESSAGES.emptyText(what));
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ApiError(400, 'empty_text', MESSAGES.emptyText(what));
  }
  return trimmed;
}

/** Пустая строка хранится как отсутствие поля — как в Mac-версии. */
function optionalText(value: unknown, what: string, max = MAX_TEXT): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', `${what}: ожидается строка.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    throw new ApiError(400, 'invalid_request', `${what}: не длиннее ${max} знаков.`);
  }
  return trimmed;
}

function toArea(value: unknown, fallback: Area): Area {
  if (value === null || value === undefined) return fallback;
  if ((AREAS as readonly string[]).includes(String(value))) return String(value) as Area;
  return fail(
    400,
    'invalid_request',
    `Сфера «${String(value)}» не подходит. Нужны «Работа» или «Личное».`,
  );
}

function toStatus(value: unknown, fallback: TaskStatus): TaskStatus {
  if (value === null || value === undefined) return fallback;
  const raw = String(value);
  if (!(TASK_STATUSES as readonly string[]).includes(raw)) {
    return fail(400, 'invalid_request', `Статус «${raw}» не подходит.`);
  }
  if (raw === 'removed') {
    return fail(
      400,
      'invalid_request',
      'Статус «Снято» задаётся только командой «Снять…» с причиной.',
    );
  }
  if (!(SELECTABLE_TASK_STATUSES as readonly string[]).includes(raw)) {
    return fail(400, 'invalid_request', `Статус «${raw}» недоступен для выбора.`);
  }
  return raw as TaskStatus;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  return fail(400, 'invalid_request', 'Ожидалось логическое значение.');
}

/** UUID приводятся к нижнему регистру: файл Mac пишет их в верхнем. */
export function normalizeId(value: unknown, what = 'Идентификатор'): string | null {
  if (value === null || value === undefined || value === '' || value === 'none') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return fail(400, 'invalid_request', `${what} «${String(value)}» не подходит.`);
  }
  return value.toLowerCase();
}

function requireId(value: unknown, what = 'Идентификатор'): string {
  const id = normalizeId(value, what);
  if (id === null) return fail(400, 'invalid_request', `${what} не задан.`);
  return id;
}

function parseSteps(json: string | null): TaskStep[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const steps: TaskStep[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    steps.push({
      id: typeof raw.id === 'string' ? raw.id.toLowerCase() : randomUUID(),
      text: typeof raw.text === 'string' ? raw.text : '',
      completed_at: typeof raw.completed_at === 'string' ? raw.completed_at : null,
    });
  }
  return steps;
}

function foldText(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function checkSteps(input: unknown): TaskStep[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, 'invalid_steps', MESSAGES.invalidSteps);
  }
  if (input.length > MAX_STEPS) {
    throw new ApiError(400, 'invalid_steps', MESSAGES.invalidSteps);
  }
  const ids = new Set<string>();
  const texts = new Set<string>();
  const steps: TaskStep[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) {
      throw new ApiError(400, 'invalid_steps', MESSAGES.invalidSteps);
    }
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '' || text.length > MAX_STEP_TEXT) {
      throw new ApiError(400, 'invalid_steps', MESSAGES.invalidSteps);
    }
    const id = typeof item.id === 'string' && item.id !== '' ? item.id.toLowerCase() : randomUUID();
    const completedAt =
      item.completed_at === null || item.completed_at === undefined || item.completed_at === ''
        ? null
        : isoOf(parseIso(item.completed_at, 'Время выполнения шага'));
    if (ids.has(id) || texts.has(foldText(text))) {
      throw new ApiError(400, 'invalid_steps', MESSAGES.invalidSteps);
    }
    ids.add(id);
    texts.add(foldText(text));
    steps.push({ id, text, completed_at: completedAt });
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* Синхронизация отдельных полей                                        */
/* ------------------------------------------------------------------ */

/** Поля задачи, которые клиент синхронизирует по отдельности. */
export const SYNC_TASK_FIELDS = ['day', 'text', 'details'] as const;

export type SyncTaskField = (typeof SYNC_TASK_FIELDS)[number];

/** Значения полей в том виде, в каком они хранятся: день работы — текст, пустой при отсутствии дня. */
export type SyncTaskValues = Record<SyncTaskField, string | null>;

export interface SyncTaskResult {
  task: Task;
  /** Поля, где значение сервера не совпало ни с базой клиента, ни с его правкой. */
  conflicts: SyncTaskField[];
}

function checkSyncPatch(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_request', `${what}: ожидался объект полей задачи.`);
  }
  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new ApiError(
      400,
      'invalid_request',
      `${what}: нужно хотя бы одно поле (${SYNC_TASK_FIELDS.join(', ')}).`,
    );
  }
  for (const key of keys) {
    if (!(SYNC_TASK_FIELDS as readonly string[]).includes(key)) {
      throw new ApiError(400, 'invalid_request', `${what}: поле «${key}» не синхронизируется.`);
    }
  }
  return patch;
}

/**
 * База и правка описывают один и тот же набор полей. Иначе клиент подтверждал бы
 * изменение, о котором ничего не знает, и молча затирал чужую правку.
 */
function syncFields(
  base: Record<string, unknown>,
  changes: Record<string, unknown>,
): SyncTaskField[] {
  const fields = SYNC_TASK_FIELDS.filter((field) => field in base);
  const sameSet =
    fields.length === Object.keys(changes).length && fields.every((field) => field in changes);
  if (!sameSet) {
    throw new ApiError(
      400,
      'invalid_request',
      'base и changes должны содержать одинаковый непустой набор полей.',
    );
  }
  return fields;
}

function normalizeSyncValues(
  patch: Record<string, unknown>,
  fields: readonly SyncTaskField[],
  what: string,
): SyncTaskValues {
  const values: SyncTaskValues = { day: null, text: null, details: null };
  for (const field of fields) {
    const raw = patch[field];
    if (field === 'day') values.day = workDayKey(raw, `День работы (${what})`);
    else if (field === 'text') values.text = cleanText(raw, `Текст задачи (${what})`);
    else values.details = optionalText(raw, `Подробности (${what})`);
  }
  return values;
}

function syncValueOf(task: Task, field: SyncTaskField): string | null {
  if (field === 'day') return task.day;
  if (field === 'text') return task.text;
  return task.details;
}

/* ------------------------------------------------------------------ */
/* Внутреннее представление задачи                                     */
/* ------------------------------------------------------------------ */

interface TaskValues {
  id: string;
  text: string;
  day: string;
  deadline: string | null;
  review_date: string | null;
  area: Area;
  project_id: string | null;
  status: TaskStatus;
  waiting_for: string | null;
  promised_to: string | null;
  at_risk: number;
  removal_reason: string | null;
  details: string | null;
  steps_json: string;
  completed_at: number | null;
  entry_id: string | null;
  created_at: number;
  updated_at: number;
}

const TASK_SQL_COLUMNS = `id, text, day, deadline, review_date, area, project_id, status,
  waiting_for, promised_to, at_risk, removal_reason, details, steps_json,
  completed_at, entry_id, created_at, updated_at`;

function taskValuesToParams(v: TaskValues): SqlValue[] {
  return [
    v.id, v.text, v.day, v.deadline, v.review_date, v.area, v.project_id, v.status,
    v.waiting_for, v.promised_to, v.at_risk, v.removal_reason, v.details, v.steps_json,
    v.completed_at, v.entry_id, v.created_at, v.updated_at,
  ];
}

const TASK_PLACEHOLDERS = Array(18).fill('?').join(', ');
const TASK_UPDATE_SET = TASK_SQL_COLUMNS.split(',')
  .map((column) => `${column.trim()} = ?`)
  .filter((clause) => !clause.startsWith('id ='))
  .join(', ');

/** Счётчик версий пишет триггер, поэтому в INSERT и UPDATE он не входит. */
const TASK_SELECT_COLUMNS = `${TASK_SQL_COLUMNS}, revision`;

export interface TaskDraft {
  text?: unknown;
  day?: unknown;
  deadline?: unknown;
  review_date?: unknown;
  area?: unknown;
  project_id?: unknown;
  status?: unknown;
  waiting_for?: unknown;
  promised_to?: unknown;
  at_risk?: unknown;
  details?: unknown;
}

/** Основание для оптимистичной блокировки: счётчик версий или отметка времени задачи. */
export interface StepsBase {
  revision?: unknown;
  updated_at?: unknown;
}

function normalizeStepsBase(base: StepsBase | string | null | undefined): StepsBase | undefined {
  if (base === undefined || base === null) return undefined;
  if (typeof base === 'string') return { updated_at: base };
  return base;
}

/** Основание для оптимистичной блокировки обычной правки задачи. */
export interface TaskBase {
  /** Счётчик правок из `Task.revision`, который клиент получил, открывая редактор. */
  revision?: unknown;
}

/**
 * Отсутствие, `null` и пустая строка означают «условия нет»: правка проходит прежним
 * порядком, поэтому старые вызывающие ничего не присылают и не ломаются.
 */
function optionalRevision(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiError(400, 'invalid_request', 'base_revision: ожидается целое неотрицательное число.');
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Хранилище                                                           */
/* ------------------------------------------------------------------ */

export interface StoreOptions {
  /** Часовой пояс при первом запуске; дальше живёт в базе. */
  timeZone?: string;
  sessionTtlSec?: number;
  now?: () => Date;
}

export interface SessionInfo {
  tokenHash: string;
  expiresAt: number;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly nowFn: () => Date;
  private faultSaves = 0;
  sessionTtlSec: number;

  constructor(db: DatabaseSync, options: StoreOptions = {}) {
    this.db = db;
    this.nowFn = options.now ?? (() => new Date());
    this.sessionTtlSec = options.sessionTtlSec ?? 12 * 60 * 60;
    this.initMeta(options.timeZone ?? DEFAULT_TIMEZONE);
  }

  /* ---------------- служебное ---------------- */

  private initMeta(defaultTimeZone: string): void {
    const zone = isValidTimeZone(defaultTimeZone) ? defaultTimeZone : DEFAULT_TIMEZONE;
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run('timezone', zone);
  }

  /** Время с точностью до секунды — как в JSON Mac-версии. */
  private nowMs(): number {
    return Math.floor(this.nowFn().getTime() / 1000) * 1000;
  }

  now(): Date {
    return new Date(this.nowMs());
  }

  /** Управляемая ошибка сохранения для приёмки: срабатывает внутри транзакции. */
  armFault(kind: 'save', times: number): void {
    if (kind === 'save') this.faultSaves = Math.max(0, Math.floor(times));
  }

  private guardSave(): void {
    if (this.faultSaves > 0) {
      this.faultSaves -= 1;
      throw new ApiError(500, 'save_failed', MESSAGES.saveFailed);
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.guardSave();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* транзакция уже завершена */
      }
      throw error;
    }
  }

  /** Одна транзакция для составных операций — импорт и смена часового пояса. */
  transaction<T>(fn: () => T): T {
    return this.tx(fn);
  }

  private all(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private one(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SqlValue[]): number {
    const info = this.db.prepare(sql).run(...params) as { changes: number | bigint };
    return Number(info.changes);
  }

  /* ---------------- мета и часовой пояс ---------------- */

  getMeta(key: string): string | null {
    return strOrNull(this.one('SELECT value FROM meta WHERE key = ?', key) ?? {}, 'value');
  }

  setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  get timeZone(): string {
    return this.getMeta('timezone') ?? DEFAULT_TIMEZONE;
  }

  /**
   * Смена часового пояса пересчитывает ключи дней у записей дневника,
   * чтобы факт не переехал на соседний день.
   */
  setTimeZone(timeZone: string): { timezone: string; today: DayKey } {
    if (!isValidTimeZone(timeZone)) {
      throw new ApiError(400, 'invalid_timezone', MESSAGES.invalidTimezone(timeZone));
    }
    return this.tx(() => {
      this.setMeta('timezone', timeZone);
      const rows = this.all('SELECT id, timestamp FROM entries');
      const update = this.db.prepare('UPDATE entries SET day = ? WHERE id = ?');
      for (const row of rows) {
        const day = dayKeyFromDate(new Date(num(row, 'timestamp')), timeZone);
        update.run(day, str(row, 'id'));
      }
      return { timezone: timeZone, today: todayKey(timeZone, this.now()) };
    });
  }

  today(): DayKey {
    return todayKey(this.timeZone, this.now());
  }

  /** Полный сброс для изолированной приёмки. */
  resetAll(): void {
    this.tx(() => {
      for (const table of ['entries', 'notes', 'tasks', 'chaos', 'projects', 'note_folders', 'sessions', 'auth']) {
        this.db.exec(`DELETE FROM ${table}`);
      }
      this.faultSaves = 0;
    });
  }

  /* ---------------- вход и сессии ---------------- */

  setupRequired(): boolean {
    return this.one('SELECT id FROM auth WHERE id = 1') === undefined;
  }

  setupPassword(password: unknown): void {
    const value = assertPasswordShape(password);
    if (!this.setupRequired()) {
      throw new ApiError(403, 'setup_already_done', MESSAGES.setupAlreadyDone);
    }
    const now = this.nowMs();
    this.tx(() => {
      this.run(
        'INSERT INTO auth (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)',
        hashPassword(value),
        now,
        now,
      );
    });
  }

  changePassword(currentPassword: unknown, nextPassword: unknown): void {
    const row = this.one('SELECT password_hash FROM auth WHERE id = 1');
    if (!row) throw new ApiError(403, 'setup_required', 'Пароль ещё не задан.');
    if (!verifyPassword(String(currentPassword ?? ''), str(row, 'password_hash'))) {
      throw new ApiError(401, 'unauthorized', MESSAGES.wrongPassword);
    }
    const value = assertPasswordShape(nextPassword);
    this.tx(() => {
      this.run('UPDATE auth SET password_hash = ?, updated_at = ? WHERE id = 1', hashPassword(value), this.nowMs());
      this.db.exec('DELETE FROM sessions');
    });
  }

  checkPassword(password: unknown): boolean {
    const row = this.one('SELECT password_hash FROM auth WHERE id = 1');
    if (!row) return false;
    if (typeof password !== 'string') return false;
    return verifyPassword(password, str(row, 'password_hash'));
  }

  passwordHash(): string | null {
    return strOrNull(this.one('SELECT password_hash FROM auth WHERE id = 1') ?? {}, 'password_hash');
  }

  createSession(): { token: string; expiresAt: number } {
    const now = this.nowMs();
    const expiresAt = now + this.sessionTtlSec * 1000;
    const { token, tokenHash } = createSessionToken();
    this.run(
      'INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
      tokenHash,
      now,
      expiresAt,
    );
    this.pruneSessions(now);
    return { token, expiresAt };
  }

  /** Живая сессия продлевается; истёкшая или отозванная — нет. */
  touchSession(token: string | undefined): SessionInfo | null {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const row = this.one(
      'SELECT token_hash, expires_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL',
      tokenHash,
    );
    if (!row) return null;
    const now = this.nowMs();
    const expiresAt = num(row, 'expires_at');
    if (expiresAt <= now) {
      this.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      return null;
    }
    const extended = now + this.sessionTtlSec * 1000;
    this.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', extended, tokenHash);
    return { tokenHash, expiresAt: extended };
  }

  revokeSession(token: string | undefined): void {
    if (!token) return;
    this.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', this.nowMs(), hashToken(token));
  }

  private pruneSessions(now: number): void {
    this.run('DELETE FROM sessions WHERE expires_at <= ?', now);
  }

  /* ---------------- отображение строк ---------------- */

  private mapTask(row: Row): Task {
    const steps = parseSteps(str(row, 'steps_json'));
    const completedAt = numOrNull(row, 'completed_at');
    const status = str(row, 'status') as TaskStatus;
    return {
      id: str(row, 'id'),
      text: str(row, 'text'),
      day: str(row, 'day'),
      deadline: strOrNull(row, 'deadline'),
      review_date: strOrNull(row, 'review_date'),
      area: str(row, 'area') as Area,
      project_id: strOrNull(row, 'project_id'),
      status,
      waiting_for: strOrNull(row, 'waiting_for'),
      promised_to: strOrNull(row, 'promised_to'),
      at_risk: bool(row, 'at_risk'),
      removal_reason: strOrNull(row, 'removal_reason'),
      details: strOrNull(row, 'details'),
      steps,
      completed_at: isoOf(completedAt),
      entry_id: strOrNull(row, 'entry_id'),
      created_at: requireIso(numOrNull(row, 'created_at'), 'created_at'),
      updated_at: requireIso(numOrNull(row, 'updated_at'), 'updated_at'),
      revision: num(row, 'revision'),
      is_completed: completedAt !== null,
      is_removed: status === 'removed',
      is_open: completedAt === null && status !== 'removed',
      next_step: steps.find((step) => step.completed_at === null) ?? null,
    };
  }

  private mapProject(row: Row): Project {
    return {
      id: str(row, 'id'),
      title: str(row, 'title'),
      outcome: str(row, 'outcome'),
      area: str(row, 'area') as Area,
      uncertainty: str(row, 'uncertainty'),
      review_date: strOrNull(row, 'review_date'),
      next_action_id: strOrNull(row, 'next_action_id'),
      archived: bool(row, 'archived'),
      created_at: requireIso(numOrNull(row, 'created_at'), 'created_at'),
      updated_at: requireIso(numOrNull(row, 'updated_at'), 'updated_at'),
    };
  }

  private mapChaos(row: Row): ChaosItem {
    return {
      id: str(row, 'id'),
      text: str(row, 'text'),
      urgent: bool(row, 'urgent'),
      created_at: requireIso(numOrNull(row, 'created_at'), 'created_at'),
    };
  }

  private mapEntry(row: Row): DiaryEntry {
    return {
      id: str(row, 'id'),
      text: str(row, 'text'),
      context: strOrNull(row, 'context'),
      timestamp: requireIso(numOrNull(row, 'timestamp'), 'timestamp'),
      day: str(row, 'day'),
      plan_id: strOrNull(row, 'plan_id'),
      created_at: requireIso(numOrNull(row, 'created_at'), 'created_at'),
      updated_at: requireIso(numOrNull(row, 'updated_at'), 'updated_at'),
    };
  }

  private mapNote(row: Row): Note {
    return {
      id: str(row, 'id'),
      title: str(row, 'title'),
      body: str(row, 'body'),
      folder_id: strOrNull(row, 'folder_id'),
      pinned: bool(row, 'pinned'),
      created_at: requireIso(numOrNull(row, 'created_at'), 'created_at'),
      updated_at: requireIso(numOrNull(row, 'updated_at'), 'updated_at'),
    };
  }

  private mapFolder(row: Row): NoteFolder {
    return {
      id: str(row, 'id'),
      name: str(row, 'name'),
      parent_id: strOrNull(row, 'parent_id'),
    };
  }

  /* ---------------- задачи: чтение ---------------- */

  listTasks(): Task[] {
    return this.all(`SELECT ${TASK_SELECT_COLUMNS} FROM tasks`).map((row) => this.mapTask(row));
  }

  getTaskRow(id: string): Row | undefined {
    return this.one(`SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE id = ?`, id);
  }

  getTask(id: string): Task {
    const row = this.getTaskRow(id);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Задача'));
    return this.mapTask(row);
  }

  /* ---------------- задачи: запись ---------------- */

  private insertTaskValues(values: TaskValues): void {
    this.run(`INSERT INTO tasks (${TASK_SQL_COLUMNS}) VALUES (${TASK_PLACEHOLDERS})`, ...taskValuesToParams(values));
  }

  private updateTaskValues(values: TaskValues): void {
    const params = taskValuesToParams(values);
    params.shift();
    this.run(`UPDATE tasks SET ${TASK_UPDATE_SET} WHERE id = ?`, ...params, values.id);
  }

  /**
   * Общий разбор черновика задачи. Проект задаёт сферу: если задача в проекте,
   * её сфера принудительно равна сфере проекта, как в checkedOrganization() Mac-версии.
   */
  private resolveTaskFields(
    draft: TaskDraft,
    base: TaskValues,
    now: number,
  ): TaskValues {
    const text = draft.text === undefined ? base.text : cleanText(draft.text, 'Текст задачи');
    const projectId =
      draft.project_id === undefined ? base.project_id : normalizeId(draft.project_id, 'Проект');

    let area = draft.area === undefined ? base.area : toArea(draft.area, base.area);
    if (projectId !== null) {
      const project = this.one('SELECT area, archived FROM projects WHERE id = ?', projectId);
      if (!project || bool(project, 'archived')) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound('Проект'));
      }
      area = str(project, 'area') as Area;
    }

    const status = draft.status === undefined ? base.status : toStatus(draft.status, base.status);

    return {
      ...base,
      text,
      day: draft.day === undefined ? base.day : workDayKey(draft.day, 'День работы'),
      deadline:
        draft.deadline === undefined ? base.deadline : optionalDayKey(draft.deadline, 'Срок результата'),
      review_date:
        draft.review_date === undefined
          ? base.review_date
          : optionalDayKey(draft.review_date, 'Дата пересмотра'),
      area,
      project_id: projectId,
      status,
      waiting_for:
        draft.waiting_for === undefined ? base.waiting_for : optionalText(draft.waiting_for, 'Кого или чего ждать'),
      promised_to:
        draft.promised_to === undefined ? base.promised_to : optionalText(draft.promised_to, 'Кому обещано'),
      at_risk: draft.at_risk === undefined ? base.at_risk : toBool(draft.at_risk, base.at_risk === 1) ? 1 : 0,
      details: draft.details === undefined ? base.details : optionalText(draft.details, 'Подробности'),
      // Причина живёт только вместе со статусом «Снято», иначе она выглядела бы текущей.
      removal_reason: status === 'removed' ? base.removal_reason : null,
      updated_at: now,
    };
  }

  private emptyTaskValues(now: number): TaskValues {
    return {
      id: randomUUID(),
      text: '',
      day: '',
      deadline: null,
      review_date: null,
      area: 'personal',
      project_id: null,
      status: 'ready',
      waiting_for: null,
      promised_to: null,
      at_risk: 0,
      removal_reason: null,
      details: null,
      steps_json: '[]',
      completed_at: null,
      entry_id: null,
      created_at: now,
      updated_at: now,
    };
  }

  createTask(draft: TaskDraft): Task {
    return this.tx(() => {
      const now = this.nowMs();
      const values = this.resolveTaskFields(draft, this.emptyTaskValues(now), now);
      if (values.text === '') {
        throw new ApiError(400, 'empty_text', MESSAGES.emptyText('Текст задачи'));
      }
      this.insertTaskValues(values);
      return this.getTask(values.id);
    });
  }

  private mutableTaskRow(id: string): Row {
    const row = this.getTaskRow(id);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Задача'));
    if (numOrNull(row, 'completed_at') !== null) {
      throw new ApiError(409, 'task_is_completed', MESSAGES.taskIsCompleted);
    }
    if (str(row, 'status') === 'removed') {
      throw new ApiError(409, 'task_is_removed', MESSAGES.taskIsRemoved);
    }
    return row;
  }

  /**
   * Обычная правка задачи. С `base_revision` работает оптимистичная блокировка: счётчик
   * сравнивается с текущим в той же транзакции, что и UPDATE, поэтому открытый раньше
   * редактор не затирает чужую правку, а получает отказ и сохраняет свой черновик.
   * Без условия поведение прежнее.
   */
  updateTask(id: string, draft: TaskDraft, base?: TaskBase): Task {
    const taskId = requireId(id, 'Идентификатор задачи');
    const revision = optionalRevision(base?.revision);
    return this.tx(() => {
      const row = this.mutableTaskRow(taskId);
      if (revision !== null && revision !== num(row, 'revision')) {
        throw new ApiError(409, 'conflicting_changes', MESSAGES.conflictingTaskChanges);
      }
      const now = this.nowMs();
      const next = this.resolveTaskFields(draft, this.taskToValues(this.mapTask(row)), now);
      this.updateTaskValues(next);
      return this.getTask(taskId);
    });
  }

  /**
   * Синхронизация отдельных полей: правка проходит, только если сервер всё ещё держит
   * значение из базы клиента. Совпадение с правкой — подтверждение уже сохранённого повтора.
   * Всё читается и пишется в одной транзакции, поэтому при конфликте не меняется ни одно поле.
   */
  syncTask(id: string, base: unknown, changes: unknown): SyncTaskResult {
    const taskId = requireId(id, 'Идентификатор задачи');
    const fields = syncFields(checkSyncPatch(base, 'base'), checkSyncPatch(changes, 'changes'));
    const baseValues = normalizeSyncValues(base as Record<string, unknown>, fields, 'base');
    const changeValues = normalizeSyncValues(changes as Record<string, unknown>, fields, 'changes');

    return this.tx(() => {
      const current = this.mapTask(this.mutableTaskRow(taskId));
      const conflicts: SyncTaskField[] = [];
      const draft: TaskDraft = {};
      let changed = false;

      for (const field of fields) {
        const stored = syncValueOf(current, field);
        const wanted = changeValues[field];
        if (stored === baseValues[field]) {
          if (stored !== wanted) {
            draft[field] = wanted;
            changed = true;
          }
        } else if (stored !== wanted) {
          conflicts.push(field);
        }
      }

      if (conflicts.length > 0) return { task: current, conflicts };
      // Повтор без новых изменений в базу не пишется: счётчик версий не растёт.
      if (!changed) return { task: current, conflicts: [] };

      const next = this.resolveTaskFields(draft, this.taskToValues(current), this.nowMs());
      this.updateTaskValues(next);
      return { task: this.getTask(taskId), conflicts: [] };
    });
  }

  private taskToValues(task: Task): TaskValues {
    return {
      id: task.id,
      text: task.text,
      day: task.day,
      deadline: task.deadline,
      review_date: task.review_date,
      area: task.area,
      project_id: task.project_id,
      status: task.status,
      waiting_for: task.waiting_for,
      promised_to: task.promised_to,
      at_risk: task.at_risk ? 1 : 0,
      removal_reason: task.removal_reason,
      details: task.details,
      steps_json: JSON.stringify(task.steps),
      completed_at: task.completed_at === null ? null : new Date(task.completed_at).getTime(),
      entry_id: task.entry_id,
      created_at: new Date(task.created_at).getTime(),
      updated_at: new Date(task.updated_at).getTime(),
    };
  }

  /** «Перенести»: меняет только день работы, срок и дата пересмотра сохраняются. */
  rescheduleTask(id: string, day: unknown): Task {
    const taskId = requireId(id, 'Идентификатор задачи');
    return this.tx(() => {
      const row = this.mutableTaskRow(taskId);
      const next = workDayKey(day, 'День работы');
      if (next === str(row, 'day')) return this.mapTask(row);
      this.run('UPDATE tasks SET day = ?, updated_at = ? WHERE id = ?', next, this.nowMs(), taskId);
      return this.getTask(taskId);
    });
  }

  /**
   * Отметить выполненным: атомарно создаёт ровно одну запись дневника.
   * «Кому обещано» в запись не копируется.
   */
  completeTask(id: string): { task: Task; entry: DiaryEntry } {
    const taskId = requireId(id, 'Идентификатор задачи');
    return this.tx(() => {
      const row = this.getTaskRow(taskId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Задача'));
      if (numOrNull(row, 'completed_at') !== null) {
        throw new ApiError(409, 'task_already_completed', MESSAGES.taskAlreadyCompleted);
      }
      if (str(row, 'status') === 'removed') {
        throw new ApiError(409, 'task_is_removed', MESSAGES.taskIsRemoved);
      }
      const now = this.nowMs();
      const entryId = randomUUID();
      this.insertEntryValues({
        id: entryId,
        text: str(row, 'text'),
        context: null,
        timestamp: now,
        day: dayKeyFromDate(new Date(now), this.timeZone),
        plan_id: taskId,
        created_at: now,
        updated_at: now,
      });
      this.run(
        'UPDATE tasks SET completed_at = ?, entry_id = ?, updated_at = ? WHERE id = ?',
        now,
        entryId,
        now,
        taskId,
      );
      return { task: this.getTask(taskId), entry: this.getEntry(entryId) };
    });
  }

  /** «Вернуть в план»: неизменённая запись убирается, изменённая остаётся без связи. */
  reopenTask(id: string): { task: Task; outcome: 'removed_entry' | 'kept_entry' | 'no_entry'; entry: DiaryEntry | null } {
    const taskId = requireId(id, 'Идентификатор задачи');
    return this.tx(() => {
      const row = this.getTaskRow(taskId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Задача'));
      const completedAt = numOrNull(row, 'completed_at');
      if (completedAt === null) {
        throw new ApiError(409, 'task_not_completed', MESSAGES.taskNotCompleted);
      }
      const entryId = strOrNull(row, 'entry_id');
      const entryRow =
        (entryId ? this.one('SELECT * FROM entries WHERE id = ?', entryId) : undefined) ??
        this.one('SELECT * FROM entries WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1', taskId);

      const now = this.nowMs();
      let outcome: 'removed_entry' | 'kept_entry' | 'no_entry' = 'no_entry';
      let entry: DiaryEntry | null = null;

      if (entryRow) {
        entry = this.mapEntry(entryRow);
        const unchanged =
          strOrNull(entryRow, 'plan_id') === taskId &&
          str(entryRow, 'text') === str(row, 'text') &&
          strOrNull(entryRow, 'context') === null &&
          num(entryRow, 'timestamp') === completedAt &&
          num(entryRow, 'updated_at') === num(entryRow, 'created_at');
        if (unchanged) {
          this.run('DELETE FROM entries WHERE id = ?', str(entryRow, 'id'));
          outcome = 'removed_entry';
        } else {
          this.run('UPDATE entries SET plan_id = NULL WHERE id = ?', str(entryRow, 'id'));
          outcome = 'kept_entry';
          entry = this.getEntry(str(entryRow, 'id'));
        }
      }

      this.run(
        'UPDATE tasks SET completed_at = NULL, entry_id = NULL, updated_at = ? WHERE id = ?',
        now,
        taskId,
      );
      return { task: this.getTask(taskId), outcome, entry };
    });
  }

  /** «Снять…»: причина обязательна. Снятие не считается выполнением и не пишет дневник. */
  removeTask(id: string, reason: unknown): Task {
    const text = optionalText(reason, 'Причина снятия');
    if (text === null) {
      throw new ApiError(409, 'removal_reason_required', MESSAGES.removalReasonRequired);
    }
    const taskId = requireId(id, 'Идентификатор задачи');
    return this.tx(() => {
      const row = this.getTaskRow(taskId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Задача'));
      if (numOrNull(row, 'completed_at') !== null) {
        throw new ApiError(409, 'task_is_completed', MESSAGES.taskIsCompleted);
      }
      this.run(
        "UPDATE tasks SET status = 'removed', removal_reason = ?, updated_at = ? WHERE id = ?",
        text,
        this.nowMs(),
        taskId,
      );
      return this.getTask(taskId);
    });
  }

  /** «Вернуть в работу»: статус снова «Можно делать», прежняя причина стирается. */
  returnTaskToWork(id: string): Task {
    const taskId = requireId(id, 'Идентификатор задачи');
    return this.tx(() => {
      const row = this.getTaskRow(taskId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Задача'));
      if (str(row, 'status') !== 'removed') {
        throw new ApiError(409, 'task_is_not_removed', MESSAGES.taskIsNotRemoved);
      }
      this.run(
        "UPDATE tasks SET status = 'ready', removal_reason = NULL, updated_at = ? WHERE id = ?",
        this.nowMs(),
        taskId,
      );
      return this.getTask(taskId);
    });
  }

  /** Отметка «Обещание под угрозой»: статус, даты и порядок остальных дел не меняются. */
  setTaskAtRisk(id: string, atRisk: unknown): Task {
    const taskId = requireId(id, 'Идентификатор задачи');
    return this.tx(() => {
      const row = this.mutableTaskRow(taskId);
      const next = toBool(atRisk, bool(row, 'at_risk')) ? 1 : 0;
      this.run('UPDATE tasks SET at_risk = ?, updated_at = ? WHERE id = ?', next, this.nowMs(), taskId);
      return this.getTask(taskId);
    });
  }

  replaceTaskSteps(id: string, steps: unknown, base?: StepsBase | string | null): Task {
    const taskId = requireId(id, 'Идентификатор задачи');
    return this.tx(() => {
      const row = this.getTaskRow(taskId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Задача'));
      if (numOrNull(row, 'completed_at') !== null) {
        throw new ApiError(409, 'task_is_completed', MESSAGES.taskIsCompleted);
      }
      this.assertStepsBase(row, normalizeStepsBase(base));
      const checked = checkSteps(steps);
      this.run(
        'UPDATE tasks SET steps_json = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(checked),
        this.nowMs(),
        taskId,
      );
      return this.getTask(taskId);
    });
  }

  /**
   * Сохранённый список не затирается чужими правками. Счётчик версий надёжнее отметки
   * времени: две правки в пределах одной секунды он всё равно различает.
   */
  private assertStepsBase(row: Row, base?: StepsBase): void {
    const revision = base?.revision;
    if (revision !== undefined && revision !== null && revision !== '') {
      if (Number(revision) !== num(row, 'revision')) {
        throw new ApiError(409, 'conflicting_changes', MESSAGES.conflictingChanges);
      }
      return;
    }
    const updatedAt = base?.updated_at;
    if (updatedAt !== undefined && updatedAt !== null && updatedAt !== '') {
      const current = requireIso(numOrNull(row, 'updated_at'), 'updated_at');
      if (String(updatedAt) !== current) {
        throw new ApiError(409, 'conflicting_changes', MESSAGES.conflictingChanges);
      }
    }
  }

  /** Задачу с шагами нельзя удалить, пока шаги явно не удалены. Каскадного удаления нет. */
  deleteTask(id: string): UUID {
    const taskId = requireId(id, 'Идентификатор задачи');
    return this.tx(() => {
      const row = this.getTaskRow(taskId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Задача'));
      if (parseSteps(str(row, 'steps_json')).length > 0) {
        throw new ApiError(409, 'parent_has_steps', MESSAGES.parentHasSteps);
      }
      this.run('UPDATE projects SET next_action_id = NULL WHERE next_action_id = ?', taskId);
      this.run('DELETE FROM tasks WHERE id = ?', taskId);
      return taskId;
    });
  }

  /* ---------------- место хаоса ---------------- */

  /** Срочные выше, затем новые раньше, добор по id. */
  listChaos(): ChaosItem[] {
    return this.all('SELECT * FROM chaos ORDER BY urgent DESC, created_at DESC, id ASC').map((row) =>
      this.mapChaos(row),
    );
  }

  getChaos(id: string): ChaosItem {
    const row = this.one('SELECT * FROM chaos WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Строка места хаоса'));
    return this.mapChaos(row);
  }

  addChaos(text: unknown, urgent: unknown): ChaosItem {
    const value = cleanText(text, 'Строка места хаоса');
    return this.tx(() => {
      const item: ChaosItem = {
        id: randomUUID(),
        text: value,
        urgent: toBool(urgent, false),
        created_at: isoOf(this.nowMs()) as Iso,
      };
      this.run(
        'INSERT INTO chaos (id, text, urgent, created_at) VALUES (?, ?, ?, ?)',
        item.id,
        item.text,
        item.urgent ? 1 : 0,
        new Date(item.created_at).getTime(),
      );
      return item;
    });
  }

  updateChaos(id: string, patch: { text?: unknown; urgent?: unknown }): ChaosItem {
    const chaosId = requireId(id, 'Идентификатор строки');
    return this.tx(() => {
      const current = this.getChaos(chaosId);
      const text = patch.text === undefined ? current.text : cleanText(patch.text, 'Строка места хаоса');
      const urgent = patch.urgent === undefined ? current.urgent : toBool(patch.urgent, current.urgent);
      this.run('UPDATE chaos SET text = ?, urgent = ? WHERE id = ?', text, urgent ? 1 : 0, chaosId);
      return this.getChaos(chaosId);
    });
  }

  setChaosUrgent(id: string, urgent: unknown): ChaosItem {
    const chaosId = requireId(id, 'Идентификатор строки');
    return this.tx(() => {
      const current = this.getChaos(chaosId);
      const next = toBool(urgent, current.urgent);
      this.run('UPDATE chaos SET urgent = ? WHERE id = ?', next ? 1 : 0, chaosId);
      return this.getChaos(chaosId);
    });
  }

  /** Снятие строки мгновенное: без причины и без записи дневника. Это не снятие задачи. */
  deleteChaos(id: string): UUID {
    const chaosId = requireId(id, 'Идентификатор строки');
    return this.tx(() => {
      this.getChaos(chaosId);
      this.run('DELETE FROM chaos WHERE id = ?', chaosId);
      return chaosId;
    });
  }

  /**
   * Решение «Это задача». Строка уходит из корзины только вместе с успешно сохранённой
   * задачей, одной транзакцией: ошибка оставляет строку на месте с прежним id.
   * Срочная строка даёт отметку «Обещание под угрозой»; даты приложение не выдумывает.
   */
  chaosToTask(id: string, draft: TaskDraft): { task: Task; removed_chaos_id: UUID } {
    const chaosId = requireId(id, 'Идентификатор строки');
    return this.tx(() => {
      const item = this.getChaos(chaosId);
      const now = this.nowMs();
      const prepared: TaskDraft = { ...draft };
      if (prepared.text === undefined) prepared.text = item.text;
      const values = this.resolveTaskFields(prepared, this.emptyTaskValues(now), now);
      if (values.text === '') {
        throw new ApiError(400, 'empty_text', MESSAGES.emptyText('Текст задачи'));
      }
      if (item.urgent) values.at_risk = 1;
      this.insertTaskValues(values);
      this.run('DELETE FROM chaos WHERE id = ?', chaosId);
      return { task: this.getTask(values.id), removed_chaos_id: chaosId };
    });
  }

  /** Решение «Это заметка». Дневник не меняется. */
  chaosToNote(id: string, title?: unknown): { note: Note; removed_chaos_id: UUID } {
    const chaosId = requireId(id, 'Идентификатор строки');
    return this.tx(() => {
      const item = this.getChaos(chaosId);
      const firstLine = item.text.split('\n')[0] ?? item.text;
      const noteTitle = title === undefined || title === null || title === '' ? firstLine.trim() : cleanText(title, 'Заголовок заметки');
      const note = this.insertNote({ title: noteTitle, body: item.text, folder_id: null, pinned: false });
      this.run('DELETE FROM chaos WHERE id = ?', chaosId);
      return { note, removed_chaos_id: chaosId };
    });
  }

  /* ---------------- проекты ---------------- */

  listProjects(): Project[] {
    return this.all('SELECT * FROM projects').map((row) => this.mapProject(row));
  }

  getProjectRow(id: string): Row | undefined {
    return this.one('SELECT * FROM projects WHERE id = ?', id);
  }

  getProject(id: string): Project {
    const row = this.getProjectRow(id);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Проект'));
    return this.mapProject(row);
  }

  createProject(draft: {
    title?: unknown;
    outcome?: unknown;
    area?: unknown;
    uncertainty?: unknown;
    review_date?: unknown;
  }): Project {
    return this.tx(() => {
      const now = this.nowMs();
      const id = randomUUID();
      this.run(
        'INSERT INTO projects (id, title, outcome, area, uncertainty, review_date, next_action_id, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)',
        id,
        cleanText(draft.title, 'Название проекта'),
        cleanText(draft.outcome, 'Результат проекта'),
        toArea(draft.area, 'personal'),
        (typeof draft.uncertainty === 'string' ? draft.uncertainty : '').trim(),
        optionalDayKey(draft.review_date, 'Дата пересмотра проекта'),
        now,
        now,
      );
      return this.getProject(id);
    });
  }

  updateProject(
    id: string,
    draft: {
      title?: unknown;
      outcome?: unknown;
      area?: unknown;
      uncertainty?: unknown;
      review_date?: unknown;
    },
  ): Project {
    const projectId = requireId(id, 'Идентификатор проекта');
    return this.tx(() => {
      const current = this.getProject(projectId);
      const title = draft.title === undefined ? current.title : cleanText(draft.title, 'Название проекта');
      const outcome = draft.outcome === undefined ? current.outcome : cleanText(draft.outcome, 'Результат проекта');
      const area = draft.area === undefined ? current.area : toArea(draft.area, current.area);
      const uncertainty =
        draft.uncertainty === undefined ? current.uncertainty : (typeof draft.uncertainty === 'string' ? draft.uncertainty : '').trim();
      const reviewDate =
        draft.review_date === undefined ? current.review_date : optionalDayKey(draft.review_date, 'Дата пересмотра проекта');
      const now = this.nowMs();
      this.run(
        'UPDATE projects SET title = ?, outcome = ?, area = ?, uncertainty = ?, review_date = ?, updated_at = ? WHERE id = ?',
        title, outcome, area, uncertainty, reviewDate, now, projectId,
      );
      // Смена сферы проекта распространяется на его задачи.
      if (area !== current.area) {
        this.run('UPDATE tasks SET area = ?, updated_at = ? WHERE project_id = ?', area, now, projectId);
      }
      return this.getProject(projectId);
    });
  }

  setNextAction(id: string, taskId: unknown): Project {
    const projectId = requireId(id, 'Идентификатор проекта');
    return this.tx(() => {
      this.getProject(projectId);
      const next = normalizeId(taskId, 'Задача');
      if (next !== null) {
        const row = this.getTaskRow(next);
        const valid =
          row !== undefined &&
          strOrNull(row, 'project_id') === projectId &&
          numOrNull(row, 'completed_at') === null &&
          str(row, 'status') === 'ready';
        if (!valid) {
          throw new ApiError(409, 'invalid_next_action', MESSAGES.invalidNextAction);
        }
      }
      this.run('UPDATE projects SET next_action_id = ?, updated_at = ? WHERE id = ?', next, this.nowMs(), projectId);
      return this.getProject(projectId);
    });
  }

  /** Снятая задача закрыта так же, как выполненная: проект она не держит. */
  setProjectArchived(id: string, archived: unknown): Project {
    const projectId = requireId(id, 'Идентификатор проекта');
    return this.tx(() => {
      this.getProject(projectId);
      const next = toBool(archived, false);
      if (next) {
        const open = this.all(
          "SELECT id FROM tasks WHERE project_id = ? AND completed_at IS NULL AND status != 'removed'",
          projectId,
        );
        if (open.length > 0) {
          throw new ApiError(409, 'project_has_open_tasks', MESSAGES.projectHasOpenTasks);
        }
        this.run('UPDATE projects SET next_action_id = NULL WHERE id = ?', projectId);
      }
      this.run('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?', next ? 1 : 0, this.nowMs(), projectId);
      return this.getProject(projectId);
    });
  }

  /** Удаление проекта обнуляет project_id его задач, сами задачи остаются. */
  deleteProject(id: string): UUID {
    const projectId = requireId(id, 'Идентификатор проекта');
    return this.tx(() => {
      this.getProject(projectId);
      this.run('UPDATE tasks SET project_id = NULL WHERE project_id = ?', projectId);
      this.run('DELETE FROM projects WHERE id = ?', projectId);
      return projectId;
    });
  }

  /* ---------------- дневник ---------------- */

  private insertEntryValues(values: {
    id: string;
    text: string;
    context: string | null;
    timestamp: number;
    day: DayKey;
    plan_id: string | null;
    created_at: number;
    updated_at: number;
  }): void {
    this.run(
      'INSERT INTO entries (id, text, context, timestamp, day, plan_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      values.id, values.text, values.context, values.timestamp, values.day,
      values.plan_id, values.created_at, values.updated_at,
    );
  }

  listEntries(filter: { day?: DayKey; from?: DayKey; to?: DayKey } = {}): DiaryEntry[] {
    if (filter.day) {
      return this.all('SELECT * FROM entries WHERE day = ? ORDER BY timestamp ASC, id ASC', filter.day).map((row) =>
        this.mapEntry(row),
      );
    }
    if (filter.from || filter.to) {
      const from = filter.from ?? '0000-01-01';
      const to = filter.to ?? '9999-12-31';
      return this.all(
        'SELECT * FROM entries WHERE day >= ? AND day <= ? ORDER BY timestamp ASC, id ASC',
        from,
        to,
      ).map((row) => this.mapEntry(row));
    }
    return this.all('SELECT * FROM entries ORDER BY timestamp ASC, id ASC').map((row) => this.mapEntry(row));
  }

  getEntry(id: string): DiaryEntry {
    const row = this.one('SELECT * FROM entries WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Запись дневника'));
    return this.mapEntry(row);
  }

  addEntry(draft: { text?: unknown; context?: unknown; timestamp?: unknown }): DiaryEntry {
    const text = cleanText(draft.text, 'Текст записи');
    return this.tx(() => {
      const now = this.nowMs();
      const timestamp = draft.timestamp === undefined ? now : parseIso(draft.timestamp, 'Время записи');
      const id = randomUUID();
      this.insertEntryValues({
        id,
        text,
        context: optionalText(draft.context, 'На чём остановился'),
        timestamp,
        day: dayKeyFromDate(new Date(timestamp), this.timeZone),
        plan_id: null,
        created_at: now,
        updated_at: now,
      });
      return this.getEntry(id);
    });
  }

  updateEntry(id: string, draft: { text?: unknown; context?: unknown; timestamp?: unknown }): DiaryEntry {
    const entryId = requireId(id, 'Идентификатор записи');
    return this.tx(() => {
      const row = this.one('SELECT * FROM entries WHERE id = ?', entryId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Запись дневника'));
      const text = draft.text === undefined ? str(row, 'text') : cleanText(draft.text, 'Текст записи');
      const context = draft.context === undefined ? strOrNull(row, 'context') : optionalText(draft.context, 'На чём остановился');
      const timestamp = draft.timestamp === undefined ? num(row, 'timestamp') : parseIso(draft.timestamp, 'Время записи');
      const day = dayKeyFromDate(new Date(timestamp), this.timeZone);
      this.run(
        'UPDATE entries SET text = ?, context = ?, timestamp = ?, day = ?, updated_at = ? WHERE id = ?',
        text, context, timestamp, day, this.nowMs(), entryId,
      );
      return this.getEntry(entryId);
    });
  }

  /** Удаление записи сохраняет отметку выполнения задачи. */
  deleteEntry(id: string): UUID {
    const entryId = requireId(id, 'Идентификатор записи');
    return this.tx(() => {
      this.getEntry(entryId);
      this.run('UPDATE tasks SET entry_id = NULL WHERE entry_id = ?', entryId);
      this.run('DELETE FROM entries WHERE id = ?', entryId);
      return entryId;
    });
  }

  /* ---------------- заметки и папки ---------------- */

  listNotes(filter: { folder_id?: string | null | 'none'; q?: string } = {}): Note[] {
    let sql = 'SELECT * FROM notes';
    const params: SqlValue[] = [];
    const clauses: string[] = [];
    if (filter.folder_id !== undefined) {
      if (filter.folder_id === null || filter.folder_id === 'none') {
        clauses.push('folder_id IS NULL');
      } else {
        clauses.push('folder_id = ?');
        params.push(filter.folder_id);
      }
    }
    if (filter.q && filter.q.trim() !== '') {
      clauses.push('(title LIKE ? OR body LIKE ?)');
      const needle = `%${filter.q.trim()}%`;
      params.push(needle, needle);
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY pinned DESC, created_at DESC, id ASC';
    return this.all(sql, ...params).map((row) => this.mapNote(row));
  }

  getNote(id: string): Note {
    const row = this.one('SELECT * FROM notes WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Заметка'));
    return this.mapNote(row);
  }

  private insertNote(draft: {
    title: string;
    body: string;
    folder_id: string | null;
    pinned: boolean;
  }): Note {
    const now = this.nowMs();
    const id = randomUUID();
    this.run(
      'INSERT INTO notes (id, title, body, folder_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, draft.title, draft.body, draft.folder_id, draft.pinned ? 1 : 0, now, now,
    );
    return this.getNote(id);
  }

  createNote(draft: {
    title?: unknown;
    body?: unknown;
    folder_id?: unknown;
    pinned?: unknown;
  }): Note {
    return this.tx(() => {
      const folderId = normalizeId(draft.folder_id, 'Папка');
      this.assertFolderExists(folderId);
      return this.insertNote({
        title: cleanText(draft.title, 'Заголовок заметки'),
        body: typeof draft.body === 'string' ? draft.body : '',
        folder_id: folderId,
        pinned: toBool(draft.pinned, false),
      });
    });
  }

  updateNote(
    id: string,
    draft: { title?: unknown; body?: unknown; folder_id?: unknown; pinned?: unknown },
  ): Note {
    const noteId = requireId(id, 'Идентификатор заметки');
    return this.tx(() => {
      const current = this.getNote(noteId);
      const folderId =
        draft.folder_id === undefined ? current.folder_id : normalizeId(draft.folder_id, 'Папка');
      this.assertFolderExists(folderId);
      this.run(
        'UPDATE notes SET title = ?, body = ?, folder_id = ?, pinned = ?, updated_at = ? WHERE id = ?',
        draft.title === undefined ? current.title : cleanText(draft.title, 'Заголовок заметки'),
        draft.body === undefined ? current.body : typeof draft.body === 'string' ? draft.body : '',
        folderId,
        draft.pinned === undefined ? (current.pinned ? 1 : 0) : toBool(draft.pinned, current.pinned) ? 1 : 0,
        this.nowMs(),
        noteId,
      );
      return this.getNote(noteId);
    });
  }

  deleteNote(id: string): UUID {
    const noteId = requireId(id, 'Идентификатор заметки');
    return this.tx(() => {
      this.getNote(noteId);
      this.run('DELETE FROM notes WHERE id = ?', noteId);
      return noteId;
    });
  }

  listNoteFolders(): NoteFolder[] {
    return this.all('SELECT * FROM note_folders ORDER BY name ASC, id ASC').map((row) => this.mapFolder(row));
  }

  getNoteFolder(id: string): NoteFolder {
    const row = this.one('SELECT * FROM note_folders WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound('Папка'));
    return this.mapFolder(row);
  }

  private assertFolderExists(folderId: string | null): void {
    if (folderId === null) return;
    if (this.one('SELECT id FROM note_folders WHERE id = ?', folderId) === undefined) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound('Папка'));
    }
  }

  private assertUniqueFolderName(name: string, parentId: string | null, exceptId?: string): void {
    const rows = this.all('SELECT id, name, parent_id FROM note_folders');
    const needle = foldText(name);
    for (const row of rows) {
      if (exceptId && str(row, 'id') === exceptId) continue;
      if (strOrNull(row, 'parent_id') !== parentId) continue;
      if (foldText(str(row, 'name')) === needle) {
        throw new ApiError(409, 'duplicate_note_folder_name', MESSAGES.duplicateNoteFolderName);
      }
    }
  }

  createNoteFolder(draft: { name?: unknown; parent_id?: unknown }): NoteFolder {
    return this.tx(() => {
      const name = cleanText(draft.name, 'Название папки');
      const parentId = normalizeId(draft.parent_id, 'Родительская папка');
      this.assertFolderExists(parentId);
      this.assertUniqueFolderName(name, parentId);
      const id = randomUUID();
      this.run('INSERT INTO note_folders (id, name, parent_id) VALUES (?, ?, ?)', id, name, parentId);
      return this.getNoteFolder(id);
    });
  }

  updateNoteFolder(id: string, draft: { name?: unknown; parent_id?: unknown }): NoteFolder {
    const folderId = requireId(id, 'Идентификатор папки');
    return this.tx(() => {
      const current = this.getNoteFolder(folderId);
      const name = draft.name === undefined ? current.name : cleanText(draft.name, 'Название папки');
      const parentId =
        draft.parent_id === undefined ? current.parent_id : normalizeId(draft.parent_id, 'Родительская папка');
      this.assertFolderExists(parentId);
      if (parentId === folderId || this.isDescendant(parentId, folderId)) {
        throw new ApiError(409, 'invalid_note_folder_move', MESSAGES.invalidNoteFolderMove);
      }
      this.assertUniqueFolderName(name, parentId, folderId);
      this.run('UPDATE note_folders SET name = ?, parent_id = ? WHERE id = ?', name, parentId, folderId);
      return this.getNoteFolder(folderId);
    });
  }

  private isDescendant(candidate: string | null, ancestorId: string): boolean {
    let next = candidate;
    const seen = new Set<string>();
    while (next !== null && !seen.has(next)) {
      if (next === ancestorId) return true;
      seen.add(next);
      const row = this.one('SELECT parent_id FROM note_folders WHERE id = ?', next);
      next = row ? strOrNull(row, 'parent_id') : null;
    }
    return false;
  }

  /** Удаление папки переносит её заметки и подпапки на уровень выше. */
  deleteNoteFolder(id: string): { removed_folder_id: UUID; moved_up: number } {
    const folderId = requireId(id, 'Идентификатор папки');
    return this.tx(() => {
      const current = this.getNoteFolder(folderId);
      const parentId = current.parent_id;
      const childFolders = this.all('SELECT id FROM note_folders WHERE parent_id = ?', folderId).length;
      const childNotes = this.all('SELECT id FROM notes WHERE folder_id = ?', folderId).length;
      this.run('UPDATE note_folders SET parent_id = ? WHERE parent_id = ?', parentId, folderId);
      this.run('UPDATE notes SET folder_id = ? WHERE folder_id = ?', parentId, folderId);
      this.run('DELETE FROM note_folders WHERE id = ?', folderId);
      return { removed_folder_id: folderId, moved_up: childFolders + childNotes };
    });
  }

  /* ---------------- выборки ---------------- */

  tasksForDay(day: DayKey): { date: DayKey; is_today: boolean; tasks: Task[] } {
    const today = this.today();
    return { date: day, is_today: day === today, tasks: tasksForDay(this.listTasks(), day, today) };
  }

  review(day: DayKey): { date: DayKey; groups: ReviewGroup[] } {
    return { date: day, groups: reviewGroups(this.listTasks(), this.listProjects(), day) };
  }

  search(query: string, includeCompleted = false, includeRemoved = false) {
    return searchOrganizer(query, this.listTasks(), this.listProjects(), this.listChaos(), includeCompleted, includeRemoved);
  }

  allTasks(): Task[] {
    return this.listTasks();
  }

  visibleTaskList(showCompleted = false, showRemoved = false): Task[] {
    return visibleTasks(this.listTasks(), showCompleted, showRemoved);
  }

  openTasks(): Task[] {
    return sortPlans(this.listTasks().filter(isOpen));
  }

  /* ---------------- снимок ---------------- */

  getState(): Snapshot {
    const now = this.now();
    return {
      timezone: this.timeZone,
      today: todayKey(this.timeZone, now),
      now: now.toISOString(),
      chaos: this.listChaos(),
      tasks: this.listTasks(),
      projects: this.listProjects(),
      entries: this.listEntries(),
      notes: this.listNotes(),
      note_folders: this.listNoteFolders(),
    };
  }

  /* ---------------- низкоуровневая запись для импорта ---------------- */

  upsertTaskValues(values: TaskValues, mode: 'insert' | 'update'): void {
    if (mode === 'insert') this.insertTaskValues(values);
    else this.updateTaskValues(values);
  }

  taskRowById(id: string): Row | undefined {
    return this.getTaskRow(id);
  }

  makeTaskValues(partial: Partial<TaskValues> & { id: string; text: string }): TaskValues {
    const now = this.nowMs();
    return { ...this.emptyTaskValues(now), ...partial };
  }

  insertEntryRaw(values: {
    id: string;
    text: string;
    context: string | null;
    timestamp: number;
    plan_id: string | null;
    created_at: number;
    updated_at: number;
  }): void {
    this.insertEntryValues({
      ...values,
      day: dayKeyFromDate(new Date(values.timestamp), this.timeZone),
    });
  }

  entryRowById(id: string): Row | undefined {
    return this.one('SELECT * FROM entries WHERE id = ?', id);
  }

  insertChaosRaw(id: string, text: string, urgent: boolean, createdAt: number): void {
    this.run('INSERT INTO chaos (id, text, urgent, created_at) VALUES (?, ?, ?, ?)', id, text, urgent ? 1 : 0, createdAt);
  }

  chaosRowById(id: string): Row | undefined {
    return this.one('SELECT * FROM chaos WHERE id = ?', id);
  }

  insertProjectRaw(values: {
    id: string;
    title: string;
    outcome: string;
    area: Area;
    uncertainty: string;
    review_date: string | null;
    next_action_id: string | null;
    archived: boolean;
    created_at: number;
    updated_at: number;
  }): void {
    this.run(
      'INSERT INTO projects (id, title, outcome, area, uncertainty, review_date, next_action_id, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values.id, values.title, values.outcome, values.area, values.uncertainty, values.review_date,
      values.next_action_id, values.archived ? 1 : 0, values.created_at, values.updated_at,
    );
  }

  updateProjectRaw(values: {
    id: string;
    title: string;
    outcome: string;
    area: Area;
    uncertainty: string;
    review_date: string | null;
    next_action_id: string | null;
    archived: boolean;
    updated_at: number;
  }): void {
    this.run(
      'UPDATE projects SET title = ?, outcome = ?, area = ?, uncertainty = ?, review_date = ?, next_action_id = ?, archived = ?, updated_at = ? WHERE id = ?',
      values.title, values.outcome, values.area, values.uncertainty, values.review_date,
      values.next_action_id, values.archived ? 1 : 0, values.updated_at, values.id,
    );
  }

  insertNoteRaw(values: {
    id: string;
    title: string;
    body: string;
    folder_id: string | null;
    pinned: boolean;
    created_at: number;
    updated_at: number;
  }): void {
    this.run(
      'INSERT INTO notes (id, title, body, folder_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      values.id, values.title, values.body, values.folder_id, values.pinned ? 1 : 0,
      values.created_at, values.updated_at,
    );
  }

  updateNoteRaw(values: {
    id: string;
    title: string;
    body: string;
    folder_id: string | null;
    pinned: boolean;
    updated_at: number;
  }): void {
    this.run(
      'UPDATE notes SET title = ?, body = ?, folder_id = ?, pinned = ?, updated_at = ? WHERE id = ?',
      values.title, values.body, values.folder_id, values.pinned ? 1 : 0, values.updated_at, values.id,
    );
  }

  noteRowById(id: string): Row | undefined {
    return this.one('SELECT * FROM notes WHERE id = ?', id);
  }

  insertFolderRaw(id: string, name: string, parentId: string | null): void {
    this.run('INSERT INTO note_folders (id, name, parent_id) VALUES (?, ?, ?)', id, name, parentId);
  }

  updateFolderRaw(id: string, name: string, parentId: string | null): void {
    this.run('UPDATE note_folders SET name = ?, parent_id = ? WHERE id = ?', name, parentId, id);
  }

  folderRowById(id: string): Row | undefined {
    return this.one('SELECT * FROM note_folders WHERE id = ?', id);
  }

  updateEntryRaw(id: string, values: {
    text: string;
    context: string | null;
    timestamp: number;
    plan_id: string | null;
    updated_at: number;
  }): void {
    this.run(
      'UPDATE entries SET text = ?, context = ?, timestamp = ?, day = ?, plan_id = ?, updated_at = ? WHERE id = ?',
      values.text, values.context, values.timestamp,
      dayKeyFromDate(new Date(values.timestamp), this.timeZone),
      values.plan_id, values.updated_at, id,
    );
  }

  updateChaosRaw(id: string, text: string, urgent: boolean): void {
    this.run('UPDATE chaos SET text = ?, urgent = ? WHERE id = ?', text, urgent ? 1 : 0, id);
  }

  updateTaskRaw(values: TaskValues): void {
    this.updateTaskValues(values);
  }

  mapTaskRow(row: Row): Task {
    return this.mapTask(row);
  }

  countRows(table: string): number {
    const allowed = ['tasks', 'projects', 'chaos', 'entries', 'notes', 'note_folders'];
    if (!allowed.includes(table)) return fail(400, 'invalid_request', 'Неизвестная таблица.');
    return num(this.one(`SELECT COUNT(*) AS total FROM ${table}`) ?? {}, 'total');
  }

  emptyCounts(): ImportCounts {
    return { tasks: 0, projects: 0, chaos: 0, entries: 0, notes: 0, note_folders: 0 };
  }

  cookieName(): string {
    return COOKIE_NAME;
  }
}

export { foldText };
