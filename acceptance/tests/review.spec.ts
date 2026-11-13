import { test, expect } from '@playwright/test';
import { bootstrap, login, navigate } from './helpers';

const groups = [
  'Обещания со сроком',
  'Обещания без срока',
  'Под угрозой',
  'Сегодня и следующие шаги',
  'Ожидания',
  'Пересмотр',
];

test('пустой обзор сохраняет все шесть групп в фиксированном порядке', async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await navigate(page, 'Обзор');

  const headings = page.getByRole('heading').filter({ hasText: new RegExp(`^(${groups.join('|')})$`) });
  await expect(headings).toHaveCount(6);
  await expect(headings).toHaveText(groups);
  await expect(page.getByText('Сейчас здесь ничего нет', { exact: true })).toHaveCount(6);

  await page.reload();
  await expect(headings).toHaveText(groups);
  await expect(page.getByText('Сейчас здесь ничего нет', { exact: true })).toHaveCount(6);
});
