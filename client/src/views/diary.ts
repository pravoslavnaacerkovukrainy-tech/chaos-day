// «Дневник»: факты дня и «на чём остановился». Планирования здесь нет.
import { api } from "../api.ts";
import { app, run, snap } from "../app.ts";
import { addDays, dayLabel, isDayKey, shortDate, timeIn, weekday, zonedToIso } from "../dates.ts";
import { button, field, h, setChildren } from "../dom.ts";
import type { DiaryEntry } from "../types.ts";
import { confirmAction, openModal } from "../ui.ts";
import { clearDraft, draftInput, empty, header } from "./common.ts";

export function diaryView(): HTMLElement {
  const s = snap();
  const t = s.today;
  const day = app.diaryDay ?? t;
  const setDay = (d: string) => {
    app.diaryDay = d === t ? null : d;
    app.rerender();
  };

  const text = draftInput("diary-text", h("textarea", {
    rows: 2, testid: "diary-input", placeholder: "Что сделано или произошло?", "aria-label": "Что сделано или произошло?",
  })) as HTMLTextAreaElement;
  const context = draftInput("diary-context", h("input", {
    type: "text", testid: "diary-context-input", placeholder: "На чём остановился — чтобы потом продолжить",
    "aria-label": "На чём остановился",
  })) as HTMLInputElement;
  const time = h("input", { type: "time", testid: "diary-time-input", "aria-label": "Другое время" });
  const save = async () => {
    const value = text.value.trim();
    if (!value) {
      text.focus();
      return;
    }
    const stamp = time.value ? zonedToIso(day, time.value, s.timezone) : day !== t ? zonedToIso(day, "12:00", s.timezone) : undefined;
    await run(async () => {
      const result = await api.addEntry(value, context.value.trim() || null, stamp);
      clearDraft("diary-text");
      clearDraft("diary-context");
      return result;
    }, "Записано в дневник");
  };
  text.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey || !ev.shiftKey) && !ev.isComposing) {
      ev.preventDefault();
      void save();
    }
  });

  const search = draftInput("diary-search", h("input", {
    type: "search", placeholder: "Поиск по всем дням", "aria-label": "Поиск по всем дням", testid: "diary-search",
  })) as HTMLInputElement;
  const listWrap = h("div", { testid: "diary-list-wrap" });
  const renderList = () => {
    const q = search.value.trim().toLocaleLowerCase("ru");
    const byTime = (a: DiaryEntry, b: DiaryEntry) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1) : a.id < b.id ? -1 : 1);
    if (q) {
      const found = s.entries.filter((e) => e.text.toLocaleLowerCase("ru").includes(q) || (e.context ?? "").toLocaleLowerCase("ru").includes(q))
        .sort(byTime).reverse();
      setChildren(listWrap, h("p", { class: "quiet", testid: "diary-search-count" }, found.length ? `Найдено: ${found.length}` : "Ничего не найдено"),
        found.length ? h("ul", { class: "timeline", testid: "diary-search-results" }, found.map((e) => entryRow(e, true))) : null);
      return;
    }
    const entries = s.entries.filter((e) => e.day === day).sort(byTime);
    setChildren(listWrap, entries.length
      ? h("ul", { class: "timeline", testid: "diary-list" }, entries.map((e) => entryRow(e, false)))
      : empty("За этот день записей нет.", "diary-empty"));
  };
  search.addEventListener("input", renderList);
  renderList();

  const picker = h("input", { type: "date", value: day, testid: "diary-date", "aria-label": "Выбрать день" });
  picker.addEventListener("change", () => isDayKey(picker.value) && setDay(picker.value));
  // Дни, где есть записи: после импорта прежние дни находятся без листания.
  const counts = new Map<string, number>();
  for (const e of s.entries) counts.set(e.day, (counts.get(e.day) ?? 0) + 1);
  const days = [...counts.keys()].sort().reverse();
  const jump = h("select", { testid: "diary-days", "aria-label": "Дни с записями" },
    h("option", { value: "" }, days.length ? `Дни с записями: ${days.length}` : "Записей пока нет"),
    days.map((d) => h("option", { value: d }, `${shortDate(d, t)} · ${counts.get(d)}`)));
  jump.addEventListener("change", () => jump.value && setDay(jump.value));

  return h("section", { class: "view", "aria-labelledby": "view-title" },
    header("Дневник", "view-diary", h("div", { class: "search", role: "search" }, search)),
    h("nav", { class: "day-nav", "aria-label": "Выбор дня" },
      button("‹", () => setDay(addDays(day, -1)), { class: "ghost icon", "aria-label": "Предыдущий день", testid: "diary-prev" }),
      button("Сегодня", () => setDay(t), { class: day === t ? "pill active" : "pill", testid: "diary-today", "aria-pressed": String(day === t) }),
      button("›", () => setDay(addDays(day, 1)), { class: "ghost icon", "aria-label": "Следующий день", testid: "diary-next" }),
      picker, jump),
    h("div", { class: "day-title" },
      h("h2", { testid: "diary-day-title" }, dayLabel(day, t)),
      h("span", { class: "quiet" }, shortDate(day, t) + ", " + weekday(day))),
    h("form", { class: "diary-form", testid: "diary-form", onsubmit: (ev: Event) => { ev.preventDefault(); void save(); } },
      text,
      h("div", { class: "diary-form-row" }, context,
        h("label", { class: "inline-field" }, h("span", { class: "quiet" }, "Другое время"), time),
        h("button", { type: "submit", class: "primary", testid: "diary-save" }, "Записать"))),
    listWrap);
}

