// Строка задачи, редактор задачи, «Снять…», «Перенести» и шаги.
import { api, ApiError } from "./api.ts";
import { app, AREA_TITLES, projectById, run, snap, STATUS_TITLES, today } from "./app.ts";
import { addDays, dayLabel, isDayKey, shortDate } from "./dates.ts";
import { add, button, field, h } from "./dom.ts";
import type { Area, ChaosItem, DayKey, Task, TaskDraft, TaskStatus, TaskStep, UUID } from "./types.ts";
import { confirmAction, openModal, say } from "./ui.ts";

// ───────────────────────── строка задачи ─────────────────────────

export interface RowOptions {
  /** Показать причину снятия и кнопку «Вернуть в работу». */
  compact?: boolean;
}

export function taskRow(task: Task, opts: RowOptions = {}): HTMLLIElement {
  const t = today();
  const meta: (HTMLElement | string)[] = [];
  const badge = (text: string, cls = "", testid?: string) =>
    h("span", { class: "meta " + cls, testid }, text);

  if (task.at_risk && task.is_open) meta.push(badge("Обещание под угрозой", "signal", "task-at-risk"));
  if (task.is_removed) meta.push(badge("Снято", "", "task-removed"));
  if (task.is_completed) meta.push(badge("Выполнено", "", "task-completed"));
  const waitingShown = task.status === "waiting" && Boolean(task.waiting_for);
  if (!task.is_removed && !task.is_completed && task.status !== "ready" && !waitingShown) meta.push(badge(STATUS_TITLES[task.status] ?? ""));
  const project = projectById(task.project_id);
  if (project) meta.push(badge("Проект: " + project.title));
  if (task.day) meta.push(badge("День работы · " + dayLabel(task.day, t), task.day < t && task.is_open ? "overdue" : "", "task-day"));
  if (task.deadline) meta.push(badge("Срок · " + dayLabel(task.deadline, t), "", "task-deadline"));
  if (task.review_date) meta.push(badge("Пересмотреть · " + shortDate(task.review_date, t), "", "task-review"));
  if (task.promised_to) meta.push(badge("Кому обещано · " + task.promised_to, "", "task-promised"));
  if (task.waiting_for) meta.push(badge("Ожидаю · " + task.waiting_for));
  if (app.area === "all") meta.push(badge(AREA_TITLES[task.area]));

  const steps = task.steps ?? [];
  const doneSteps = steps.filter((s) => s.completed_at).length;

  const check = task.is_completed
    ? button("✓", () => void reopenTask(task), {
        class: "check done", testid: "task-reopen", "aria-label": "Вернуть в задачи: " + task.text,
        title: "Вернуть в задачи",
      })
    : button("", () => void completeTask(task), {
        class: "check", testid: "task-complete", "aria-label": "Выполнить задачу: " + task.text,
        title: "Результат достигнут, выполнить задачу", disabled: task.is_removed,
      });

  const actions = h("div", { class: "row-actions" });
  if (task.is_open) {
    actions.append(rescheduleMenu(task));
    actions.append(button("Изменить", () => openTaskEditor({ task }), {
      class: "ghost", testid: "task-edit", "aria-label": "Изменить задачу: " + task.text,
    }));
    actions.append(moreMenu(task));
  } else if (task.is_removed) {
    actions.append(button("Вернуть в работу", () => void run(() => api.returnToWork(task.id), "Задача возвращена в работу"), {
      class: "ghost", testid: "task-return", "aria-label": "Вернуть в работу: " + task.text,
    }));
  }

  return h("li", { class: "task-row" + (task.is_open ? "" : " closed"), testid: "task-row", "data-task-id": task.id },
    check,
    h("div", { class: "task-main" },
      h("span", { class: "task-text", testid: "task-text" }, task.text),
      task.next_step && task.is_open
        ? h("span", { class: "task-next", testid: "task-next-step" }, "Следующий: " + task.next_step.text)
        : null,
      steps.length ? h("span", { class: "task-steps-count" }, `Шаги: ${doneSteps} из ${steps.length}`) : null,
      meta.length ? h("div", { class: "task-meta" }, meta) : null,
      task.is_removed && task.removal_reason && !opts.compact
        ? h("p", { class: "removal", testid: "task-removal-reason" }, "Причина снятия · " + task.removal_reason)
        : null,
    ),
    actions,
  );
}

