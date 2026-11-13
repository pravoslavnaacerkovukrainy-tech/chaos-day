// Один поиск по делам: задачи, неархивные проекты, строки места хаоса. Раздел не переключает.
import { api } from "../api.ts";
import { app } from "../app.ts";
import { button, h, setChildren } from "../dom.ts";
import { taskRow } from "../task.ts";
import { draftInput, toggle } from "./common.ts";

const KEY = "deals-search";
let timer: number | undefined;
let seq = 0;

export function searchBox(): HTMLElement {
  const input = draftInput(KEY, h("input", {
    type: "search", placeholder: "Найти задачу, проект или строку", "aria-label": "Поиск по делам",
    testid: "deals-search", autocomplete: "off",
  })) as HTMLInputElement;
  const results = h("div", { class: "search-results", testid: "deals-search-results", "aria-live": "polite" });
  const go = () => {
    const q = input.value.trim();
    const my = ++seq;
    if (!q) {
      results.replaceChildren();
      return;
    }
    api.search(q, app.showCompleted, app.showRemoved).then((r) => {
      if (my !== seq || !results.isConnected) return;
      const total = r.tasks.length + r.projects.length + r.chaos.length;
      setChildren(results,
        h("div", { class: "search-head" },
          h("span", { class: "quiet", testid: "deals-search-count" }, total ? `Найдено: ${total}` : "Ничего не найдено"),
          button("Сбросить поиск", () => {
            input.value = "";
            app.drafts.delete(KEY);
            results.replaceChildren();
            input.focus();
          }, { class: "link", testid: "deals-search-clear" })),
        r.tasks.length ? h("div", null, h("h3", { class: "group-title" }, "Задачи"),
          h("ul", { class: "list" }, r.tasks.map((x) => taskRow(x)))) : null,
        r.projects.length ? h("div", null, h("h3", { class: "group-title" }, "Проекты"),
          h("ul", { class: "list" }, r.projects.map((p) => h("li", { class: "plain-row", testid: "search-project" },
            h("span", { class: "task-text" }, p.title), h("span", { class: "quiet" }, p.outcome))))) : null,
        r.chaos.length ? h("div", null, h("h3", { class: "group-title" }, "Место хаоса"),
          h("ul", { class: "list" }, r.chaos.map((c) => h("li", { class: "plain-row", testid: "search-chaos" },
            h("span", { class: "task-text" }, c.text))))) : null,
      );
    }, () => {
      if (my === seq) results.replaceChildren(h("p", { class: "form-error", role: "alert" }, "Поиск не выполнен. Попробуйте ещё раз."));
    });
  };
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(go, 200);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && input.value) {
      ev.preventDefault();
      input.value = "";
      app.drafts.delete(KEY);
      go();
    }
  });
  if (input.value.trim()) go();
  return h("div", { class: "search", role: "search" }, input,
    h("div", { class: "search-toggles" },
      toggle("Выполненные", app.showCompleted, (v) => { app.showCompleted = v; go(); }, "deals-search-completed"),
      toggle("Снятые", app.showRemoved, (v) => { app.showRemoved = v; go(); }, "deals-search-removed")),
    results);
}
