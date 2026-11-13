// Типы контракта docs/web-v1-api.md (раздел 1). Менять только вместе с контрактом.

/** Календарный день владельца, строго YYYY-MM-DD. */
export type DayKey = string;
/** Момент времени ISO-8601 в UTC. */
export type Iso = string;
export type UUID = string;

export type Area = "work" | "personal";
export type TaskStatus = "inbox" | "ready" | "waiting" | "paused" | "removed";

export interface TaskStep {
  id: UUID;
  text: string;
  completed_at: Iso | null;
}

export interface Task {
  id: UUID;
  text: string;
  day: DayKey | "";
  deadline: DayKey | null;
  review_date: DayKey | null;
  area: Area;
  project_id: UUID | null;
  status: TaskStatus;
  waiting_for: string | null;
  promised_to: string | null;
  at_risk: boolean;
  removal_reason: string | null;
  details: string | null;
  steps: TaskStep[];
  completed_at: Iso | null;
  entry_id: UUID | null;
  created_at: Iso;
  updated_at: Iso;
  /** Счётчик версий задачи на сервере; растёт при любой записи. Старый сервер может не прислать. */
  revision?: number;
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

export type ReviewKey =
  | "promised_with_deadline"
  | "promised_without_deadline"
  | "at_risk"
  | "today_and_next_steps"
  | "waiting"
  | "review";

export interface ReviewItem {
  kind: "task" | "project";
  id: UUID;
  title: string;
  task: Task | null;
  project: Project | null;
}

export interface ReviewGroup {
  key: ReviewKey;
  title: string;
  items: ReviewItem[];
  is_empty: boolean;
  empty_text: string;
}

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

type Counts = {
  tasks: number;
  projects: number;
  chaos: number;
  entries: number;
  notes: number;
  note_folders: number;
};

export interface ImportReport {
  source_version: number;
  mode: "merge" | "overwrite";
  added: Counts;
  updated: Counts;
  skipped: Counts;
  warnings: string[];
}

/** Черновик задачи для POST /api/tasks, PATCH и to-task. */
export interface TaskDraft {
  text: string;
  area: Area;
  project_id: UUID | null;
  status: TaskStatus;
  day: DayKey | "";
  deadline: DayKey | null;
  review_date: DayKey | null;
  waiting_for: string | null;
  promised_to: string | null;
  at_risk: boolean;
  details: string | null;
}

export interface ProjectDraft {
  title: string;
  outcome: string;
  area: Area;
  uncertainty: string;
  review_date: DayKey | null;
}
