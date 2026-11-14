import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSafeHref, markdownToHtml } from '../client/src/markdown-core.ts';
import { applyEdit, formatEdit, type FormatAction } from '../client/src/markdown-format.ts';

describe('Markdown заметок: показ', () => {
  it('заголовки, выделение, списки, цитаты, код и таблицы', () => {
    const html = markdownToHtml([
      '# Первый', '## Второй', '', '**жирный** _курсив_ ~~зачёркнутый~~ `код`', '',
      '- раз', '- два', '', '1. один', '2. два', '', '> цитата', '',
      '```', 'const x = 1;', '```', '',
      '| A | B |', '|---|:-:|', '| 1 | 2 |',
    ].join('\n'));
    for (const part of ['<h1>Первый</h1>', '<h2>Второй</h2>', '<strong>жирный</strong>', '<em>курсив</em>', '<s>зачёркнутый</s>',
      '<code>код</code>', '<ul>', '<ol>', '<blockquote>', '<pre><code>const x = 1;', '<table>', '<div class="md-table"', 'style="text-align:center"']) {
      assert.ok(html.includes(part), `ожидалось ${part} в ${html}`);
    }
  });

  it('одиночный перенос строки остаётся переносом, как в старых записях', () => {
    assert.equal(markdownToHtml('первая\nвторая'), '<p>первая<br>\nвторая</p>\n');
  });

  it('HTML из заметки не интерпретируется', () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> <b>ж</b>');
    assert.ok(!/<script|<img|<b>/i.test(html), html);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('ссылки: только http(s) и mailto; внешние — в отдельном окне', () => {
    const html = markdownToHtml('[сайт](https://example.org) [почта](mailto:a@example.org)');
    assert.ok(html.includes('<a href="https://example.org" target="_blank" rel="noopener noreferrer nofollow">сайт</a>'), html);
    assert.ok(html.includes('<a href="mailto:a@example.org">почта</a>'), html);
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', '/relative', '//evil.example']) {
      const out = markdownToHtml(`[x](${bad})`);
      assert.ok(!out.includes('<a'), `${bad} → ${out}`);
    }
    assert.equal(isSafeHref(' \u0001javascript:alert(1)'), false);
    assert.equal(isSafeHref('https://example.org'), true);
  });

  it('голые адреса становятся ссылками', () => {
    assert.ok(markdownToHtml('см. https://example.org/a').includes('<a href="https://example.org/a" target="_blank"'));
  });

  it('картинки не загружаются: вместо <img> — ссылка', () => {
    const html = markdownToHtml('![схема](https://example.org/x.png) ![плохая](javascript:alert(1))');
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('<a class="md-image" href="https://example.org/x.png" target="_blank" rel="noopener noreferrer nofollow">Картинка: схема</a>'), html);
    assert.ok(!html.includes('javascript:" '), html);
  });
});

function run(action: FormatAction, text: string, start: number, end = start) {
  const e = formatEdit(action, text, start, end);
  const value = applyEdit(text, e);
  return { value, sel: value.slice(e.selStart, e.selEnd), selStart: e.selStart, selEnd: e.selEnd };
}

describe('Markdown заметок: панель форматирования', () => {
  it('жирный оборачивает выделение и снимается повторно', () => {
    const on = run('bold', 'мой текст', 4, 9);
    assert.equal(on.value, 'мой **текст**');
    assert.equal(on.sel, 'текст');
    const off = run('bold', on.value, on.selStart, on.selEnd);
    assert.equal(off.value, 'мой текст');
    assert.equal(off.sel, 'текст');
  });

  it('без выделения вставляет заготовку и выделяет её', () => {
    const r = run('italic', 'а ', 2);
    assert.equal(r.value, 'а _текст_');
    assert.equal(r.sel, 'текст');
  });

  it('пробелы по краям остаются снаружи маркеров', () => {
    assert.equal(run('bold', 'слово ', 0, 6).value, '**слово** ');
  });

  it('списки и цитаты — на каждую строку выделения; повтор снимает', () => {
    const text = 'раз\nдва\nтри';
    const list = run('bullet', text, 0, text.length);
    assert.equal(list.value, '- раз\n- два\n- три');
    assert.equal(run('bullet', list.value, 0, list.value.length).value, text);
    assert.equal(run('ordered', list.value, 0, list.value.length).value, '1. раз\n2. два\n3. три');
    assert.equal(run('quote', 'а\nб', 1).value, '> а\nб');
  });

  it('заголовок на текущей строке, курсор в её конце', () => {
    const r = run('heading', 'первая\nвторая', 9);
    assert.equal(r.value, 'первая\n## вторая');
    assert.equal(r.selStart, r.value.length);
  });

  it('код: в строке — обратные кавычки, многострочный — блок', () => {
    assert.equal(run('code', 'x = 1', 0, 5).value, '`x = 1`');
    assert.equal(run('code', 'до\na\nb', 3, 6).value, 'до\n```\na\nb\n```');
  });

  it('ссылка: выделенный текст становится подписью, выделен адрес', () => {
    const r = run('link', 'сайт', 0, 4);
    assert.equal(r.value, '[сайт](https://)');
    assert.equal(r.sel, 'https://');
    const url = run('link', 'https://example.org', 0, 19);
    assert.equal(url.value, '[текст ссылки](https://example.org)');
    assert.equal(url.sel, 'текст ссылки');
  });
});
