import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 2;

const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  outcome        TEXT NOT NULL DEFAULT '',
  area           TEXT NOT NULL DEFAULT 'personal' CHECK (area IN ('work','personal')),
  uncertainty    TEXT NOT NULL DEFAULT '',
  review_date    TEXT,
  next_action_id TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_folders (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id TEXT REFERENCES note_folders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  text           TEXT NOT NULL,
  day            TEXT NOT NULL DEFAULT '',
  deadline       TEXT,
  review_date    TEXT,
  area           TEXT NOT NULL DEFAULT 'personal' CHECK (area IN ('work','personal')),
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'ready'
                   CHECK (status IN ('inbox','ready','waiting','paused','removed')),
  waiting_for    TEXT,
  promised_to    TEXT,
  at_risk        INTEGER NOT NULL DEFAULT 0,
  removal_reason TEXT,
  details        TEXT,
  steps_json     TEXT NOT NULL DEFAULT '[]',
  completed_at   INTEGER,
  entry_id       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  context    TEXT,
  timestamp  INTEGER NOT NULL,
  day        TEXT NOT NULL,
  plan_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  folder_id  TEXT REFERENCES note_folders(id) ON DELETE SET NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chaos (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  urgent     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;

const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tasks_day ON tasks(day);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_review_date ON tasks(review_date);
CREATE INDEX IF NOT EXISTS idx_entries_day ON entries(day);
CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_entries_plan ON entries(plan_id);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

/* Любой UPDATE задачи увеличивает revision. Счётчик нужен, чтобы правка шагов
   из второго окна обнаруживалась даже внутри одной секунды: отметка времени
   для этого слишком грубая. Рекурсивные триггеры выключены, поэтому внутреннее
   обновление триггер повторно не запускает. */
CREATE TRIGGER IF NOT EXISTS tasks_bump_revision
AFTER UPDATE ON tasks
FOR EACH ROW
BEGIN
  UPDATE tasks SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
`;

export const SCHEMA = `${SCHEMA_TABLES}\n${SCHEMA_INDEXES}`;

function taskColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT name FROM pragma_table_info(\'tasks\')').all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Открывает хранилище и доводит схему до текущего состояния.
 * Путь ':memory:' даёт базу в памяти — для автопроверок.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Триггер revision должен срабатывать один раз на обновление, а не по цепочке.
  db.exec('PRAGMA recursive_triggers = OFF');

  db.exec(SCHEMA_TABLES);
  // База, созданная до появления счётчика версий, доводится до текущей схемы.
  if (!taskColumns(db).has('revision')) {
    db.exec('ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(SCHEMA_INDEXES);

  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', String(SCHEMA_VERSION));
  return db;
}

export function databasePath(dataDir: string, fileName = 'chaos-day.sqlite'): string {
  return `${dataDir.replace(/\/+$/, '')}/${fileName}`;
}
