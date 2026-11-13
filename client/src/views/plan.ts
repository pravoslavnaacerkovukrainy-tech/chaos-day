// «План»: «Сегодня» или любой выбранный день. Выборку делает сервер (GET /api/day).
import { api } from "../api.ts";
import { app, areaMatches, snap, taskOrder } from "../app.ts";
import { addDays, dayLabel, isDayKey, shortDate, weekday } from "../dates.ts";
import { button, h, setChildren } from "../dom.ts";
import { openTaskEditor, taskRow } from "../task.ts";
import type { DayKey, Task } from "../types.ts";
import { showError } from "../ui.ts";
import { empty, header, areaFilter } from "./common.ts";
import { searchBox } from "./search.ts";

let cache: { date: DayKey; tasks: Task[]; stamp: string } | null = null;

export function planView(): HTMLElement {
  const s = snap();
  const t = s.today;
  const day = app.planDay ?? t;
  const isToday = day === t;
  const setDay = (d: DayKey) => {
    app.planDay = d === t ? null : d;
    app.rerender();
  };

  const picker = h("input", { type: "date", value: day, testid: "plan-date", "aria-label": "Выбрать день плана" });
  picker.addEventListener("change", () => {
    if (isDayKey(picker.value)) setDay(picker.value);
  });

  const body = h("div", { class: "plan-body", testid: "plan-list-wrap", "aria-busy": "true" });
  const stamp = s.now + ":" + s.tasks.length + ":" + s.tasks.map((x) => x.updated_at).join("");
  const fill = (tasks: Task[]) => {
    body.removeAttribute("aria-busy");
    const visible = tasks.filter((x) => areaMatches(x.area)).sort(taskOrder);
    const urgent = isToday ? s.chaos.filter((c) => c.urgent) : [];
    setChildren(body,
      urgent.length ? h("div", { class: "urgent-block", testid: "plan-urgent" },
        h("h2", { class: "group-title signal" }, "Не может ждать"),
        h("ul", { class: "list" }, urgent.map((c) => h("li", { class: "chaos-row urgent", testid: "plan-urgent-item" },
          h("div", { class: "task-main" }, h("span", { class: "task-text" }, c.text),
            h("div", { class: "task-meta" }, h("span", { class: "meta signal" }, "Не может ждать"), h("span", { class: "meta" }, "Место хаоса"))),
          h("div", { class: "row-actions" }, button("Это задача", () => openTaskEditor({ chaos: c }), { class: "ghost", testid: "plan-urgent-to-task" })))))) : null,
      visible.length
        ? h("ul", { class: "list", testid: "plan-list", "aria-label": "Задачи на " + dayLabel(day, t) }, visible.map((x) => taskRow(x)))
        : empty(isToday ? "На сегодня задач нет. Сейчас здесь ничего нет." : "На этот день задач нет. Сейчас здесь ничего нет.", "plan-empty"),
    );
  };
  if (cache && cache.date === day && cache.stamp === stamp) fill(cache.tasks);
  else {
    if (cache && cache.date === day) fill(cache.tasks);
    else body.append(h("p", { class: "quiet" }, "Загрузка…"));
    api.day(day).then((res) => {
      cache = { date: day, tasks: res.tasks, stamp };
      if (body.isConnected) fill(res.tasks);
    }, (err) => {
      body.replaceChildren(h("p", { class: "form-error", role: "alert" }, "Не удалось загрузить план."));
      showError(err);
    });
  }

  return h("section", { class: "view", "aria-labelledby": "view-title" },
    header("План", "view-plan", areaFilter()),
    searchBox(),
    h("nav", { class: "day-nav", "aria-label": "Выбор дня" },
      button("‹", () => setDay(addDays(day, -1)), { class: "ghost icon", "aria-label": "Предыдущий день", testid: "plan-prev" }),
      button("Сегодня", () => setDay(t), { class: isToday ? "pill active" : "pill", "aria-pressed": String(isToday), testid: "plan-today" }),
      button("Завтра", () => setDay(addDays(t, 1)), { class: day === addDays(t, 1) ? "pill active" : "pill", "aria-pressed": String(day === addDays(t, 1)), testid: "plan-tomorrow" }),
      button("›", () => setDay(addDays(day, 1)), { class: "ghost icon", "aria-label": "Следующий день", testid: "plan-next" }),
      picker),
    h("div", { class: "day-title" },
      h("h2", { testid: "plan-day-title" }, dayLabel(day, t)),
      h("span", { class: "quiet" }, isToday ? shortDate(day, t) + ", " + weekday(day) : weekday(day))),
    h("p", { class: "quiet small" }, isToday
      ? "День работы, незавершённое с прошлых дней, наступивший срок и обещания под угрозой."
      : "Открытые задачи с днём работы или сроком результата на эту дату."),
    body,
    h("div", { class: "actions start" },
      button("Новая задача", () => openTaskEditor({ day }), { class: "primary", testid: "plan-new-task" })),
  );
}
