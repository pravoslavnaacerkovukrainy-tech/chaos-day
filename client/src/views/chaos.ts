// «Место хаоса»: одна строка, решение позже.
import { api } from "../api.ts";
import { run, snap } from "../app.ts";
import { button, h } from "../dom.ts";
import { openTaskEditor } from "../task.ts";
import type { ChaosItem } from "../types.ts";
import { clearDraft, draftInput, empty, header } from "./common.ts";

const DRAFT = "chaos-input";

export function chaosView(): HTMLElement {
  const s = snap();
  const input = draftInput(DRAFT, h("input", {
    type: "text", testid: "chaos-input", placeholder: "Задача, заметка или идея",
    "aria-label": "Быстрая запись в место хаоса", autocomplete: "off",
  })) as HTMLInputElement;
  const urgent = h("input", { type: "checkbox", testid: "chaos-urgent-input" });

  const save = async () => {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    // Черновик стирается только после успешной записи и до перерисовки; при ошибке он остаётся в поле.
    const ok = await run(async () => {
      const result = await api.addChaos(text, urgent.checked);
      clearDraft(DRAFT);
      return result;
    }, "Записано в место хаоса");
    if (ok) document.querySelector<HTMLInputElement>('[data-testid="chaos-input"]')?.focus();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      void save();
    }
  });

  const items = s.chaos.slice().sort((a, b) =>
    a.urgent !== b.urgent ? (a.urgent ? -1 : 1) : a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1);

  const view = h("section", { class: "view", "aria-labelledby": "view-title" },
    header("Место хаоса", "view-chaos"),
    h("p", { class: "lead" }, "Запишите одной строкой то, что сейчас занимает голову. Разобрать можно позже."),
    h("form", { class: "capture", testid: "chaos-form", onsubmit: (ev: Event) => { ev.preventDefault(); void save(); } },
      input,
      h("label", { class: "check-field signal-check" }, urgent, h("span", null, "Не может ждать")),
      h("button", { type: "submit", class: "primary", testid: "chaos-save" }, "Записать")),
    items.length
      ? h("ul", { class: "list", testid: "chaos-list", "aria-label": "Строки места хаоса" }, items.map(chaosRow))
      : empty("Место хаоса пусто. Сейчас здесь ничего нет.", "chaos-empty"),
  );
  queueMicrotask(() => {
    if (!document.activeElement || document.activeElement === document.body) input.focus();
  });
  return view;
}

function chaosRow(item: ChaosItem): HTMLLIElement {
  return h("li", { class: "chaos-row" + (item.urgent ? " urgent" : ""), testid: "chaos-item", "data-chaos-id": item.id },
    h("div", { class: "task-main" },
      h("span", { class: "task-text", testid: "chaos-text" }, item.text),
      item.urgent ? h("div", { class: "task-meta" }, h("span", { class: "meta signal", testid: "chaos-urgent" }, "Не может ждать")) : null),
    h("div", { class: "row-actions" },
      button("Это задача", () => openTaskEditor({ chaos: item }), {
        class: "ghost", testid: "chaos-to-task", "aria-label": "Это задача: " + item.text,
      }),
      button("Это заметка", () => void run(() => api.chaosToNote(item.id), "Запись стала заметкой"), {
        class: "ghost", testid: "chaos-to-note", "aria-label": "Это заметка: " + item.text,
      }),
      button(item.urgent ? "Может подождать" : "Не может ждать",
        () => void run(() => api.setChaosUrgent(item.id, !item.urgent), item.urgent ? "Отметка снята" : "Отмечено: не может ждать"), {
          class: "ghost", testid: "chaos-toggle-urgent", "aria-pressed": String(item.urgent),
        }),
      button("Снять", () => void run(() => api.deleteChaos(item.id), "Запись снята"), {
        class: "ghost", testid: "chaos-remove", "aria-label": "Снять строку: " + item.text,
      })));
}
