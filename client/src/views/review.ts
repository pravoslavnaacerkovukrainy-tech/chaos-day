// «Обзор»: шесть групп в порядке методики. Порядок и состав задаёт сервер.
import { api } from "../api.ts";
import { snap } from "../app.ts";
import { shortDate } from "../dates.ts";
import { h } from "../dom.ts";
import { taskRow } from "../task.ts";
import type { ReviewGroup, ReviewItem } from "../types.ts";
import { showError } from "../ui.ts";
import { EMPTY, header } from "./common.ts";

let cache: { stamp: string; groups: ReviewGroup[] } | null = null;

export function reviewView(): HTMLElement {
  const s = snap();
  const stamp = s.now + ":" + s.tasks.map((t) => t.updated_at).join("") + s.projects.map((p) => p.updated_at).join("");
  const body = h("ol", { class: "route", testid: "review-groups", "aria-label": "Группы пересмотра" });
  const fill = (groups: ReviewGroup[]) => body.replaceChildren(...groups.map((g, i) => groupNode(g, i + 1)));
  if (cache) fill(cache.groups);
  else body.append(h("li", { class: "quiet" }, "Загрузка…"));
  if (!cache || cache.stamp !== stamp) {
    body.setAttribute("aria-busy", "true");
    api.review().then((r) => {
      cache = { stamp, groups: r.groups };
      body.removeAttribute("aria-busy");
      if (body.isConnected) fill(r.groups);
    }, (err) => {
      body.removeAttribute("aria-busy");
      showError(err);
    });
  }
  return h("section", { class: "view", "aria-labelledby": "view-title" },
    header("Обзор", "view-review"),
    h("p", { class: "lead" }, "Пройдите сверху вниз. Каждое дело стоит только в первой подходящей группе. Решение принимаете вы."),
    body);
}

function groupNode(g: ReviewGroup, n: number): HTMLLIElement {
  const signal = g.key === "at_risk";
  const isEmpty = g.is_empty || g.items.length === 0;
  return h("li", {
    class: "route-group" + (isEmpty ? " empty-group" : "") + (signal ? " signal" : ""),
    testid: "review-group-" + n, "data-review-key": g.key,
  },
    h("span", { class: "node", "aria-hidden": "true" }),
    h("h2", { class: "group-title", testid: "review-group-title" }, g.title),
    isEmpty
      ? h("p", { class: "empty", testid: "review-group-empty" }, g.empty_text || EMPTY)
      : h("ul", { class: "list" }, g.items.map(itemNode)));
}

function itemNode(item: ReviewItem): HTMLLIElement {
  if (item.kind === "task" && item.task) return taskRow(item.task);
  const p = item.project;
  const t = snap().today;
  return h("li", { class: "plain-row", testid: "review-project", "data-project-id": item.id },
    h("div", { class: "task-main" },
      h("span", { class: "task-text" }, "Проект: " + item.title),
      h("div", { class: "task-meta" },
        p && !p.next_action_id ? h("span", { class: "meta" }, "Нет следующего шага") : null,
        p?.review_date ? h("span", { class: "meta" }, "Пересмотреть · " + shortDate(p.review_date, t)) : null)));
}
