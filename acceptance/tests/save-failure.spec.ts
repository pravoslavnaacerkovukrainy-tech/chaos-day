import { test, expect } from '@playwright/test';
import { addChaos, bootstrap, card, login, snapshot } from './helpers';

test('ошибка сохранения откатывает разбор, а повтор успешно сохраняет задачу', async ({ page, request }) => {
  await bootstrap(request);
  await login(page);

  const text = 'Синтетическая строка для ошибки записи';
  await addChaos(page, text);
  const chaosID = (await snapshot(page)).chaos.find((item) => item.text === text)?.id;
  expect(chaosID).toBeDefined();

  const fault = await page.request.post('/api/dev/fault', { data: { inject: 'save', times: 1 } });
  expect(fault.status()).toBe(200);

  await card(page, text).getByTestId('chaos-to-task').click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();

  let state = await snapshot(page);
  expect(state.chaos.find((item) => item.text === text)?.id).toBe(chaosID);
  expect(state.tasks.filter((item) => item.text === text)).toHaveLength(0);
  await expect(card(page, text)).toBeVisible();

  await card(page, text).getByTestId('chaos-to-task').click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  state = await snapshot(page);
  expect(state.chaos.find((item) => item.id === chaosID)).toBeUndefined();
  expect(state.tasks.filter((item) => item.text === text)).toHaveLength(1);
});
