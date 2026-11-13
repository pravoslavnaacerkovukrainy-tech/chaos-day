// «Все задачи», «Ожидаю» и «Проекты».
import { api, ApiError } from "../api.ts";
import { app, AREA_TITLES, areaMatches, run, snap, taskOrder } from "../app.ts";
import { shortDate } from "../dates.ts";
import { button, field, h } from "../dom.ts";
import { openTaskEditor, taskRow } from "../task.ts";
import type { Area, Project } from "../types.ts";
import { confirmAction, openModal } from "../ui.ts";
import { areaFilter, empty, header, toggle } from "./common.ts";

export function tasksView(): HTMLElement {
  const s = snap();
  const tasks = s.tasks
    .filter((t) => (app.showCompleted || !t.is_completed) && (app.showRemoved || !t.is_removed) && areaMatches(t.area))
    .sort(taskOrder);
  return h("section", { class: "view", "aria-labelledby": "view-title" },
    header("Все задачи", "view-tasks", areaFilter()),
    h("div", { class: "toggles" },
      toggle("Показывать выполненные", app.showCompleted, (v) => { app.showCompleted = v; app.rerender(); }, "tasks-show-completed"),
      toggle("Показывать снятые", app.showRemoved, (v) => { app.showRemoved = v; app.rerender(); }, "tasks-show-removed")),
    tasks.length ? h("ul", { class: "list", testid: "tasks-list" }, tasks.map((t) => taskRow(t))) : empty(undefined, "tasks-empty"),
    h("div", { class: "actions start" },
      button("Новая задача", () => openTaskEditor({}), { class: "primary", testid: "tasks-new" })),
  );
}

export function waitingView(): HTMLElement {
  const s = snap();
  const tasks = s.tasks.filter((t) => t.is_open && t.status === "waiting" && areaMatches(t.area)).sort(taskOrder);
  return h("section", { class: "view", "aria-labelledby": "view-title" },
    header("Ожидаю", "view-waiting", areaFilter()),
    h("p", { class: "lead" }, "Что зависит от другого человека или события и когда это проверить."),
    tasks.length ? h("ul", { class: "list", testid: "waiting-list" }, tasks.map((t) => taskRow(t))) : empty("Ожиданий пока нет. Сейчас здесь ничего нет.", "waiting-empty"),
  );
}

export function projectsView(): HTMLElement {
  const s = snap();
  const projects = s.projects
    .filter((p) => (app.showArchived || !p.archived) && areaMatches(p.area))
    .sort((a, b) => a.title.localeCompare(b.title, "ru"));
  return h("section", { class: "view", "aria-labelledby": "view-title" },
    header("Проекты", "view-projects", areaFilter()),
    h("div", { class: "toggles" },
      toggle("Показывать завершённые проекты", app.showArchived, (v) => { app.showArchived = v; app.rerender(); }, "projects-show-archived")),
    projects.length
      ? h("ul", { class: "cards", testid: "projects-list" }, projects.map(projectCard))
      : empty("Создайте проект и выберите одно ближайшее действие. Сейчас здесь ничего нет.", "projects-empty"),
    h("div", { class: "actions start" },
      button("Новый проект", () => openProjectEditor(), { class: "primary", testid: "project-new" })),
  );
}

