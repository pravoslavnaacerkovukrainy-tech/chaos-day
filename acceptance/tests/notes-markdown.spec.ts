import { test, expect, type Page } from '@playwright/test';
import { bootstrap, login, navigate } from './helpers';

// Вымышленные заметки; внешние адреса — только example.org, запросов к ним быть не должно.
const MARKDOWN = [
  '## План встречи',
  '',
  'Обсудить **сроки** и _риски_, см. [документ](https://example.org/doc).',
  '',
  '- первый пункт',
  '- второй пункт',
  '',
  '1. шаг один',
  '2. шаг два',
  '',
  '> Важно не забыть',
  '',
  'Строка с `кодом` внутри.',
  '',
  '```',
  'const очень_длинная_строка_кода = "' + 'x'.repeat(220) + '";',
  '```',
  '',
  '| Колонка | ' + Array.from({ length: 12 }, (_, i) => `Длинный заголовок ${i + 1}`).join(' | ') + ' |',
  '|---|' + '---|'.repeat(12),
  '| a | ' + Array.from({ length: 12 }, (_, i) => `значение ${i + 1}`).join(' | ') + ' |',
  '',
  '![схема](https://example.org/scheme.png)',
].join('\n');

const HOSTILE = [
  '<script>window.__pwned = 1</script>',
  '',
  '<img src="https://example.org/pixel.png" onerror="window.__pwned = 2">',
  '',
  '[опасная](javascript:window.__pwned=3) <b onclick="window.__pwned=4">жирный?</b>',
].join('\n');

type FullNote = { id: string; title: string; body: string };

async function notes(page: Page): Promise<FullNote[]> {
  const response = await page.request.get('/api/state');
  expect(response.status()).toBe(200);
  return (await response.json()).data.notes;
}

function watchExternal(page: Page) {
  const external: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).hostname.endsWith('example.org')) external.push(r.url());
  });
  return external;
}

async function noHorizontalPageScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, 'страница не растягивается по ширине').toBeLessThanOrEqual(client);
}

test.beforeEach(async ({ request }) => {
  await bootstrap(request);
});

test('новая заметка: Просмотр до сохранения, сохранение, повторное открытие', async ({ page }) => {
  const external = watchExternal(page);
  await login(page);
  await navigate(page, 'Заметки');
  await page.getByTestId('note-new').click();

  await page.getByTestId('note-title-input').fill('Встреча');
  await page.getByTestId('note-body-input').fill(MARKDOWN);

  // Несохранённая заметка открывается в Просмотре без потери текста.
  await page.getByTestId('note-mode-view').click();
  await expect(page.getByTestId('note-mode-view')).toHaveAttribute('aria-selected', 'true');
  const view = page.getByTestId('note-rendered');
  await expect(view.locator('h2')).toHaveText('План встречи');
  await expect(view.locator('strong')).toHaveText('сроки');
  await expect(view.locator('em')).toHaveText('риски');
  await expect(view.locator('ul > li')).toHaveCount(2);
  await expect(view.locator('ol > li')).toHaveCount(2);
  await expect(view.locator('blockquote')).toContainText('Важно не забыть');
  await expect(view.locator('p code')).toHaveText('кодом');
  await expect(view.locator('pre code')).toContainText('очень_длинная_строка_кода');
  await expect(view.locator('table th')).toHaveCount(13);
  const link = view.getByRole('link', { name: 'документ' });
  await expect(link).toHaveAttribute('href', 'https://example.org/doc');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  // Картинка — ссылка, а не загрузка.
  await expect(view.locator('img')).toHaveCount(0);
  await expect(view.getByRole('link', { name: 'Картинка: схема' })).toHaveAttribute('href', 'https://example.org/scheme.png');
  await expect(page.getByTestId('note-unsaved')).toBeVisible();
  await noHorizontalPageScroll(page);

  await page.getByTestId('note-mode-edit').click();
  await expect(page.getByTestId('note-body-input')).toHaveValue(MARKDOWN);
  await expect(page.getByTestId('note-title-input')).toHaveValue('Встреча');

  await page.getByTestId('note-save').click();
  await expect(page.getByTestId('note-view')).toBeVisible();
  await expect(page.getByTestId('note-unsaved')).toHaveCount(0);

  // Сохраняется сырой Markdown, без преобразований.
  const saved = await notes(page);
  expect(saved).toHaveLength(1);
  expect(saved[0]!.body).toBe(MARKDOWN);
  expect(saved[0]!.title).toBe('Встреча');

  await page.reload();
  await expect(page.getByTestId('logout')).toHaveCount(1);
  await navigate(page, 'Заметки');
  await page.getByTestId('note-item').filter({ hasText: 'Встреча' }).click();
  // Сохранённая заметка открывается в Просмотре.
  await expect(page.getByTestId('note-mode-view')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('note-rendered').locator('h2')).toHaveText('План встречи');
  await page.getByTestId('note-mode-edit').click();
  await expect(page.getByTestId('note-body-input')).toHaveValue(MARKDOWN);

  // Поиск по заметкам ищет по исходному тексту.
  await page.getByTestId('notes-search').fill('второй пункт');
  await expect(page.getByTestId('note-item')).toHaveCount(1);

  expect(external, 'из заметки ничего не загружается').toEqual([]);
});

