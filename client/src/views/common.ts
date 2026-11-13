// Общие куски экранов: заголовок, фильтр сферы, пустое состояние, поле с черновиком.
import { app, type AreaFilter } from "../app.ts";
import { button, h } from "../dom.ts";

export const EMPTY = "Сейчас здесь ничего нет";

export function header(title: string, testid: string, ...extra: (HTMLElement | null)[]): HTMLElement {
  return h("header", { class: "view-header" },
    h("h1", { id: "view-title", tabindex: -1, testid }, title),
    h("div", { class: "view-tools" }, extra));
}

export function areaFilter(): HTMLElement {
  const options: [AreaFilter, string][] = [["all", "Все"], ["work", "Работа"], ["personal", "Личное"]];
  return h("div", { class: "segmented", role: "radiogroup", "aria-label": "Сфера", testid: "area-filter" },
    options.map(([value, label]) => button(label, () => {
      app.area = value;
      app.rerender();
    }, { role: "radio", "aria-checked": String(app.area === value), testid: "area-" + value })));
}

export function empty(text = EMPTY, testid = "empty"): HTMLElement {
  return h("p", { class: "empty", testid }, text);
}

/** Поле, чьё содержимое переживает перерисовку экрана, но не перезагрузку страницы. */
export function draftInput(key: string, el: HTMLInputElement | HTMLTextAreaElement): typeof el {
  el.value = app.drafts.get(key) ?? el.value;
  el.addEventListener("input", () => app.drafts.set(key, el.value));
  return el;
}

export function clearDraft(key: string): void {
  app.drafts.delete(key);
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, testid: string): HTMLElement {
  const input = h("input", { type: "checkbox", checked: value, testid });
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "toggle" }, input, h("span", null, label));
}