function rescheduleMenu(task: Task): HTMLElement {
  const t = today();
  const dateInput = h("input", {
    type: "date", "aria-label": "Новый день работы", testid: "reschedule-date",
    value: task.day || addDays(t, 2),
  });
  const details = h("details", { class: "menu" });
  const go = (day: DayKey | "", label: string) => {
    details.open = false;
    void run(() => api.reschedule(task.id, day), label);
  };
  details.append(
    h("summary", { class: "ghost", testid: "task-reschedule", "aria-label": "Перенести задачу: " + task.text }, "Перенести"),
    h("div", { class: "menu-list", role: "group", "aria-label": "Новый день работы" },
      button("Сегодня", () => go(t, "Задача запланирована на сегодня"), { testid: "reschedule-today" }),
      button("Завтра", () => go(addDays(t, 1), "Задача перенесена на завтра"), { testid: "reschedule-tomorrow" }),
      h("div", { class: "menu-date" }, dateInput,
        button("Перенести", () => {
          if (!isDayKey(dateInput.value)) return;
          go(dateInput.value, "Задача перенесена на " + shortDate(dateInput.value, t));
        }, { testid: "reschedule-apply" })),
      task.day ? button("Убрать день работы", () => go("", "День работы снят"), { testid: "reschedule-clear" }) : null,
      h("p", { class: "menu-hint" }, "Меняется только день работы. Срок и дата пересмотра остаются."),
    ),
  );
  return details;
}

function moreMenu(task: Task): HTMLElement {
  const details = h("details", { class: "menu" });
  const close = () => (details.open = false);
  details.append(
    h("summary", { class: "ghost", testid: "task-more", "aria-label": "Ещё действия: " + task.text }, "Ещё"),
    h("div", { class: "menu-list" },
      button(task.at_risk ? "Снять отметку «Обещание под угрозой»" : "Обещание под угрозой", () => {
        close();
        void run(() => api.setAtRisk(task.id, !task.at_risk),
          task.at_risk ? "Отметка снята" : "Отмечено: обещание под угрозой");
      }, { testid: "task-toggle-risk", "aria-pressed": String(task.at_risk) }),
      button("Снять…", () => {
        close();
        openRemoveDialog(task);
      }, { testid: "task-remove" }),
      button("Удалить", () => {
        close();
        void deleteTask(task);
      }, { class: "danger", testid: "task-delete" }),
    ),
  );
  return details;
}

async function completeTask(task: Task): Promise<void> {
  const open = (task.steps ?? []).filter((s) => !s.completed_at).length;
  if (open > 0) {
    const ok = await confirmAction("Подтвердить результат задачи?",
      `Не отмечено шагов: ${open}. Результат задачи подтверждается отдельно от шагов.`,
      "Результат достигнут", "confirm-complete");
    if (!ok) return;
  }
  await run(() => api.complete(task.id), "Результат задачи подтверждён. В дневнике одна запись.");
}

async function reopenTask(task: Task): Promise<void> {
  const ok = await confirmAction("Вернуть задачу?",
    "Отметка выполнения снимется. Запись дневника удалится, только если её не меняли.",
    "Вернуть в задачи", "confirm-reopen");
  if (!ok) return;
  const result = await run(() => api.reopen(task.id));
  if (!result) return;
  if (result.outcome === "kept_entry") say("Задача возвращена. Изменённая запись осталась в дневнике.");
  else if (result.outcome === "removed_entry") say("Задача возвращена, запись дневника удалена.");
  else say("Задача возвращена.");
}

async function deleteTask(task: Task): Promise<void> {
  if ((task.steps ?? []).length > 0) {
    // Сервер всё равно откажет; объясняем заранее и не отправляем запрос.
    await confirmAction("Удалить задачу нельзя",
      "У задачи есть шаги. Сначала удалите шаги и сохраните список, затем удалите задачу.",
      "Понятно", "confirm-delete-steps");
    return;
  }
  const ok = await confirmAction("Удалить задачу?",
    "Задача исчезнет из всех списков. Запись дневника, если она есть, останется.", "Удалить", "confirm-delete");
  if (ok) await run(() => api.deleteTask(task.id), "Задача удалена");
}

