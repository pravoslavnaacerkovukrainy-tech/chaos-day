import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig, startRuntime } from '../src/server/index.ts';
import type { Runtime } from '../src/server/index.ts';
import { createTestStore, throwsCode } from './helpers.ts';

const PASSWORD = 'пароль-синхронизации-1';
const MISSING_ID = 'a1000000-0000-4000-8000-0000000000aa';

describe('Синхронизация полей задачи', () => {
  it('правка проходит, когда сервер держит значение из базы клиента', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Согласовать график', day: '2026-11-14' });

    const result = store.syncTask(task.id, { day: '2026-11-14' }, { day: '2026-11-15' });

    assert.deepEqual(result.conflicts, []);
    assert.equal(result.task.day, '2026-11-15');
    assert.equal(result.task.text, 'Согласовать график', 'остальные поля не тронуты');
    assert.equal(result.task.revision, task.revision + 1);
    assert.equal(store.getTask(task.id).day, '2026-11-15');
  });

  it('повтор той же правки подтверждается без записи в базу', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Согласовать график', day: '2026-11-14' });
    const first = store.syncTask(task.id, { day: '2026-11-14' }, { day: '2026-11-15' });

    const again = store.syncTask(task.id, { day: '2026-11-14' }, { day: '2026-11-15' });

    assert.deepEqual(again.conflicts, []);
    assert.equal(again.task.day, '2026-11-15');
    assert.equal(again.task.revision, first.task.revision, 'счётчик версий не растёт');
    assert.equal(again.task.updated_at, first.task.updated_at, 'время правки прежнее');
  });

  it('пустая строка снимает день работы', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Согласовать график', day: '2026-11-14' });

    const cleared = store.syncTask(task.id, { day: '2026-11-14' }, { day: '' });
    assert.equal(cleared.task.day, '');

    const withoutDay = store.getTask(task.id);
    const back = store.syncTask(task.id, { day: '' }, { day: '2026-11-20' });
    assert.equal(back.task.day, '2026-11-20');
    assert.equal(back.task.revision, withoutDay.revision + 1);
  });

  it('конфликт по одному полю не применяет ни одного поля', () => {
    const { store } = createTestStore();
    const task = store.createTask({
      text: 'Исходный текст',
      day: '2026-11-14',
      details: 'Исходные подробности',
    });
    // Веб-правка того же дня, о которой клиент ещё не знает.
    store.updateTask(task.id, { day: '2026-11-20' });
    const before = store.getTask(task.id);

    const result = store.syncTask(
      task.id,
      { day: '2026-11-14', text: 'Исходный текст', details: 'Исходные подробности' },
      { day: '2026-11-15', text: 'Новый текст', details: 'Новые подробности' },
    );

    assert.deepEqual(result.conflicts, ['day']);
    assert.equal(result.task.day, '2026-11-20', 'значение сервера сохранено');
    assert.equal(result.task.text, 'Исходный текст', 'согласованный текст не применён');
    assert.equal(result.task.details, 'Исходные подробности');
    assert.equal(result.task.revision, before.revision, 'запись не выполнялась');
  });

  it('каждое расходившееся поле попадает в список конфликта', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Старый текст', day: '2026-11-14', details: 'Старые' });
    store.updateTask(task.id, { text: 'Текст из веба', day: '2026-11-20' });

    const result = store.syncTask(
      task.id,
      { details: 'Старые', text: 'Старый текст', day: '2026-11-14' },
      { details: 'Новые', text: 'Мой текст', day: '2026-11-15' },
    );

    assert.deepEqual(result.conflicts, ['day', 'text'], 'порядок полей устойчивый');
    assert.equal(result.task.details, 'Старые', 'согласованное поле тоже не применено');
  });

  it('«Моя версия» повторяет запись с базой текущего значения', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Согласовать график', day: '2026-11-14' });
    store.updateTask(task.id, { day: '2026-11-20' });
    const conflicted = store.syncTask(task.id, { day: '2026-11-14' }, { day: '2026-11-15' });
    assert.deepEqual(conflicted.conflicts, ['day']);

    const mine = store.syncTask(task.id, { day: conflicted.task.day }, { day: '2026-11-15' });

    assert.deepEqual(mine.conflicts, []);
    assert.equal(mine.task.day, '2026-11-15');
    assert.equal(mine.task.revision, conflicted.task.revision + 1);
  });

  it('«Версия сервера» убирает правку и не пишет в базу', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Согласовать график', day: '2026-11-14' });
    store.updateTask(task.id, { day: '2026-11-20' });
    const conflicted = store.syncTask(task.id, { day: '2026-11-14' }, { day: '2026-11-15' });

    // Клиент принимает значение сервера: база и правка становятся текущим значением.
    const theirs = store.syncTask(
      task.id,
      { day: conflicted.task.day },
      { day: conflicted.task.day },
    );

    assert.deepEqual(theirs.conflicts, []);
    assert.equal(theirs.task.day, '2026-11-20');
    assert.equal(theirs.task.revision, conflicted.task.revision, 'ревизия не растёт');
  });

  it('подробности: null, пустая строка и пробелы — одно значение', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Задача' });
    assert.equal(task.details, null);

    const filled = store.syncTask(task.id, { details: '   ' }, { details: 'Подробности' });
    assert.deepEqual(filled.conflicts, []);
    assert.equal(filled.task.details, 'Подробности');

    const cleared = store.syncTask(task.id, { details: 'Подробности' }, { details: null });
    assert.equal(cleared.task.details, null);
    assert.equal(cleared.task.revision, filled.task.revision + 1);
  });

  it('пробелы вокруг текста не создают ложного конфликта', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });

    const result = store.syncTask(
      task.id,
      { text: '  Собрать документы ' },
      { text: ' Собрать документы и справку ' },
    );

    assert.deepEqual(result.conflicts, []);
    assert.equal(result.task.text, 'Собрать документы и справку');
  });

  it('синхронизация не задевает срок, проект и сферу', () => {
    const { store } = createTestStore();
    const project = store.createProject({ title: 'Проект', outcome: 'Результат', area: 'work' });
    const task = store.createTask({
      text: 'Задача',
      project_id: project.id,
      day: '2026-11-14',
      deadline: '2026-11-20',
    });

    const result = store.syncTask(task.id, { day: '2026-11-14' }, { day: '' });

    assert.equal(result.task.deadline, '2026-11-20');
    assert.equal(result.task.project_id, project.id);
    assert.equal(result.task.area, 'work');
    assert.equal(result.task.revision, task.revision + 1);

    const patched = store.updateTask(task.id, { text: 'Правка из веба' });
    assert.equal(patched.revision, task.revision + 2, 'веб-правка идёт обычным порядком');
  });

  it('ошибка сохранения откатывает синхронизацию целиком', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Задача', day: '2026-11-14', details: 'Старые' });
    store.armFault('save', 1);

    throwsCode(
      () =>
        store.syncTask(
          task.id,
          { day: '2026-11-14', details: 'Старые' },
          { day: '2026-11-15', details: 'Новые' },
        ),
      'save_failed',
    );

    const after = store.getTask(task.id);
    assert.equal(after.day, '2026-11-14', 'ни одно поле не применено частично');
    assert.equal(after.details, 'Старые');
    assert.equal(after.revision, task.revision);

    const retried = store.syncTask(
      task.id,
      { day: '2026-11-14', details: 'Старые' },
      { day: '2026-11-15', details: 'Новые' },
    );
    assert.deepEqual(retried.conflicts, []);
    assert.equal(retried.task.day, '2026-11-15');
    assert.equal(retried.task.details, 'Новые');
  });

  it('выполненную и снятую задачу нельзя синхронизировать до возврата', () => {
    const { store } = createTestStore();
    const done = store.createTask({ text: 'Выполненная' });
    store.completeTask(done.id);
    throwsCode(
      () => store.syncTask(done.id, { text: 'Выполненная' }, { text: 'Другая' }),
      'task_is_completed',
    );

    const removed = store.createTask({ text: 'Снятая' });
    store.removeTask(removed.id, 'Пока не нужно');
    throwsCode(
      () => store.syncTask(removed.id, { text: 'Снятая' }, { text: 'Другая' }),
      'task_is_removed',
    );
  });

  it('отсутствующая и удалённая задача дают not_found', () => {
    const { store } = createTestStore();
    throwsCode(
      () => store.syncTask(MISSING_ID, { day: '' }, { day: '2026-11-15' }),
      'not_found',
    );

    const task = store.createTask({ text: 'Задача' });
    store.deleteTask(task.id);
    throwsCode(
      () => store.syncTask(task.id, { text: 'Задача' }, { text: 'Другая' }),
      'not_found',
    );

    throwsCode(
      () => store.syncTask('не-идентификатор', { text: 'Задача' }, { text: 'Другая' }),
      'invalid_request',
    );
  });

  it('отклоняет чужие поля и рассогласованные наборы', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Задача', day: '2026-11-14' });

    throwsCode(
      () => store.syncTask(task.id, { status: 'ready' }, { status: 'paused' }),
      'invalid_request',
      'поле вне синхронизации',
    );
    throwsCode(
      () => store.syncTask(task.id, { day: '2026-11-14', area: 'work' }, { day: '2026-11-15', area: 'work' }),
      'invalid_request',
      'одно из полей вне синхронизации',
    );
    throwsCode(
      () => store.syncTask(task.id, { day: '2026-11-14' }, { day: '2026-11-15', text: 'Задача' }),
      'invalid_request',
      'в правке лишнее поле',
    );
    throwsCode(
      () => store.syncTask(task.id, { day: '2026-11-14', text: 'Задача' }, { day: '2026-11-15' }),
      'invalid_request',
      'в базе лишнее поле',
    );
    throwsCode(() => store.syncTask(task.id, {}, {}), 'invalid_request', 'пустой набор');
    throwsCode(
      () => store.syncTask(task.id, undefined, { day: '2026-11-15' }),
      'invalid_request',
      'нет базы',
    );
    throwsCode(
      () => store.syncTask(task.id, { day: '2026-11-14' }, null),
      'invalid_request',
      'нет правки',
    );
    throwsCode(
      () => store.syncTask(task.id, 'не объект', { day: '2026-11-15' }),
      'invalid_request',
      'база не объект',
    );
    throwsCode(
      () => store.syncTask(task.id, [{ day: '2026-11-14' }], [{ day: '2026-11-15' }]),
      'invalid_request',
      'массив вместо объекта',
    );

    assert.equal(store.getTask(task.id).revision, task.revision, 'задача не изменена');
  });

  it('отклоняет неверные значения полей', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Задача', day: '2026-11-14' });

    throwsCode(
      () => store.syncTask(task.id, { day: '2026-02-30' }, { day: '2026-11-15' }),
      'invalid_date',
      'несуществующий день в базе',
    );
    throwsCode(
      () => store.syncTask(task.id, { day: '2026-11-14' }, { day: '15.11.2026' }),
      'invalid_date',
      'неверный формат правки',
    );
    throwsCode(
      () => store.syncTask(task.id, { day: '2026-11-14' }, { day: 20261115 }),
      'invalid_date',
      'число вместо даты',
    );
    throwsCode(
      () => store.syncTask(task.id, { text: 'Задача' }, { text: '   ' }),
      'empty_text',
      'пустой текст правки',
    );
    throwsCode(
      () => store.syncTask(task.id, { text: '   ' }, { text: 'Другая' }),
      'empty_text',
      'пустой текст базы',
    );
    throwsCode(
      () => store.syncTask(task.id, { text: 'Задача' }, { text: 42 }),
      'invalid_request',
      'текст не строка',
    );
    throwsCode(
      () => store.syncTask(task.id, { details: null }, { details: 42 }),
      'invalid_request',
      'подробности не строка и не null',
    );
    throwsCode(
      () => store.syncTask(task.id, { details: null }, { details: 'а'.repeat(4001) }),
      'invalid_request',
      'подробности длиннее предела',
    );

    assert.equal(store.getTask(task.id).revision, task.revision, 'задача не изменена');
  });
});

