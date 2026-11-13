// Общие элементы: строка состояния, ошибки, модальные окна.
import { h, clear, button } from "./dom.ts";
import { ApiError } from "./api.ts";

let statusEl: HTMLElement | null = null;
let errorEl: HTMLElement | null = null;
let statusTimer: number | undefined;

export function mountChrome(root: HTMLElement): void {
  statusEl = h("div", { class: "status", role: "status", "aria-live": "polite", testid: "status" });
  errorEl = h("div", { class: "error-banner", role: "alert", testid: "error", hidden: true });
  root.append(errorEl, statusEl);
}

/** Короткое подтверждение действия. Исчезает само, ничего не оценивает. */
export function say(message: string): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.add("visible");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => statusEl?.classList.remove("visible"), 3200);
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Что-то пошло не так. Изменение не записано.";
}

/** Ошибка остаётся видимой, пока человек её не закроет или не выполнит следующее действие. */
export function showError(err: unknown): void {
  if (!errorEl) return;
  clear(errorEl);
  errorEl.append(
    h("span", null, errorText(err)),
    button("Закрыть", () => hideError(), { class: "link", testid: "error-dismiss" }),
  );
  errorEl.hidden = false;
}

export function hideError(): void {
  if (errorEl) errorEl.hidden = true;
}

export interface Modal {
  dialog: HTMLDialogElement;
  body: HTMLElement;
  error: HTMLElement;
  close: () => void;
  setError: (err: unknown | null) => void;
  setBusy: (busy: boolean) => void;
}

/**
 * Модальное окно. Esc и «Отмена» закрывают без сохранения: черновик просто исчезает,
 * сервер не вызывается. Ошибка сохранения показывается внутри окна, введённое остаётся.
 */
export function openModal(title: string, testid: string, onClose?: () => void): Modal {
  const titleId = testid + "-title";
  const error = h("p", { class: "form-error", role: "alert", testid: testid + "-error", hidden: true });
  const body = h("div", { class: "modal-body" });
  const dialog = h("dialog", { class: "modal", testid, "aria-labelledby": titleId },
    h("h2", { id: titleId, class: "modal-title" }, title), error, body);
  document.body.append(dialog);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
    onClose?.();
  };
  dialog.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    close();
  });
  dialog.showModal();
  return {
    dialog, body, error, close,
    setError(err) {
      if (err === null) {
        error.hidden = true;
        error.textContent = "";
      } else {
        error.textContent = errorText(err);
        error.hidden = false;
      }
    },
    setBusy(busy) {
      dialog.toggleAttribute("aria-busy", busy);
      dialog.querySelectorAll<HTMLButtonElement>("button[data-submit]").forEach((b) => (b.disabled = busy));
    },
  };
}

/** Подтверждение необратимого действия. */
export function confirmAction(title: string, text: string, confirmLabel: string, testid: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal(title, testid, () => {
      if (!answered) resolve(false);
    });
    modal.body.append(
      h("p", null, text),
      h("div", { class: "actions" },
        button("Отмена", () => modal.close(), { testid: testid + "-cancel" }),
        button(confirmLabel, () => {
          answered = true;
          resolve(true);
          modal.close();
        }, { class: "primary", testid: testid + "-confirm" })),
    );
  });
}
