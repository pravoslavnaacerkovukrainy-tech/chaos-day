// Markdown заметок → HTML-строка. Храним всегда исходный текст; здесь только показ.
// HTML в заметке не интерпретируется (html: false), ссылки — только http(s) и mailto,
// картинки не загружаются: вместо <img> — обычная ссылка на адрес картинки.
// Без DOM: модуль проверяется и в node-тестах; белый список DOM — в markdown.ts.
import MarkdownIt from "markdown-it";

const SAFE_SCHEME = /^(https?:|mailto:)/i;

export function isSafeHref(url: string): boolean {
  // Управляющие символы и пробелы браузер выкидывает перед разбором схемы — убираем и мы.
  const compact = url.replace(/[\u0000- \u007f-\u009f]/g, "");
  return SAFE_SCHEME.test(compact);
}

const md = new MarkdownIt({
  html: false,
  // Одиночный перенос строки остаётся переносом: старые записи без Markdown выглядят как раньше.
  breaks: true,
  linkify: true,
  typographer: false,
});
md.validateLink = isSafeHref;

const external = 'target="_blank" rel="noopener noreferrer nofollow"';

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]!;
  if (/^https?:/i.test(token.attrGet("href") ?? "")) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer nofollow");
  }
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = (tokens, idx, options, env) => {
  const token = tokens[idx]!;
  const src = token.attrGet("src") ?? "";
  const alt = md.renderer.renderInlineAsText(token.children ?? [], options, env);
  const text = md.utils.escapeHtml("Картинка" + (alt ? ": " + alt : ""));
  if (!isSafeHref(src)) return `<span class="md-image">${text}</span>`;
  return `<a class="md-image" href="${md.utils.escapeHtml(src)}" ${external}>${text}</a>`;
};

// Широкие таблицы прокручиваются внутри заметки, страница не растягивается.
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  `<div class="md-table" tabindex="0" role="region" aria-label="Таблица">` + self.renderToken(tokens, idx, options);
md.renderer.rules.table_close = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options) + `</div>`;

export function markdownToHtml(source: string): string {
  return md.render(source);
}
