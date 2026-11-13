// Запись одной строки в «Место хаоса»: общая для быстрой формы раздела и окна «Записать».
import { api } from "./api.ts";
import { run } from "./app.ts";
import { button, h } from "./dom.ts";
import { openModal } from "./ui.ts";

export const CAPTURE_SAVED = "Записано в место хаоса";

export type CaptureResult = "saved" | "empty" | "failed";

/**
 * Записать строку. Пустую не отправляем; остальные правила проверяет сервер.
 * `onSaved` вызывается после успеха до перерисовки (например, стереть черновик),
 * `onError` получает ошибку вместо общей красной строки.
 */
export async function captureLine(
  raw: string, urgent: boolean,
  opts: { onSaved?: () => void; onError?: (err: unknown) => void } = {},
): Promise<CaptureResult> {
  const text = raw.trim();
  if (!text) return "empty";
  const ok = await run(async () => {
    const result = await api.addChaos(text, urgent);
    opts.onSaved?.();
    return result;
  }, CAPTURE_SAVED, opts.onError);
  return ok ? "saved" : "failed";
}

/**
 * Окно «Записать» из любого раздела. Enter записывает, Esc и «Отмена» закрывают без записи.
 * При ошибке окно остаётся открытым с введённым текстом. После закрытия фокус возвращается.
 */
export function openCapture(returnTo?: HTMLElement | null): void {
  const back = returnTo ?? (document.activeElement as HTMLElement | null);
  const modal = openModal("Записать в место хаоса", "capture-dialog", () => {
    if (back?.isConnected) back.focus();
    else document.querySelector<HTMLElement>('[data-testid="capture-open"]')?.focus();
  });
  const input = h("input", {
    type: "text", testid: "capture-input", placeholder: "Задача, заметка или идея",
    "aria-label": "Новая строка", autocomplete: "off",
  });
  const urgent = h("input", { type: "checkbox", testid: "capture-urgent-input" });
  const form = h("form", { class: "capture-form" },
    input,
    h("label", { class: "check-field signal-check" }, urgent, h("span", null, "Не может ждать")),
    h("p", { class: "field-hint" }, "Строка попадёт в «Место хаоса». Разобрать можно позже."),
    h("div", { class: "actions" },
      button("Отмена", () => modal.close(), { testid: "capture-cancel" }),
      h("button", { type: "submit", class: "primary", testid: "capture-save", "data-submit": true }, "Записать")));
  let busy = false;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    modal.setError(null);
    modal.setBusy(true);
    const result = await captureLine(input.value, urgent.checked, { onError: (err) => modal.setError(err) });
    busy = false;
    modal.setBusy(false);
    if (result === "saved") modal.close();
    else input.focus();
  });
  modal.body.append(form);
  input.focus();
}