// ───────────────────────── «Снять…» ─────────────────────────

export function openRemoveDialog(task: Task): void {
  const modal = openModal("Снять задачу", "remove-dialog");
  const reason = h("textarea", {
    rows: 3, testid: "remove-reason", required: true, placeholder: "Почему дело больше не нужно",
  });
  const submit = button("Снять", async () => {
    const text = reason.value.trim();
    if (!text) return;
    modal.setBusy(true);
    try {
      await api.remove(task.id, text);
      modal.close();
      await run(async () => undefined, "Задача снята");
    } catch (err) {
      modal.setError(err);
      modal.setBusy(false);
    }
  }, { class: "primary", testid: "remove-confirm", disabled: true, "data-submit": true });
  reason.addEventListener("input", () => (submit.disabled = reason.value.trim() === ""));
  modal.body.append(
    h("p", { class: "quiet" }, task.text),
    field("Причина снятия", reason, "Снятие не считается выполнением: запись в дневнике не создаётся, шаги сохраняются."),
    h("div", { class: "actions" }, button("Отмена", () => modal.close(), { testid: "remove-cancel" }), submit),
  );
  reason.focus();
}

// ───────────────────────── редактор задачи ─────────────────────────

const TASK_CONFLICT_MESSAGE =
  "Задачу изменили в другом месте, пока это окно было открыто. Ваши правки не сохранены и остались в полях ниже — " +
  "скопируйте нужное, затем закройте окно и откройте задачу заново: там будет свежая версия. " +
  "Повторное сохранение отсюда отключено, чтобы не затереть чужую правку.";

function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === "conflicting_changes";
}

export interface EditorOptions {
  task?: Task;
  chaos?: ChaosItem;
  projectId?: UUID | null;
  day?: DayKey | "";
  area?: Area;
}

