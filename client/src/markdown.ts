// Показ Markdown заметки в DOM: HTML из markdown-core ещё раз проходит белый список тегов и атрибутов.
import { isSafeHref, markdownToHtml } from "./markdown-core.ts";

const ALLOWED: Record<string, readonly string[]> = {
  P: [], BR: [], HR: [], H1: [], H2: [], H3: [], H4: [], H5: [], H6: [],
  STRONG: [], EM: [], S: [], CODE: ["class"], PRE: [], BLOCKQUOTE: [],
  UL: [], OL: ["start"], LI: [],
  A: ["href", "target", "rel", "class"], SPAN: ["class"],
  DIV: ["class", "tabindex", "role", "aria-label"],
  TABLE: [], THEAD: [], TBODY: [], TR: [], TH: ["style"], TD: ["style"],
};
const ALIGN = /^text-align:(left|right|center)$/;

function clean(root: ParentNode): void {
  for (const el of Array.from(root.children)) {
    const allowed = ALLOWED[el.tagName];
    if (!allowed) {
      el.replaceWith(document.createTextNode(el.textContent ?? ""));
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const ok = allowed.includes(attr.name)
        && (attr.name !== "href" || isSafeHref(attr.value))
        && (attr.name !== "style" || ALIGN.test(attr.value));
      if (!ok) el.removeAttribute(attr.name);
    }
    clean(el);
  }
}

/** Отрисовать Markdown во фрагмент DOM. Ничего не исполняется и не загружается. */
export function renderMarkdown(source: string): DocumentFragment {
  // <template> разбирает разметку инертно: ни скриптов, ни загрузок до вставки в документ.
  const template = document.createElement("template");
  template.innerHTML = markdownToHtml(source);
  clean(template.content);
  return template.content;
}
