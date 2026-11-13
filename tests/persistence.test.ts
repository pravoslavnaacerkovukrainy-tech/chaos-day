import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/server/db.ts';
import { loadConfig, startRuntime } from '../src/server/index.ts';
import type { Runtime } from '../src/server/index.ts';
import { importDocument } from '../src/server/transfer.ts';
import { Store } from '../src/server/store.ts';
import { readFixture } from './helpers.ts';

const PASSWORD = 'пароль-проверки-стойкости';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Состояние переживает перезапуск', () => {
  it('данные, пароль и часовой пояс читаются после остановки сервера', async () => {
    const dir = tempDir('chaos-day-persist-');
    const databaseFile = join(dir, 'chaos-day.sqlite');
    const base = { ...loadConfig({}), databaseFile, port: 0, testing: true, allowFaults: false, clientDistDir: null };

    const first: Runtime = await startRuntime(base);
    let sessionToken = '';
    let taskId = '';
    try {
      const store = first.store;
      store.setupPassword(PASSWORD);
      store.setTimeZone('Europe/Warsaw');
      const chaos = store.addChaos('Уточнить график отключения воды', true);
      const task = store.chaosToTask(chaos.id, { text: 'Уточнить график отключения воды' }).task;
      taskId = task.id;
      store.rescheduleTask(task.id, '2026-11-16');
      store.updateTask(task.id, { deadline: '2026-11-17', promised_to: 'Ольга' });
      store.completeTask(task.id);
      store.addChaos('Строка, которую не разбирали', false);
      sessionToken = store.createSession().token;
    } finally {
      await first.close();
    }

    assert.ok(existsSync(databaseFile), 'файл базы создан в указанном каталоге');

    const second: Runtime = await startRuntime(base);
    try {
      const store = second.store;
      assert.equal(store.timeZone, 'Europe/Warsaw', 'часовой пояс хранится рядом с данными');
      assert.equal(store.setupRequired(), false, 'пароль пережил перезапуск');
      assert.equal(store.checkPassword(PASSWORD), true);
      assert.equal(store.checkPassword('неверный-пароль-123'), false);

      // Прежняя сессия не восстанавливается из файла как «вечно живая»: срок жизни действует.
      const session = store.touchSession(sessionToken);
      assert.notEqual(session, null, 'сессия в пределах срока жизни действует после перезапуска');

      const task = store.getTask(taskId);
      assert.equal(task.text, 'Уточнить график отключения воды');
      assert.equal(task.at_risk, true, 'срочная строка дала отметку угрозы');
      assert.equal(task.day, '2026-11-16');
      assert.equal(task.deadline, '2026-11-17');
      assert.equal(task.promised_to, 'Ольга');
      assert.notEqual(task.completed_at, null);

      assert.equal(store.listEntries().length, 1, 'одна запись дневника на выполнение');
      assert.equal(store.listChaos().length, 1, 'неразобранная строка осталась');
      assert.equal(store.listTasks().length, 1, 'копий не появилось');
    } finally {
      await second.close();
    }
  });

  it('импортированный архив сохраняется на диске без дублей', async () => {
    const dir = tempDir('chaos-day-import-');
    const databaseFile = join(dir, 'chaos-day.sqlite');
    const base = { ...loadConfig({}), databaseFile, port: 0, testing: true, allowFaults: false, clientDistDir: null };
    const text = readFixture('mac-v7-review.json');

    const runtime = await startRuntime(base);
    try {
      const first = importDocument(runtime.store, text);
      assert.equal(first.added.tasks, 8);
      const second = importDocument(runtime.store, text);
      assert.deepEqual(second.added, {
        tasks: 0, projects: 0, chaos: 0, entries: 0, notes: 0, note_folders: 0,
      });
    } finally {
      await runtime.close();
    }

    const reopened = await startRuntime(base);
    try {
      assert.equal(reopened.store.listTasks().length, 8);
      const third = importDocument(reopened.store, text);
      assert.equal(third.added.tasks, 0, 'повторный импорт после перезапуска не плодит копии');
      assert.equal(reopened.store.listProjects().length, 2);
      assert.equal(reopened.store.review('2026-11-13').groups.length, 6);
    } finally {
      await reopened.close();
    }
  });

  it('файл базы открывается повторно и схема доводится до текущей', () => {
    const dir = tempDir('chaos-day-schema-');
    const databaseFile = join(dir, 'chaos-day.sqlite');

    const first = openDatabase(databaseFile);
    first.close();

    // База, созданная до счётчика версий, доводится до текущей схемы без потери данных.
    const legacy = openDatabase(databaseFile);
    legacy.exec('DROP TRIGGER IF EXISTS tasks_bump_revision');
    legacy.exec('ALTER TABLE tasks DROP COLUMN revision');
    legacy
      .prepare('INSERT INTO tasks (id, text, day, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('a0000000-0000-4000-8000-00000000aaaa', 'Старая задача', '', 1, 1);
    legacy.close();

    const upgraded = openDatabase(databaseFile);
    const store = new Store(upgraded);
    const task = store.getTask('a0000000-0000-4000-8000-00000000aaaa');
    assert.equal(task.text, 'Старая задача');
    assert.equal(task.revision, 0);

    const updated = store.updateTask(task.id, { details: 'Правка после обновления схемы' });
    assert.equal(updated.revision, 1, 'триггер счётчика версий восстановлен');
    upgraded.close();
  });

  it('журнал запросов не содержит текст задач и заметок', async () => {
    const dir = tempDir('chaos-day-nolog-');
    const runtime = await startRuntime({
      ...loadConfig({}),
      databaseFile: join(dir, 'chaos-day.sqlite'),
      port: 0,
      testing: true,
      allowFaults: false,
      clientDistDir: null,
    });
    try {
      runtime.store.setupPassword(PASSWORD);
      runtime.store.addChaos('Секретный текст строки места хаоса', false);
      runtime.store.createNote({ title: 'Секретный заголовок заметки', body: 'Секретное тело' });

      const res = await fetch(`${runtime.url}/api/chaos`, {
        headers: { cookie: `chaos_day_session=${runtime.store.createSession().token}` },
      });
      assert.equal(res.status, 200);

      const files = readdirSync(dir);
      assert.ok(files.includes('chaos-day.sqlite'));
      // Тексты дел живут только в базе; отдельный журнал запросов сервер не ведёт.
      assert.deepEqual(
        files.filter((name) => /\.log$/.test(name)),
        [],
      );
    } finally {
      await runtime.close();
    }
  });
});