function entryRow(e: DiaryEntry, withDay: boolean): HTMLLIElement {
  const s = snap();
  return h("li", { class: "entry", testid: "diary-entry", "data-entry-id": e.id },
    h("time", { class: "entry-time", datetime: e.timestamp },
      (withDay ? shortDate(e.day, s.today) + " " : "") + timeIn(e.timestamp, s.timezone)),
    h("span", { class: "entry-node" + (e.plan_id ? " done" : ""), "aria-hidden": "true" }, e.plan_id ? "✓" : ""),
    h("div", { class: "entry-body" },
      h("p", { class: "entry-text", testid: "diary-entry-text" }, e.text),
      e.context ? h("p", { class: "entry-context", testid: "diary-entry-context" }, "На чём остановился: " + e.context) : null,
      e.plan_id ? h("span", { class: "meta" }, "Из задачи") : null),
    h("div", { class: "row-actions" },
      button("Изменить", () => openEntryEditor(e), { class: "ghost", testid: "diary-entry-edit", "aria-label": "Изменить запись: " + e.text }),
      button("Удалить", async () => {
        const ok = await confirmAction("Удалить запись?", e.plan_id ? "Отметка выполнения задачи сохранится." : e.text, "Удалить", "confirm-entry-delete");
        if (ok) await run(() => api.deleteEntry(e.id), "Запись удалена");
      }, { class: "ghost danger", testid: "diary-entry-delete", "aria-label": "Удалить запись: " + e.text })));
}

function openEntryEditor(e: DiaryEntry): void {
  const modal = openModal("Изменить запись", "entry-editor");
  const text = h("textarea", { rows: 3, value: e.text, testid: "entry-text-input" });
  const context = h("input", { type: "text", value: e.context ?? "", testid: "entry-context-input" });
  const save = button("Сохранить", async () => {
    if (!text.value.trim()) return;
    modal.setBusy(true);
    try {
      await api.updateEntry(e.id, { text: text.value.trim(), context: context.value.trim() || null });
      modal.close();
      await run(async () => undefined, "Запись сохранена");
    } catch (err) {
      modal.setError(err);
      modal.setBusy(false);
    }
  }, { class: "primary", testid: "entry-save", "data-submit": true });
  modal.body.append(field("Запись", text), field("На чём остановился", context),
    h("div", { class: "actions" }, button("Отмена", () => modal.close(), { testid: "entry-cancel" }), save));
  text.focus();
}
