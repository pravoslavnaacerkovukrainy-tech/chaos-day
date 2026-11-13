// Небольшой помощник для построения DOM без innerHTML: текст пользователя всегда идёт как текст.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === "class") {
        el.className = String(value);
      } else if (key === "testid") {
        el.setAttribute("data-testid", String(value));
      } else if (key === "value" && "value" in el) {
        (el as unknown as { value: string }).value = String(value);
      } else if (key === "checked" && "checked" in el) {
        (el as unknown as { checked: boolean }).checked = Boolean(value);
      } else if (value === true) {
        el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: (Child | Child[])[]): void {
  for (const child of children) {
    if (Array.isArray(child)) append(el, child);
    else if (child === null || child === undefined || child === false) continue;
    else el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Кнопка с обязательной подписью; иконку не используем, текст и есть подпись. */
export function button(label: string, onClick: (ev: MouseEvent) => void, attrs: Attrs = {}): HTMLButtonElement {
  return h("button", { type: "button", ...attrs, onclick: onClick }, label);
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control,
    hint ? h("span", { class: "field-hint" }, hint) : null);
}

/** replaceChildren, пропускающий пустые значения. */
export function setChildren(el: Element, ...children: (Child | Child[])[]): void {
  clear(el);
  append(el, children);
}

/** append, пропускающий пустые значения. */
export function add(el: Element, ...children: (Child | Child[])[]): void {
  append(el, children);
}
