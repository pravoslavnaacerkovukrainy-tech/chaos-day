import { test, expect, type Page } from '@playwright/test';
import { bootstrap, card, login, navigate } from './helpers';

// Открытый в браузере редактор не должен затирать правку, сделанную в другом месте
// (например, на Mac) после его открытия. Все данные синтетические.

type ApiTask = { id: string; text: string; details: string | null; revision: number; steps: Array<{ id: string; text: string; completed_at: string | null }> };

async function createTaskWithSteps(page: Page, text: string): Promise<ApiTask> {
  const created = await page.request.post('/api/tasks', { data: { text, area: 'personal', day: '' } });
  expect(created.status()).toBe(201);
  const task = (await created.json()).data.task as ApiTask;
  const steps = await page.request.post(`/api/tasks/${task.id}/steps`, {
    data: {
      steps: [
        { id: crypto.randomUUID(), text: 'Вымышленный шаг один', completed_at: null },
        { id: crypto.randomUUID(), text: 'Вымышленный шаг два', completed_at: '2026-01-01T09:00:00.000Z' },
      ],
      base_revision: task.revision,
    },
  });
  expect(steps.status()).toBe(200);
  // Задача создана в обход интерфейса: загружаем страницу заново, чтобы клиент её увидел.
  await page.reload();
  await expect(page.getByTestId('logout')).toHaveCount(1);
  return getTask(page, task.id);
}

async function getTask(page: Page, id: string): Promise<ApiTask> {
  const response = await page.request.get(`/api/tasks/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data.task as ApiTask;
}

async function openEditor(page: Page, text: string) {
  await navigate(page, 'Все задачи');
  await card(page, text).getByTestId('task-edit').click();
  const dialog = page.getByTestId('task-editor');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('редактор отправляет версию открытой задачи и не трогает шаги', async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  const text = 'Синтетическая задача с шагами';
  const before = await createTaskWithSteps(page, text);
  expect(typeof before.revision).toBe('number');

  const dialog = await openEditor(page, text);
  await dialog.getByTestId('task-extra').click();
  await dialog.getByTestId('task-details-input').fill('Синтетическая заметка из браузера');

  const patch = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/tasks/${before.id}`);
  await dialog.getByTestId('task-save').click();
  const body = (await patch).postDataJSON();
  expect(body.base_revision).toBe(before.revision);
  expect(body).not.toHaveProperty('steps');
  await expect(dialog).toHaveCount(0);

  const after = await getTask(page, before.id);
  expect(after.details).toBe('Синтетическая заметка из браузера');
  expect(after.steps).toEqual(before.steps);
});

test('устаревший редактор получает отказ, черновик остаётся, повтора нет', async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  const text = 'Синтетическая задача для конфликта';
  const before = await createTaskWithSteps(page, text);

  const dialog = await openEditor(page, text);

  // Правка «с другого устройства» уже после открытия окна.
  const otherText = 'Синтетическая правка с другого устройства';
  const remote = await page.request.patch(`/api/tasks/${before.id}`, {
    data: { text: otherText, base_revision: before.revision },
  });
  expect(remote.status()).toBe(200);
  const remoteTask = (await remote.json()).data.task as ApiTask;

  const draftText = 'Синтетический черновик из старого окна';
  const draftDetails = 'Несохранённые синтетические подробности';
  await dialog.getByTestId('task-text-input').fill(draftText);
  await dialog.getByTestId('task-extra').click();
  await dialog.getByTestId('task-details-input').fill(draftDetails);

  let patches = 0;
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/tasks/')) patches += 1;
  });
  const response = page.waitForResponse((r) => r.request().method() === 'PATCH');
  await dialog.getByTestId('task-save').click();
  expect((await response).status()).toBe(409);

  const alert = dialog.getByTestId('task-editor-error');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Задачу изменили в другом месте');
  await expect(alert).toContainText('Ваши правки не сохранены и остались в полях ниже');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('task-text-input')).toHaveValue(draftText);
  await expect(dialog.getByTestId('task-details-input')).toHaveValue(draftDetails);
  await expect(dialog.getByTestId('task-save')).toBeDisabled();

  // Ни Ctrl+Enter, ни ожидание не отправляют черновик повторно.
  await dialog.getByTestId('task-text-input').press('Control+Enter');
  await page.waitForTimeout(500);
  expect(patches).toBe(1);

  const after = await getTask(page, before.id);
  expect(after.text).toBe(otherText);
  expect(after.revision).toBe(remoteTask.revision);
  expect(after.details).toBeNull();
  expect(after.steps).toEqual(before.steps);

  // После закрытия и повторного открытия видна свежая версия, и её можно сохранить.
  await dialog.getByTestId('task-cancel').click();
  await expect(dialog).toHaveCount(0);
  const fresh = await openEditor(page, otherText);
  await expect(fresh.getByTestId('task-text-input')).toHaveValue(otherText);
  await fresh.getByTestId('task-extra').click();
  await fresh.getByTestId('task-details-input').fill(draftDetails);
  await fresh.getByTestId('task-save').click();
  await expect(fresh).toHaveCount(0);
  const merged = await getTask(page, before.id);
  expect(merged).toMatchObject({ text: otherText, details: draftDetails });
  expect(merged.steps).toEqual(before.steps);
});
