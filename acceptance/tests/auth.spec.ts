import { test, expect } from '@playwright/test';
import { bootstrap, login, navigation, password } from './helpers';

const privateNames = ['Место хаоса', 'План', 'Проекты', 'Ожидаю', 'Обзор', 'Все задачи', 'Заметки', 'Дневник'];

test('гость не получает состояние и не видит разделы; владелец входит и сохраняет сессию', async ({ page, request }) => {
  await bootstrap(request);

  const unauthorized = await page.request.get('/api/state');
  expect(unauthorized.status()).toBe(401);
  expect(await unauthorized.text()).not.toContain('Место хаоса');

  await page.goto('/');
  await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible();
  for (const name of privateNames) {
    await expect(navigation(page, name)).toHaveCount(0);
  }

  await page.getByLabel('Пароль', { exact: true }).fill('неверный-пароль');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Неверный пароль');

  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveCount(0);
  await expect(navigation(page, 'Место хаоса')).toBeVisible();
});
