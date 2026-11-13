import { test, expect, type Page } from '@playwright/test';
import { bootstrap, login } from './helpers';

const DARK_CANVAS = 'rgb(19, 26, 34)';
const LIGHT_CANVAS = 'rgb(238, 242, 246)';

async function canvas(page: Page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function expectTheme(page: Page, theme: 'dark' | 'light') {
  await expect.poll(() => canvas(page)).toBe(theme === 'dark' ? DARK_CANVAS : LIGHT_CANVAS);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme);
  expect(await page.locator('meta[name="color-scheme"]').getAttribute('content')).toBe(theme);
  await expect(page.getByTestId(`theme-${theme}`)).toHaveAttribute('aria-checked', 'true');
}

test.beforeEach(async ({ request }) => {
  await bootstrap(request);
});

test('тёмная по умолчанию даже при светлой ОС; выбор на экране входа сохраняется', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expectTheme(page, 'dark');

  await page.getByTestId('theme-light').click();
  await expectTheme(page, 'light');

  await page.reload();
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expectTheme(page, 'light');
});

test('широкое окно: переключатель в боковой панели, выбор переживает обновление, новую вкладку и выход', async ({ page, context }) => {
  await login(page);
  await expectTheme(page, 'dark');
  await expect(page.getByTestId('theme-switch')).toBeVisible();

  await page.getByTestId('theme-light').click();
  await expectTheme(page, 'light');
  // Нативные поля следуют теме.
  expect(await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'date';
    document.body.append(input);
    const scheme = getComputedStyle(input).colorScheme;
    input.remove();
    return scheme;
  })).toBe('light');

  await page.reload();
  await expectTheme(page, 'light');

  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByTestId('logout')).toHaveCount(1);
  await expectTheme(second, 'light');
  await second.close();

  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expectTheme(page, 'light');

  await page.getByTestId('theme-dark').click();
  await expectTheme(page, 'dark');
  await page.reload();
  await expectTheme(page, 'dark');
});

test('узкое окно: переключатель в перечне разделов, стрелки меняют выбор', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByTestId('nav-toggle').click();
  await expect(page.getByTestId('theme-switch')).toBeVisible();

  await page.getByTestId('theme-dark').focus();
  await page.keyboard.press('ArrowRight');
  await expectTheme(page, 'light');
  await expect(page.getByTestId('theme-light')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expectTheme(page, 'dark');
});

test('сохранённая светлая ставится до первой отрисовки, без вспышки тёмной', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('theme-light').click();

  await page.addInitScript(() => {
    const seen: Array<{ theme: string; bodyExists: boolean }> = [];
    (window as unknown as { __themeLog: typeof seen }).__themeLog = seen;
    new MutationObserver(() => {
      seen.push({ theme: document.documentElement.dataset.theme ?? 'dark', bodyExists: document.body !== null });
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme'] });
  });
  await page.reload();
  await expectTheme(page, 'light');
  const log = await page.evaluate(() => (window as unknown as { __themeLog: Array<{ theme: string; bodyExists: boolean }> }).__themeLog);
  expect(log.length).toBeGreaterThan(0);
  expect(log[0]).toEqual({ theme: 'light', bodyExists: false });
  expect(log.every((entry) => entry.theme === 'light')).toBe(true);
});