/* ------------------------------------------------------------------ */
/* HTTP-контракт                                                        */
/* ------------------------------------------------------------------ */

const config = {
  ...loadConfig({}),
  host: '127.0.0.1',
  port: 0,
  databaseFile: ':memory:',
  testing: true,
  allowFaults: true,
  clientDistDir: null,
};

let runtime: Runtime;
let cookie = '';

interface Response {
  status: number;
  body: any;
}

async function api(
  path: string,
  options: { method?: string; body?: unknown; withCookie?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.withCookie !== false && cookie !== '') headers.cookie = cookie;
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${runtime.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: payload,
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';')[0];
    if (pair) cookie = pair;
  }
  return { status: response.status, body: await response.json() };
}

async function bootstrap(): Promise<void> {
  const res = await api('/api/dev/bootstrap', {
    method: 'POST',
    body: { password: PASSWORD, timezone: 'Europe/Kyiv' },
  });
  assert.equal(res.status, 200);
}

async function createTask(body: Record<string, unknown>): Promise<any> {
  const res = await api('/api/tasks', { method: 'POST', body });
  assert.equal(res.status, 201);
  return res.body.data.task;
}

before(async () => {
  runtime = await startRuntime(config);
  await bootstrap();
});

after(async () => {
  await runtime.close();
});