export function openTaskEditor(opts: EditorOptions): void {
  const { task, chaos } = opts;
  const title = task ? "Изменить задачу" : chaos ? "Это задача" : "Новая задача";
  const modal = openModal(title, "task-editor");
  const s = snap();
  const t = s.today;

  const text = h("textarea", {
    rows: 2, testid: "task-text-input", required: true, placeholder: "Действие",
    value: task?.text ?? chaos?.text ?? "",
  });

  let area: Area = task?.area ?? opts.area ?? (app.area === "all" ? "personal" : app.area);
  const areaGroup = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Сфера" });
  const renderArea = () => {
    areaGroup.replaceChildren(...(["personal", "work"] as Area[]).map((a) =>
      button(AREA_TITLES[a], () => {
        area = a;
        renderArea();
      }, { role: "radio", "aria-checked": String(area === a), testid: "task-area-" + a })));
  };
  renderArea();

  const projects = s.projects.filter((p) => !p.archived || p.id === task?.project_id);
  const project = h("select", { testid: "task-project" },
    h("option", { value: "" }, "Без проекта"),
    projects.map((p) => h("option", { value: p.id }, p.title)));
  project.value = task?.project_id ?? opts.projectId ?? "";
  // Сфера задачи проекта — сфера проекта (контракт 5.5): показываем это сразу.
  const syncAreaWithProject = () => {
    const p = projects.find((x) => x.id === project.value);
    if (p) {
      area = p.area;
      renderArea();
    }
    areaGroup.querySelectorAll("button").forEach((b) => (b.disabled = Boolean(p)));
    areaGroup.title = p ? "Сфера берётся из проекта" : "";
  };
  project.addEventListener("change", syncAreaWithProject);
  syncAreaWithProject();

  const statuses: TaskStatus[] = ["ready", "waiting", "paused"];
  if (task?.status === "inbox") statuses.unshift("inbox");
  const status = h("select", { testid: "task-status" },
    statuses.map((st) => h("option", { value: st }, STATUS_TITLES[st] ?? st)));
  status.value = task?.status ?? "ready";

  const dateInput = (value: string | null | undefined, testid: string, label: string) =>
    h("input", { type: "date", value: value ?? "", testid, "aria-label": label });
  const day = dateInput(task ? task.day : opts.day ?? "", "task-day-input", "День работы");
  const deadline = dateInput(task?.deadline, "task-deadline-input", "Срок результата");
  const review = dateInput(task?.review_date, "task-review-input", "Дата пересмотра");

  const quickDays = h("div", { class: "quick" },
    button("Сегодня", () => (day.value = t), { class: "link", testid: "task-day-today" }),
    button("Завтра", () => (day.value = addDays(t, 1)), { class: "link", testid: "task-day-tomorrow" }),
    button("Без дня", () => (day.value = ""), { class: "link", testid: "task-day-clear" }));

  const waiting = h("input", { type: "text", testid: "task-waiting-input", value: task?.waiting_for ?? "",
    placeholder: "Кого или чего жду" });
  const promised = h("input", { type: "text", testid: "task-promised-input", value: task?.promised_to ?? "",
    placeholder: "Обещание другому человеку" });
  const urgentChaos = Boolean(chaos?.urgent);
  const atRisk = h("input", { type: "checkbox", testid: "task-at-risk-input",
    checked: task?.at_risk ?? urgentChaos, disabled: urgentChaos });
  const details = h("textarea", { rows: 4, testid: "task-details-input", value: task?.details ?? "",
    placeholder: "Подробности или что нужно выяснить" });

  const hasExtra = Boolean(task && (task.project_id || task.status !== "ready" || task.deadline || task.review_date ||
    task.waiting_for || task.promised_to || task.details)) || Boolean(opts.projectId);
  const extra = h("details", { class: "extra", open: hasExtra || undefined },
    h("summary", { testid: "task-extra" }, "Дополнительно"),
    h("p", { class: "quiet" }, "Проект, состояние, обещание, даты, заметка. Необязательно."),
    field("Проект", project),
    field("Состояние", status),
    h("div", { class: "dates" },
      field("Срок результата", deadline),
      field("Дата пересмотра", review)),
    field("Кого или чего ждать", waiting),
    field("Кому обещано", promised, "Свободная строка, не контакт. В дневник не копируется."),
    h("label", { class: "check-field" + (atRisk.checked ? " signal" : "") }, atRisk,
      h("span", null, "Обещание под угрозой")),
    urgentChaos ? h("p", { class: "signal-text" }, "Строка помечена «Не может ждать»: задача получит отметку «Обещание под угрозой». Даты не назначаются.") : null,
    field("Подробности", details),
  );

  const clean = (v: string) => (v.trim() === "" ? null : v.trim());

  const draft = (): TaskDraft => ({
    text: text.value.trim(),
    area,
    project_id: project.value || null,
    status: status.value as TaskStatus,
    day: day.value,
    deadline: deadline.value || null,
    review_date: review.value || null,
    waiting_for: clean(waiting.value),
    promised_to: clean(promised.value),
    at_risk: atRisk.checked,
    details: clean(details.value),
  });

  // Версия той задачи, которую человек видит в этом окне. Именно её сервер сверит при записи:
  // если задачу успели изменить в другом месте, PATCH вернёт 409 и ничего не затрёт.
  const baseRevision = task?.revision;
  let conflicted = false;

  const save = button("Сохранить", async () => {
    if (conflicted) return;
    const d = draft();
    if (!d.text) {
      modal.setError(new ApiError(400, "empty_text", "Напишите действие одной строкой."));
      text.focus();
      return;
    }
    modal.setBusy(true);
    modal.setError(null);
    try {
      if (chaos) await api.chaosToTask(chaos.id, d);
      else if (task) await api.updateTask(task.id, d, baseRevision);
      else await api.createTask(d);
      modal.close();
      await run(async () => undefined, chaos ? "Строка стала задачей" : task ? "Задача сохранена" : "Задача добавлена");
    } catch (err) {
      // Строка места хаоса остаётся на месте с прежним id: сервер откатил разбор целиком.
      modal.setBusy(false);
      if (task && isConflict(err)) {
        // Черновик остаётся в полях окна. Повторно не отправляем: та же версия снова
        // получит отказ, а без проверки запись затёрла бы чужую правку.
        conflicted = true;
        save.disabled = true;
        save.removeAttribute("data-submit");
        modal.dialog.setAttribute("data-conflict", "true");
        modal.setError(new ApiError(409, "conflicting_changes", TASK_CONFLICT_MESSAGE));
        return;
      }
      modal.setError(err);
    }
  }, { class: "primary", testid: "task-save", "data-submit": true });

  add(modal.body,
    field("Действие", text),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Сфера"), areaGroup),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "День работы"), day, quickDays),
    extra,
    task && task.is_open ? stepsEditor(task, modal.close) : null,
    h("div", { class: "actions" },
      button("Отмена", () => modal.close(), { testid: "task-cancel" }),
      save),
  );
  modal.dialog.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) save.click();
  });
  text.focus();
}

