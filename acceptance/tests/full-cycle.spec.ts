import { test, expect } from '@playwright/test';
import { addChaos, bootstrap, card, login, navigate, shiftDay, snapshot } from './helpers';

for (const viewport of [
  { name: 'широкое окно', width: 1440, height: 1000 },
  { name: 'узкое окно', width: 390, height: 844 },
]) {
  test(`полный цикл: ${viewport.name}`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    await bootstrap(request);
    await login(page);

    const text = `Подготовить вымышленный отчёт — ${viewport.name}`;
    const promisedTo = 'Вымышленный коллега';
    await addChaos(page, text);
    const originalChaos = (await snapshot(page)).chaos.find((item) => item.text === text);
    expect(originalChaos).toBeDefined();

    await card(page, text).getByTestId('chaos-to-task').click();
    let dialog = page.getByTestId('task-editor');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('task-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(card(page, text)).toBeVisible();
    expect((await snapshot(page)).chaos.find((item) => item.text === text)?.id).toBe(originalChaos?.id);

    await card(page, text).getByTestId('chaos-to-task').click();
    dialog = page.getByTestId('task-editor');
    const today = (await snapshot(page)).today;
    const tomorrow = shiftDay(today, 1);
    const deadline = shiftDay(today, 3);
    const reviewDate = shiftDay(today, 2);
    await dialog.getByTestId('task-day-input').fill(today);
    await dialog.getByTestId('task-extra').click();
    await dialog.getByTestId('task-deadline-input').fill(deadline);
    await dialog.getByTestId('task-review-input').fill(reviewDate);
    await dialog.getByTestId('task-promised-input').fill(promisedTo);
    await dialog.getByTestId('task-details-input').fill('Только синтетические сведения');
    await dialog.getByTestId('task-save').click();
    await expect(dialog).toHaveCount(0);

    let state = await snapshot(page);
    expect(state.chaos.find((item) => item.id === originalChaos?.id)).toBeUndefined();
    const task = state.tasks.find((item) => item.text === text);
    expect(task).toMatchObject({ day: today, deadline, review_date: reviewDate, promised_to: promisedTo });

    await navigate(page, 'План');
    await expect(card(page, text)).toBeVisible();
    await card(page, text).getByTestId('task-reschedule').click();
    await card(page, text).getByTestId('reschedule-date').fill(tomorrow);
    await card(page, text).getByTestId('reschedule-apply').click();

    state = await snapshot(page);
    expect(state.tasks.find((item) => item.id === task?.id)).toMatchObject({
      day: tomorrow,
      deadline,
      review_date: reviewDate,
    });
    await expect(card(page, text)).toHaveCount(0);
    await expect(page.getByTestId('plan-empty')).toBeVisible();

    await navigate(page, 'Все задачи');
    await card(page, text).getByTestId('task-reschedule').click();
    await card(page, text).getByTestId('reschedule-today').click();
    await expect(card(page, text).getByTestId('task-day')).toContainText(/сегодня/i);

    await navigate(page, 'План');
    await expect(card(page, text)).toBeVisible();
    await card(page, text).getByTestId('task-complete').click();

    state = await snapshot(page);
    expect(state.tasks.find((item) => item.id === task?.id)?.completed_at).not.toBeNull();
    expect(state.entries.filter((entry) => entry.plan_id === task?.id)).toHaveLength(1);
    expect(state.entries.find((entry) => entry.plan_id === task?.id)?.text).not.toContain(promisedTo);

    const repeated = await page.request.post(`/api/tasks/${task?.id}/complete`);
    expect(repeated.status()).toBe(409);
    expect((await snapshot(page)).entries.filter((entry) => entry.plan_id === task?.id)).toHaveLength(1);

    await navigate(page, 'Дневник');
    await expect(page.getByTestId('diary-entry-text').filter({ hasText: text })).toHaveCount(1);
    await expect(page.getByText(promisedTo, { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('diary-entry-text').filter({ hasText: text })).toHaveCount(1);
    state = await snapshot(page);
    expect(state.tasks.find((item) => item.id === task?.id)?.day).toBe(today);
    expect(state.chaos).toHaveLength(0);

    const logout = page.getByTestId('logout');
    if (!(await logout.isVisible())) {
      await page.getByTestId('nav-toggle').click();
    }
    await expect(logout).toBeVisible();
    await logout.click();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('login-password')).toBeVisible();
    expect((await page.request.get('/api/state')).status()).toBe(401);
  });
}
