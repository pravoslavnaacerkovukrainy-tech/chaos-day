// «План»: «Сегодня» или любой выбранный день. Выборку делает сервер (GET /api/day).
import { api } from "../api.ts";
import { app, areaMatches, snap, taskOrder } from "../app.ts";
import { addDays, dayLabel, dayOfMonth, isDayKey, relativeName, shortDate, weekday, weekdayShort, weekOf } from "../dates.ts";
import { button, h, setChildren } from "../dom.ts";
import { openTaskEditor, taskRow } from "../task.ts";
import type { DayKey, Task } from "../types.ts";
import { showError } from "../ui.ts";
import { empty, header, areaFilter } from "./common.ts";
import { searchBox } from "./search.ts";

/** Ответ /api/day действителен только для той версии данных, при которой его запросили. */
let cache: { date: DayKey; tasks: Task[]; version: number } | null = null;

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
  const version = app.version;
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
  if (cache && cache.date === day && cache.version === version) fill(cache.tasks);
  else {
    // После изменения прежний ответ устарел: не показываем его, а спрашиваем сервер заново.
    body.append(h("p", { class: "quiet", testid: "plan-loading" }, "Загрузка…"));
    api.day(day).then((res) => {
      if (version !== app.version) return; // ответ на запрос до изменения
      cache = { date: day, tasks: res.tasks, version };
      if (body.isConnected) fill(res.tasks);
    }, (err) => {
      body.replaceChildren(h("p", { class: "form-error", role: "alert" }, "Не удалось загрузить план."));
      showError(err);
    });
  }

  // Все семь клеток недели носят один testid: после перерисовки фокус ставим на выбранную.
  const pickFromWeek = (d: DayKey) => {
    setDay(d);
    document.querySelector<HTMLElement>(`[data-testid="plan-week-day"][data-day="${d}"]`)?.focus();
  };
  const week = h("ul", { class: "week", testid: "plan-week", "aria-label": "Неделя" },
    weekOf(day).map((d) => {
      const selected = d === day;
      const label = `${weekday(d)}, ${shortDate(d, t)}${d === t ? ", сегодня" : ""}`;
      return h("li", null, h("button", {
        type: "button", onclick: () => pickFromWeek(d),
        class: "week-day" + (selected ? " selected" : "") + (d === t ? " today" : ""),
        testid: "plan-week-day", "data-day": d, "aria-pressed": String(selected),
        "aria-current": d === t ? "date" : undefined, "aria-label": label,
      },
        h("span", { class: "wd", "aria-hidden": "true" }, weekdayShort(d)),
        h("span", { class: "dn", "aria-hidden": "true" }, String(dayOfMonth(d)))));
    }));
  const tomorrow = addDays(t, 1);
  const fullDate = shortDate(day, t) + ", " + weekday(day);

  return h("section", { class: "view", "aria-labelledby": "view-title" },
    header("План", "view-plan", areaFilter()),
    searchBox(),
    h("nav", { class: "day-nav", "aria-label": "Выбор дня" },
      h("div", { class: "week-row" },
        button("‹", () => setDay(addDays(day, -1)), { class: "ghost icon", "aria-label": "Предыдущий день", testid: "plan-prev" }),
        week,
        button("›", () => setDay(addDays(day, 1)), { class: "ghost icon", "aria-label": "Следующий день", testid: "plan-next" })),
      h("div", { class: "day-jump" },
        button("Сегодня", () => setDay(t), { class: isToday ? "pill active" : "pill", "aria-pressed": String(isToday), testid: "plan-today" }),
        button("Завтра", () => setDay(tomorrow), { class: day === tomorrow ? "pill active" : "pill", "aria-pressed": String(day === tomorrow), testid: "plan-tomorrow" }),
        h("label", { class: "inline-field date-jump" }, h("span", { class: "quiet small" }, "Дата"), picker))),
    h("div", { class: "day-title" },
      h("h2", { testid: "plan-day-title" }, dayLabel(day, t)),
      relativeName(day, t) ? h("span", { class: "day-date" }, fullDate) : h("span", { class: "day-date" }, weekday(day)),
      isToday ? h("a", { href: "#/review", class: "text-link", testid: "plan-review-link" }, "Пересмотреть план") : null),
    h("p", { class: "quiet small" }, isToday
      ? "День работы, незавершённое с прошлых дней, наступивший срок и обещания под угрозой."
      : "Открытые задачи с днём работы или сроком результата на эту дату."),
    body,
    h("div", { class: "actions start" },
      button("Новая задача", () => openTaskEditor({ day }), { class: "primary", testid: "plan-new-task" })),
  );
}
