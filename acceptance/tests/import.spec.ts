import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, importFile, login, navigate, snapshot } from './helpers';

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name);

function identities(state: Awaited<ReturnType<typeof snapshot>>) {
  const keys = ['chaos', 'tasks', 'entries', 'notes', 'projects', 'note_folders'] as const;
  return Object.fromEntries(
    keys.map((key) => [key, state[key].map((item) => item.id).sort()]),
  ) as Record<string, string[]>;
}

test('старый Mac v1 импортируется в пустое хранилище и повторно без копий', async ({ page, request }) => {
  await bootstrap(request);
  await login(page);

  let response = await importFile(page, fixture('mac-v1-entries-only.json'));
  expect(response.status()).toBe(200);
  let state = await snapshot(page);
  expect(state.entries).toHaveLength(1);
  expect(state.entries[0]).toMatchObject({
    id: '11111111-1111-1111-1111-111111111111',
    text: 'Вымышленная запись старого формата',
    context: 'Синтетическая точка остановки',
    day: '2026-11-12',
  });
  const before = identities(state);

  response = await importFile(page, fixture('mac-v1-entries-only.json'));
  expect(response.status()).toBe(200);
  const report = (await response.json()).data;
  expect(Object.values(report.added).every((count) => count === 0)).toBe(true);
  state = await snapshot(page);
  expect(identities(state)).toEqual(before);
  expect(state.entries).toHaveLength(1);

  await navigate(page, 'Дневник');
  await page.getByTestId('diary-date').fill('2026-11-12');
  await expect(page.getByText('Вымышленная запись старого формата', { exact: true })).toBeVisible();
  await expect(page.getByText('Синтетическая точка остановки', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByTestId('diary-date').fill('2026-11-12');
  await expect(page.getByText('Вымышленная запись старого формата', { exact: true })).toBeVisible();
});

test('новый Mac v9 сохраняет задачи, заметки, дни, связи и календарные даты без дублей', async ({ page, request }) => {
  await bootstrap(request);
  await login(page);

  let response = await importFile(page, fixture('mac-v9-note-folder-tree.json'));
  expect(response.status()).toBe(200);
  let state = await snapshot(page);
  expect(state.tasks).toHaveLength(4);
  expect(state.notes).toHaveLength(1);
  expect(state.projects).toHaveLength(1);
  expect(state.chaos).toHaveLength(1);
  expect(state.entries).toHaveLength(2);
  expect(state.note_folders).toHaveLength(2);
  expect(state.tasks.find((item) => item.id === '22222222-2222-2222-2222-222222222221')).toMatchObject({
    text: 'Синтетическая задача v9',
    day: '2026-11-13',
    deadline: '2026-11-15',
    review_date: '2026-11-14',
    promised_to: 'Выдуманный адресат',
    at_risk: true,
  });
  expect(state.tasks.find((item) => item.id === '22222222-2222-2222-2222-222222222224')?.completed_at).not.toBeNull();
  expect(state.entries.find((entry) => entry.plan_id === '22222222-2222-2222-2222-222222222224')?.text).not.toContain('Выдуманный адресат');
  const before = identities(state);

  response = await importFile(page, fixture('mac-v9-note-folder-tree.json'));
  expect(response.status()).toBe(200);
  const report = (await response.json()).data;
  expect(Object.values(report.added).every((count) => count === 0)).toBe(true);
  expect(identities(await snapshot(page))).toEqual(before);

  await navigate(page, 'Все задачи');
  await expect(page.getByText('Синтетическая задача v9', { exact: true })).toBeVisible();
  await navigate(page, 'Заметки');
  await expect(page.getByText('Синтетическая заметка v9', { exact: true })).toBeVisible();
  await navigate(page, 'Дневник');
  await page.getByTestId('diary-date').fill('2026-11-12');
  await expect(page.getByText('Вымышленный факт v9', { exact: true })).toBeVisible();

  await page.reload();
  state = await snapshot(page);
  expect(identities(state)).toEqual(before);
});

test('неизвестный более новый формат отклоняется целиком с объяснением', async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  const before = identities(await snapshot(page));

  const response = await importFile(page, fixture('mac-v10-unsupported.json'));
  expect(response.status()).toBe(422);
  const body = await response.json();
  expect(body.error.code).toBe('unsupported_format');
  expect(body.error.message).toMatch(/10/);
  expect(body.error.message).toMatch(/9/);
  await expect(page.getByTestId('import-error')).toContainText(body.error.message);
  expect(identities(await snapshot(page))).toEqual(before);
});
