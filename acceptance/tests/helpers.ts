import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

export const password = 'acceptance-only-2026';

export type Snapshot = {
  timezone: string;
  today: string;
  now: string;
  chaos: Array<{ id: string; text: string; urgent: boolean }>;
  tasks: Array<{
    id: string;
    text: string;
    day: string;
    deadline: string | null;
    review_date: string | null;
    promised_to: string | null;
    at_risk: boolean;
    status: string;
    completed_at: string | null;
  }>;
  entries: Array<{ id: string; text: string; context: string | null; plan_id: string | null; day: string }>;
  notes: Array<{ id: string; title: string }>;
  projects: Array<{ id: string; title: string }>;
  note_folders: Array<{ id: string; name: string; parent_id: string | null }>;
};

const routes: Record<string, string> = {
  'Место хаоса': 'chaos',
  План: 'plan',
  Проекты: 'projects',
  Ожидаю: 'waiting',
  Обзор: 'review',
  'Все задачи': 'tasks',
  Заметки: 'notes',
  Дневник: 'diary',
  'Импорт и экспорт': 'data',
};

export async function bootstrap(request: APIRequestContext) {
  const response = await request.post('/api/dev/bootstrap', {
    data: { password, timezone: 'Europe/Kyiv' },
  });
  expect(response.status()).toBe(200);
}

export function navigation(page: Page, name: string) {
  const route = routes[name];
  if (!route) throw new Error(`Неизвестный раздел: ${name}`);
  return page.getByTestId(`nav-${route}`);
}

export async function navigate(page: Page, name: string) {
  const target = navigation(page, name);
  if (!(await page.getByTestId('logout').isVisible())) {
    await page.getByTestId('nav-toggle').click();
  }
  await target.click();
  await expect(page.getByTestId(`view-${routes[name]}`)).toBeVisible();
}

export async function login(page: Page) {
  await page.goto('/');
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-form')).toHaveCount(0);
  await expect(page.getByTestId('logout')).toHaveCount(1);
}

export async function snapshot(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/state');
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

export function card(page: Page, text: string): Locator {
  return page
    .getByTestId('chaos-item')
    .or(page.getByTestId('task-row'))
    .filter({ hasText: text })
    .first();
}

export async function addChaos(page: Page, text: string) {
  await navigate(page, 'Место хаоса');
  await page.getByTestId('chaos-input').fill(text);
  await page.getByTestId('chaos-save').click();
  await expect(card(page, text)).toBeVisible();
}

export async function importFile(page: Page, path: string) {
  await navigate(page, 'Импорт и экспорт');
  await page.getByTestId('import-file').setInputFiles(path);
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/import' && response.request().method() === 'POST',
  );
  await page.getByTestId('import-submit').click();
  return responsePromise;
}

export function shiftDay(day: string, amount: number) {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