describe('HTTP: синхронизация задачи', () => {
  it('без сессии путь закрыт', async () => {
    const task = await createTask({ text: 'Согласовать график', day: '2026-11-14' });

    const res = await api(`/api/sync/tasks/${task.id}`, {
      method: 'POST',
      body: { base: { day: '2026-11-14' }, changes: { day: '2026-11-15' } },
      withCookie: false,
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: { code: 'unauthorized', message: 'Нужно войти.' } });

    const list = await api('/api/tasks?show_completed=1&show_removed=1', { withCookie: false });
    assert.equal(list.status, 401);

    const still = await api(`/api/tasks/${task.id}`);
    assert.equal(still.body.data.task.day, '2026-11-14', 'без входа ничего не изменилось');
  });

  it('чтение списка и одной задачи остаётся прежним протоколом', async () => {
    const task = await createTask({ text: 'Согласовать график', day: '2026-11-14' });

    const list = await api('/api/tasks?show_completed=1&show_removed=1');
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert.ok(Array.isArray(list.body.data.tasks));
    assert.ok(list.body.data.tasks.some((item: any) => item.id === task.id));

    const one = await api(`/api/tasks/${task.id}`);
    assert.equal(one.status, 200);
    assert.deepEqual(one.body, { ok: true, data: { task: one.body.data.task } });
    assert.equal(one.body.data.task.day, '2026-11-14');
  });

  it('успешная синхронизация отдаёт задачу', async () => {
    const task = await createTask({ text: 'Согласовать график', day: '2026-11-14' });

    const res = await api(`/api/sync/tasks/${task.id}`, {
      method: 'POST',
      body: { base: { day: '2026-11-14' }, changes: { day: '2026-11-15' } },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['ok', 'data']);
    assert.deepEqual(Object.keys(res.body.data), ['task']);
    assert.equal(res.body.data.task.day, '2026-11-15');
    assert.equal(res.body.data.task.revision, task.revision + 1);
  });

  it('конфликт отдаёт 409 с задачей и списком полей', async () => {
    const task = await createTask({ text: 'Согласовать график', day: '2026-11-14' });
    const moved = await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { day: '2026-11-20' } });
    assert.equal(moved.status, 200);

    const res = await api(`/api/sync/tasks/${task.id}`, {
      method: 'POST',
      body: { base: { day: '2026-11-14' }, changes: { day: '2026-11-15' } },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.ok, undefined);
    assert.equal(res.body.error.code, 'sync_conflict');
    assert.equal(typeof res.body.error.message, 'string');
    assert.ok(res.body.error.message.length > 0);
    assert.deepEqual(res.body.data.conflicts, ['day']);
    assert.equal(res.body.data.task.day, '2026-11-20');
    assert.equal(res.body.data.task.revision, moved.body.data.task.revision);
  });

  it('повтор и принятие версии сервера не увеличивают ревизию', async () => {
    const task = await createTask({ text: 'Согласовать график', day: '2026-11-14' });
    const body = { base: { day: '2026-11-14' }, changes: { day: '2026-11-15' } };

    const first = await api(`/api/sync/tasks/${task.id}`, { method: 'POST', body });
    assert.equal(first.status, 200);

    const second = await api(`/api/sync/tasks/${task.id}`, { method: 'POST', body });
    assert.equal(second.status, 200);
    assert.equal(second.body.data.task.revision, first.body.data.task.revision);

    const accepted = await api(`/api/sync/tasks/${task.id}`, {
      method: 'POST',
      body: { base: { day: '2026-11-15' }, changes: { day: '2026-11-15' } },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.task.revision, first.body.data.task.revision);
  });

  it('удалённая задача даёт 404, а очередь клиента остаётся до решения', async () => {
    const task = await createTask({ text: 'Согласовать график', day: '2026-11-14' });
    const body = { base: { day: '2026-11-14' }, changes: { day: '2026-11-15' } };
    const removed = await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);

    const res = await api(`/api/sync/tasks/${task.id}`, { method: 'POST', body });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
    assert.equal(res.body.data, undefined, 'в ошибке нет данных удалённой задачи');

    const again = await api(`/api/sync/tasks/${task.id}`, { method: 'POST', body });
    assert.equal(again.status, 404, 'повторный запрос с тем же телом даёт тот же ответ');
  });

  it('неверное тело отклоняется до обращения к задаче', async () => {
    const task = await createTask({ text: 'Согласовать график', day: '2026-11-14' });

    const cases: unknown[] = [
      {},
      { base: { day: '2026-11-14' } },
      { changes: { day: '2026-11-15' } },
      { base: {}, changes: {} },
      { base: { day: '2026-11-14' }, changes: { day: '2026-11-15', text: 'Другой' } },
      { base: { status: 'ready' }, changes: { status: 'paused' } },
      { base: { day: '2026-11-14' }, changes: { day: 'не дата' } },
      { base: { text: 'Согласовать график' }, changes: { text: '' } },
    ];
    for (const body of cases) {
      const res = await api(`/api/sync/tasks/${task.id}`, { method: 'POST', body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(
        ['invalid_request', 'invalid_date', 'empty_text'].includes(res.body.error.code),
        JSON.stringify(body),
      );
    }

    const after = await api(`/api/tasks/${task.id}`);
    assert.equal(after.body.data.task.revision, task.revision, 'задача не изменена');
  });
});