test('HTML в заметке показывается текстом и не исполняется', async ({ page }) => {
  const external = watchExternal(page);
  await login(page);
  const created = await page.request.post('/api/notes', { data: { title: 'Опасная', body: HOSTILE, folder_id: null } });
  expect(created.status()).toBeLessThan(300);
  await page.reload();
  await expect(page.getByTestId('logout')).toHaveCount(1);
  await navigate(page, 'Заметки');
  await page.getByTestId('note-item').filter({ hasText: 'Опасная' }).click();

  const view = page.getByTestId('note-rendered');
  await expect(view).toContainText('<script>window.__pwned = 1</script>');
  await expect(view).toContainText('<img src="https://example.org/pixel.png"');
  await expect(view).toContainText('<b onclick="window.__pwned=4">жирный?</b>');
  await expect(view.locator('script, img, b, [onclick], [onerror]')).toHaveCount(0);
  await expect(view.locator('a[href^="javascript"]')).toHaveCount(0);
  await view.getByText('опасная', { exact: false }).first().click();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(external).toEqual([]);
});

test('старая запись без Markdown сохраняет одиночные переносы', async ({ page }) => {
  await login(page);
  const body = 'Первая строка\nвторая строка\nтретья';
  await page.request.post('/api/notes', { data: { title: 'Старая', body, folder_id: null } });
  await page.reload();
  await expect(page.getByTestId('logout')).toHaveCount(1);
  await navigate(page, 'Заметки');
  await page.getByTestId('note-item').filter({ hasText: 'Старая' }).click();
  const view = page.getByTestId('note-rendered');
  await expect(view.locator('br')).toHaveCount(2);
  const lines = await view.evaluate((el) => (el as HTMLElement).innerText.split('\n').filter(Boolean));
  expect(lines).toEqual(['Первая строка', 'вторая строка', 'третья']);
});

test('панель форматирования: выделение, клавиши, подписи', async ({ page }) => {
  await login(page);
  await navigate(page, 'Заметки');
  await page.getByTestId('note-new').click();
  const area = page.getByTestId('note-body-input');
  await area.fill('мой текст');

  const bar = page.getByRole('toolbar', { name: 'Форматирование Markdown' });
  await expect(bar.getByRole('button', { name: 'Жирный' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Маркированный список' })).toBeVisible();

  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 9));
  await bar.getByRole('button', { name: 'Жирный' }).click();
  await expect(area).toHaveValue('мой **текст**');
  await expect(area).toBeFocused();
  // Повторное нажатие снимает выделение жирным.
  await bar.getByRole('button', { name: 'Жирный' }).click();
  await expect(area).toHaveValue('мой текст');

  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 3));
  await area.press('ControlOrMeta+i');
  await expect(area).toHaveValue('_мой_ текст');

  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, el.value.length));
  await bar.getByRole('button', { name: 'Маркированный список' }).click();
  await expect(area).toHaveValue('- _мой_ текст');

  // Правка через панель отменяется обычным ⌘Z/Ctrl+Z.
  await area.press('ControlOrMeta+z');
  await expect(area).toHaveValue('_мой_ текст');

  // Одна остановка Tab на панель, внутри — стрелки.
  const first = bar.getByRole('button', { name: 'Заголовок' });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', { name: 'Жирный' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(bar.getByRole('button', { name: 'Ссылка' })).toBeFocused();

  // Черновик переживает Просмотр, затем сохраняется.
  await page.getByTestId('note-mode-view').click();
  await expect(page.getByTestId('note-rendered').locator('em')).toHaveText('мой');
  await page.getByTestId('note-save').click();
  await expect.poll(async () => (await notes(page)).map((n) => n.body)).toEqual(['_мой_ текст']);
});

for (const theme of ['dark', 'light'] as const) {
  test(`узкое окно, ${theme === 'dark' ? 'тёмная' : 'светлая'} тема: таблица и код прокручиваются внутри заметки`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    if (theme === 'light') {
      await page.getByTestId('nav-toggle').click();
      await page.getByTestId('theme-light').click();
      // Перечень разделов закроется перезагрузкой ниже; тема сохраняется.
    }
    await page.request.post('/api/notes', { data: { title: 'Широкая', body: MARKDOWN, folder_id: null } });
    await page.reload();
    await expect(page.getByTestId('logout')).toHaveCount(1);
    await navigate(page, 'Заметки');
    await page.getByTestId('note-item').filter({ hasText: 'Широкая' }).click();
    const view = page.getByTestId('note-rendered');
    await expect(view.locator('table')).toBeVisible();
    await noHorizontalPageScroll(page);

    const overflow = await view.evaluate((el) => {
      const table = el.querySelector('.md-table') as HTMLElement;
      const pre = el.querySelector('pre') as HTMLElement;
      const style = (e: Element) => getComputedStyle(e);
      return {
        tableScrolls: table.scrollWidth > table.clientWidth && style(table).overflowX === 'auto',
        preScrolls: pre.scrollWidth > pre.clientWidth && style(pre).overflowX === 'auto',
        text: style(el).color,
        link: style(el.querySelector('a')!).color,
        codeBg: style(pre).backgroundColor,
        pageBg: style(document.body).backgroundColor,
      };
    });
    expect(overflow.tableScrolls).toBe(true);
    expect(overflow.preScrolls).toBe(true);
    // Цвета из палитры приложения: --ink и --accent текущей темы.
    expect(overflow.text).toBe(theme === 'dark' ? 'rgb(227, 233, 239)' : 'rgb(22, 32, 43)');
    expect(overflow.link).toBe(theme === 'dark' ? 'rgb(114, 174, 234)' : 'rgb(29, 95, 163)');
    expect(overflow.codeBg).not.toBe(overflow.pageBg);

    // Редактор на узком экране тоже не шире окна.
    await page.getByTestId('note-mode-edit').click();
    await expect(page.getByTestId('note-format-bar')).toBeVisible();
    await noHorizontalPageScroll(page);
  });
}
