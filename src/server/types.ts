/**
 * Доменные типы веб-версии «Хаос Дня», этап 1.
 * Формы совпадают с docs/web-v1-api.md; любое расхождение — несовместимое изменение.
 */

/** Календарный день владельца, строго YYYY-MM-DD, без часового пояса. */
export type DayKey = string;

/** Момент времени, ISO-8601 в UTC с миллисекундами. */
export type Iso = string;

export type UUID = string;

export type Area = 'work' | 'personal';

export const AREAS: readonly Area[] = ['work', 'personal'];

export type TaskStatus = 'inbox' | 'ready' | 'waiting' | 'paused' | 'removed';

export const TASK_STATUSES: readonly TaskStatus[] = ['inbox', 'ready', 'waiting', 'paused', 'removed'];

/** Тексты статусов взяты из Mac-версии, новых метафор нет. */
export const TASK_STATUS_TITLES: Record<TaskStatus, string> = {
  inbox: 'Место хаоса',
  ready: 'Можно делать',
  waiting: 'Ожидаю',
  paused: 'Отложено',
  removed: 'Снято',
};

/** «Снято» задаётся только командой «Снять…» с причиной, поэтому в редакторе его нет. */
export const SELECTABLE_TASK_STATUSES: readonly TaskStatus[] = ['inbox', 'ready', 'waiting', 'paused'];

/** Статусы, при которых отметка «Обещание под угрозой» возвращает дело в выборки. */
export const AT_RISK_STATUSES: readonly TaskStatus[] = ['ready', 'waiting', 'paused'];

export interface TaskStep {
  id: UUID;
  text: string;
  completed_at: Iso | null;
}

export interface Task {
  id: UUID;
  text: string;
  /** День работы. Пустая строка — день не выбран. */
  day: DayKey | '';
  /** Срок результата. */
  deadline: DayKey | null;
  /** Дата пересмотра. */
  review_date: DayKey | null;
  area: Area;
  project_id: UUID | null;
  status: TaskStatus;
  waiting_for: string | null;
  /** Свободная строка, не контакт. В дневник не копируется. */
  promised_to: string | null;
  at_risk: boolean;
  removal_reason: string | null;
  details: string | null;
  steps: TaskStep[];
  completed_at: Iso | null;
  entry_id: UUID | null;
  created_at: Iso;
  updated_at: Iso;
  is_completed: boolean;
  is_removed: boolean;
  is_open: boolean;
  next_step: TaskStep | null;
}

export interface Project {
  id: UUID;
  title: string;
  outcome: string;
  area: Area;
  uncertainty: string;
  review_date: DayKey | null;
  next_action_id: UUID | null;
  archived: boolean;
  created_at: Iso;
  updated_at: Iso;
}

export interface ChaosItem {
  id: UUID;
  text: string;
  urgent: boolean;
  created_at: Iso;
}

export interface DiaryEntry {
  id: UUID;
  text: string;
  context: string | null;
  timestamp: Iso;
  day: DayKey;
  plan_id: UUID | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface Note {
  id: UUID;
  title: string;
  body: string;
  folder_id: UUID | null;
  pinned: boolean;
  created_at: Iso;
  updated_at: Iso;
}

export interface NoteFolder {
  id: UUID;
  name: string;
  parent_id: UUID | null;
}

export interface ReviewItem {
  kind: 'task' | 'project';
  id: UUID;
  title: string;
  task: Task | null;
  project: Project | null;
}

export type ReviewGroupKey =
  | 'promised_with_deadline'
  | 'promised_without_deadline'
  | 'at_risk'
  | 'today_and_next_steps'
  | 'waiting'
  | 'review';

export interface ReviewGroup {
  key: ReviewGroupKey;
  title: string;
  items: ReviewItem[];
  is_empty: boolean;
  empty_text: string;
}

/** Порядок шести групп фиксирован методикой, первое совпадение побеждает. */
export const REVIEW_GROUP_DEFS: readonly { key: ReviewGroupKey; title: string }[] = [
  { key: 'promised_with_deadline', title: 'Обещания со сроком' },
  { key: 'promised_without_deadline', title: 'Обещания без срока' },
  { key: 'at_risk', title: 'Под угрозой' },
  { key: 'today_and_next_steps', title: 'Сегодня и следующие шаги' },
  { key: 'waiting', title: 'Ожидания' },
  { key: 'review', title: 'Пересмотр' },
];

export const EMPTY_GROUP_TEXT = 'Сейчас здесь ничего нет';

export interface Snapshot {
  timezone: string;
  today: DayKey;
  now: Iso;
  chaos: ChaosItem[];
  tasks: Task[];
  projects: Project[];
  entries: DiaryEntry[];
  notes: Note[];
  note_folders: NoteFolder[];
}

export interface ImportCounts {
  tasks: number;
  projects: number;
  chaos: number;
  entries: number;
  notes: number;
  note_folders: number;
}

export interface ImportReport {
  source_version: number;
  mode: 'merge' | 'overwrite';
  added: ImportCounts;
  updated: ImportCounts;
  skipped: ImportCounts;
  warnings: string[];
}
