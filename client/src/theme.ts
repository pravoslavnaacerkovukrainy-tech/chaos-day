// Тема оформления: тёмная по умолчанию независимо от ОС, светлая — по явному выбору.
// Выбор хранится в браузере (localStorage) и переживает обновление, повторное открытие и выход.
// Первую тему ставит маленький скрипт в index.html до отрисовки — здесь та же логика и тот же ключ.
import { h } from "./dom.ts";

export type Theme = "dark" | "light";

export const THEME_KEY = "chaos-day-theme";
/** Цвет строки браузера для каждой темы — совпадает с --canvas в styles.css. */
const THEME_COLOR: Record<Theme, string> = { dark: "#131a22", light: "#eef2f6" };

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light") root.dataset.theme = "light";
  else delete root.dataset.theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
  document.querySelectorAll<HTMLElement>("[data-theme-option]").forEach((b) => {
    const on = b.dataset.themeOption === theme;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  });
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === "light") localStorage.setItem(THEME_KEY, "light");
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* хранилище недоступно — тема действует до закрытия вкладки */
  }
  apply(theme);
}

/** Сверить с сохранённым выбором (на случай, если скрипт в index.html не выполнился) и следить за другими вкладками. */
export function initTheme(): void {
  apply(storedTheme());
  window.addEventListener("storage", (ev) => {
    if (ev.key === THEME_KEY || ev.key === null) apply(storedTheme());
  });
}

const OPTIONS: { id: Theme; label: string }[] = [
  { id: "dark", label: "Тёмная" },
  { id: "light", label: "Светлая" },
];

/** Переключатель «Тема: Тёмная | Светлая» — группа радиокнопок, стрелки меняют выбор. */
export function themeSwitch(): HTMLElement {
  const theme = currentTheme();
  const buttons = OPTIONS.map((o) => h("button", {
    type: "button", role: "radio", class: "theme-option", testid: "theme-" + o.id,
    "data-theme-option": o.id, "aria-checked": String(o.id === theme), tabindex: o.id === theme ? 0 : -1,
    onclick: () => setTheme(o.id),
  }, o.label));
  const group = h("div", { class: "segmented theme-options", role: "radiogroup", "aria-labelledby": "theme-label" }, buttons);
  group.addEventListener("keydown", (ev) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) return;
    ev.preventDefault();
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    setTheme(next);
    group.querySelector<HTMLElement>(`[data-theme-option="${next}"]`)?.focus();
  });
  const wrap = h("div", { class: "theme-switch", testid: "theme-switch" },
    h("span", { class: "theme-label", id: "theme-label" }, "Тема"), group);
  return wrap;
}