// ───────────────────────── шаги ─────────────────────────

function newId(): UUID {
  return crypto.randomUUID();
}

/** Шаги сохраняются отдельной кнопкой и одной заменой списка, с проверкой версии задачи. */
function stepsEditor(task: Task, closeEditor: () => void): HTMLElement {
  let steps: TaskStep[] = (task.steps ?? []).map((s) => ({ ...s }));
  const list = h("ol", { class: "steps", testid: "steps-list" });
  const err = h("p", { class: "form-error", role: "alert", hidden: true, testid: "steps-error" });
  const saveBtn = button("Сохранить правки шагов", async () => {
    const cleaned = steps.map((s) => ({ ...s, text: s.text.trim() }));
    if (cleaned.some((s) => !s.text)) {
      err.textContent = "У шага должен быть текст.";
      err.hidden = false;
      return;
    }
    saveBtn.disabled = true;
    try {
      await api.saveSteps(task.id, cleaned, { revision: task.revision, updated_at: task.updated_at });
      closeEditor();
      await run(async () => undefined, "Шаги сохранены");
    } catch (e) {
      err.textContent = isConflict(e)
        ? "Задачу изменили в другом месте, пока окно было открыто. Шаги не сохранены, ваши правки остались здесь; закройте окно и откройте задачу заново, чтобы загрузить свежую версию."
        : e instanceof Error ? e.message : "Не удалось сохранить шаги.";
      err.hidden = false;
      saveBtn.disabled = false;
    }
  }, { testid: "steps-save" });

  const render = () => {
    list.replaceChildren(...steps.map((step, i) => {
      const input = h("input", { type: "text", value: step.text, testid: "step-text", "aria-label": `Шаг ${i + 1}` });
      input.addEventListener("input", () => (step.text = input.value));
      const done = h("input", { type: "checkbox", checked: Boolean(step.completed_at), testid: "step-done",
        "aria-label": `Шаг ${i + 1} выполнен` });
      done.addEventListener("change", () => (step.completed_at = done.checked ? new Date().toISOString() : null));
      return h("li", { class: "step", testid: "step-row" }, done, input,
        button("↑", () => move(i, -1), { class: "ghost icon", "aria-label": `Поднять шаг ${i + 1}`, disabled: i === 0 }),
        button("↓", () => move(i, 1), { class: "ghost icon", "aria-label": `Опустить шаг ${i + 1}`, disabled: i === steps.length - 1 }),
        button("Удалить", () => {
          steps = steps.filter((s) => s !== step);
          render();
        }, { class: "ghost", testid: "step-delete", "aria-label": `Удалить шаг ${i + 1}` }));
    }));
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const copy = steps.slice();
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    steps = copy;
    render();
  };
  render();
  return h("details", { class: "extra", open: steps.length ? true : undefined, testid: "steps" },
    h("summary", { testid: "steps-toggle" }, "Разбить на шаги"),
    h("p", { class: "quiet" }, "Шаги — части одной задачи, без своих сроков и записей дневника. Результат задачи подтверждается отдельно."),
    err, list,
    h("div", { class: "actions start" },
      button("Добавить шаг", () => {
        steps.push({ id: newId(), text: "", completed_at: null });
        render();
        list.querySelector<HTMLInputElement>("li:last-child input[type=text]")?.focus();
      }, { testid: "step-add" }),
      saveBtn));
}