function projectCard(p: Project): HTMLLIElement {
  const s = snap();
  const tasks = s.tasks.filter((t) => t.project_id === p.id && (t.is_open || app.showCompleted)).sort(taskOrder);
  const candidates = s.tasks.filter((t) => t.project_id === p.id && t.is_open && t.status === "ready");
  const next = s.tasks.find((t) => t.id === p.next_action_id);
  const select = h("select", { testid: "project-next-select", "aria-label": "Следующий шаг проекта " + p.title, disabled: p.archived },
    h("option", { value: "" }, candidates.length ? "Выберите следующий шаг" : "Нет задач «Можно делать»"),
    candidates.map((t) => h("option", { value: t.id }, t.text)));
  select.value = p.next_action_id ?? "";
  select.addEventListener("change", () =>
    void run(() => api.setNextAction(p.id, select.value || null), select.value ? "Следующий шаг выбран" : "Следующий шаг снят"));

  return h("li", { class: "card" + (p.archived ? " closed" : ""), testid: "project-card", "data-project-id": p.id },
    h("div", { class: "card-head" },
      h("h2", { class: "card-title", testid: "project-title" }, p.title),
      h("span", { class: "meta" }, AREA_TITLES[p.area]),
      p.archived ? h("span", { class: "meta" }, "Завершён") : null),
    h("dl", { class: "props" },
      h("dt", null, "Результат"), h("dd", { testid: "project-outcome" }, p.outcome),
      p.uncertainty ? [h("dt", null, "Нужно выяснить"), h("dd", null, p.uncertainty)] : null,
      p.review_date ? [h("dt", null, "Пересмотреть"), h("dd", null, shortDate(p.review_date, s.today))] : null,
      h("dt", null, "Следующий шаг"),
      h("dd", { class: next ? "next-step" : "quiet", testid: "project-next" }, next ? next.text : "Определите следующий шаг")),
    p.archived ? null : h("div", { class: "field inline" }, select),
    tasks.length ? h("ul", { class: "list nested" }, tasks.map((t) => taskRow(t))) : null,
    h("div", { class: "actions start" },
      p.archived ? null : button("Добавить действие", () => openTaskEditor({ projectId: p.id, area: p.area }), { testid: "project-add-task" }),
      button("Изменить", () => openProjectEditor(p), { class: "ghost", testid: "project-edit" }),
      button(p.archived ? "Возобновить проект" : "Завершить проект",
        () => void run(() => api.archiveProject(p.id, !p.archived), p.archived ? "Проект возобновлён" : "Проект завершён"),
        { class: "ghost", testid: "project-archive" }),
      button("Удалить", async () => {
        const ok = await confirmAction("Удалить проект?", "Задачи проекта останутся, связь с проектом исчезнет.", "Удалить", "confirm-project-delete");
        if (ok) await run(() => api.deleteProject(p.id), "Проект удалён");
      }, { class: "ghost danger", testid: "project-delete" })),
  );
}

export function openProjectEditor(p?: Project): void {
  const modal = openModal(p ? "Изменить проект" : "Новый проект", "project-editor");
  const title = h("input", { type: "text", value: p?.title ?? "", testid: "project-title-input", required: true });
  const outcome = h("textarea", { rows: 2, value: p?.outcome ?? "", testid: "project-outcome-input", required: true,
    placeholder: "Какой результат хочу получить" });
  const uncertainty = h("textarea", { rows: 2, value: p?.uncertainty ?? "", testid: "project-uncertainty-input",
    placeholder: "Чего пока не знаю и изменит ли ответ решение" });
  const review = h("input", { type: "date", value: p?.review_date ?? "", testid: "project-review-input" });
  const area = h("select", { testid: "project-area-input" },
    (["personal", "work"] as Area[]).map((a) => h("option", { value: a }, AREA_TITLES[a])));
  area.value = p?.area ?? (app.area === "all" ? "personal" : app.area);
  const save = button("Сохранить", async () => {
    if (!title.value.trim() || !outcome.value.trim()) {
      modal.setError(new ApiError(400, "empty_text", "Нужны название и результат."));
      return;
    }
    const draft = {
      title: title.value.trim(), outcome: outcome.value.trim(), area: area.value as Area,
      uncertainty: uncertainty.value.trim(), review_date: review.value || null,
    };
    modal.setBusy(true);
    try {
      if (p) await api.updateProject(p.id, draft);
      else await api.createProject(draft);
      modal.close();
      await run(async () => undefined, "Проект сохранён");
    } catch (err) {
      modal.setError(err);
      modal.setBusy(false);
    }
  }, { class: "primary", testid: "project-save", "data-submit": true });
  modal.body.append(
    field("Название", title),
    field("Результат", outcome),
    field("Что нужно выяснить", uncertainty),
    field("Дата пересмотра", review),
    field("Сфера", area, "Задачи проекта получают его сферу."),
    h("div", { class: "actions" }, button("Отмена", () => modal.close(), { testid: "project-cancel" }), save),
  );
  title.focus();
}
