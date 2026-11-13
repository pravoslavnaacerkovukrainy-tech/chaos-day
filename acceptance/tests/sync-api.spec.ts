import { expect, test, type APIRequestContext } from '@playwright/test';
import { bootstrap } from './helpers';

type Task = {
  id: string;
  day: string;
  text: string;
  details: string | null;
  revision: number;
  updated_at: string;
};

async function createTask(request: APIRequestContext): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: {
      text: 'Синтетическая задача синхронизации',
      area: 'personal',
      day: '2026-11-14',
      details: 'Исходные подробности',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data.task;
}

async function sync(request: APIRequestContext, id: string, body: unknown) {
  return request.post(`/api/sync/tasks/${id}`, { data: body });
}

test.beforeEach(async ({ request }) => {
  await bootstrap(request);
});

test('sync применяет все поддерживаемые поля и подтверждает повтор без новой ревизии', async ({ request }) => {
  const task = await createTask(request);
  const body = {
    base: { day: task.day, text: task.text, details: task.details },
    changes: { day: '', text: 'Изменено на Mac', details: null },
  };

  const changed = await sync(request, task.id, body);
  expect(changed.status()).toBe(200);
  const changedTask = (await changed.json()).data.task as Task;
  expect(changedTask).toMatchObject(body.changes);
  expect(changedTask.revision).toBeGreaterThan(task.revision);

  const repeated = await sync(request, task.id, body);
  expect(repeated.status()).toBe(200);
  const repeatedTask = (await repeated.json()).data.task as Task;
  expect(repeatedTask.revision).toBe(changedTask.revision);
  expect(repeatedTask.updated_at).toBe(changedTask.updated_at);

  const list = await request.get('/api/tasks?show_completed=1&show_removed=1');
  expect(list.status()).toBe(200);
  expect((await list.json()).data.tasks.filter((item: Task) => item.id === task.id)).toHaveLength(1);

  const fetched = await request.get(`/api/tasks/${task.id}`);
  expect(fetched.status()).toBe(200);
  expect((await fetched.json()).data.task).toMatchObject(body.changes);
});

test('sync применяет независимые поля, но конфликт одного поля откатывает всю правку', async ({ request }) => {
  const independent = await createTask(request);
  const server = await request.patch(`/api/tasks/${independent.id}`, { data: { text: 'Правка браузера' } });
  expect(server.status()).toBe(200);
  const merged = await sync(request, independent.id, {
    base: { day: independent.day, details: independent.details },
    changes: { day: '2026-11-15', details: 'Правка Mac' },
  });
  expect(merged.status()).toBe(200);
  expect((await merged.json()).data.task).toMatchObject({
    day: '2026-11-15',
    details: 'Правка Mac',
    text: 'Правка браузера',
  });

  const conflicted = await createTask(request);
  const serverConflict = await request.patch(`/api/tasks/${conflicted.id}`, { data: { day: '2026-11-16' } });
  const serverTask = (await serverConflict.json()).data.task as Task;
  const rejected = await sync(request, conflicted.id, {
    base: { day: conflicted.day, text: conflicted.text, details: conflicted.details },
    changes: { day: '2026-11-15', text: 'Недопустимая частичная правка', details: null },
  });
  expect(rejected.status()).toBe(409);
  const rejectedBody = await rejected.json();
  expect(rejectedBody.error.code).toBe('sync_conflict');
  expect(rejectedBody.error.message).toEqual(expect.any(String));
  expect(rejectedBody.data.conflicts).toEqual(['day']);
  expect(rejectedBody.data.task).toMatchObject({
    day: serverTask.day,
    text: conflicted.text,
    details: conflicted.details,
    revision: serverTask.revision,
  });
});

test('sync требует сессию, возвращает 404 после удаления и проверяет набор полей', async ({ request, playwright, baseURL }) => {
  const task = await createTask(request);
  const body = { base: { day: task.day }, changes: { day: '2026-11-15' } };
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    const unauthorized = await anonymous.post(`/api/sync/tasks/${task.id}`, { data: body });
    expect(unauthorized.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  for (const invalid of [
    {},
    { base: {}, changes: {} },
    { base: { day: task.day }, changes: { day: '2026-11-15', text: 'Лишний ключ' } },
    { base: { day: task.day }, changes: { day: '2026-02-30' } },
    { base: { status: 'ready' }, changes: { status: 'paused' } },
  ]) {
    const response = await sync(request, task.id, invalid);
    expect(response.status()).toBe(400);
  }

  const removed = await request.delete(`/api/tasks/${task.id}`);
  expect(removed.status()).toBe(200);
  const missing = await sync(request, task.id, body);
  expect(missing.status()).toBe(404);
});
