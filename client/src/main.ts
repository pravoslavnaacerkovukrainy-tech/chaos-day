// Точка входа: вход, оболочка с перечнем разделов, маршрутизация по #/раздел.
import { api, ApiError, setUnauthorizedHandler } from "./api.ts";
import { app, loadSnapshot, ROUTES, type Route } from "./app.ts";
import { button, clear, field, h } from "./dom.ts";
import { errorText, hideError, mountChrome, say } from "./ui.ts";
import { chaosView } from "./views/chaos.ts";
import { dataView } from "./views/data.ts";
import { diaryView } from "./views/diary.ts";
import { projectsView, tasksView, waitingView } from "./views/lists.ts";
import { notesView } from "./views/notes.ts";
import { planView } from "./views/plan.ts";
import { reviewView } from "./views/review.ts";
import "./styles.css";

const root = document.getElementById("app")!;
const VIEWS: Record<Route, () => HTMLElement> = {
  chaos: chaosView, plan: planView, projects: projectsView, waiting: waitingView, review: reviewView,
  tasks: tasksView, notes: notesView, diary: diaryView, data: dataView,
};

function currentRoute(): Route {
  const id = location.hash.replace(/^#\/?/, "") as Route;
  return id in VIEWS ? id : "chaos";
}

let main: HTMLElement | null = null;
let navEl: HTMLElement | null = null;
let shellEl: HTMLElement | null = null;
let lastRoute: Route | null = null;

// ───────────────────────── вход ─────────────────────────

async function showLogin(): Promise<void> {
  app.snapshot = null;
  shellEl = null;
  main = null;
  clear(root);
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  let setup = false;
  try {
    setup = (await api.authState()).setup_required;
  } catch (err) {
    root.append(h("main", { class: "login" }, h("p", { class: "form-error", role: "alert" }, errorText(err)),
      button("Повторить", () => void boot(), { class: "primary" })));
    return;
  }
  const password = h("input", { type: "password", testid: "login-password", autocomplete: setup ? "new-password" : "current-password", required: true, minlength: setup ? 8 : undefined });
  const repeat = setup ? h("input", { type: "password", testid: "login-password-repeat", autocomplete: "new-password", required: true }) : null;
  const error = h("p", { class: "form-error", role: "alert", testid: "login-error", hidden: true });
  const submit = h("button", { type: "submit", class: "primary", testid: "login-submit" }, setup ? "Задать пароль и войти" : "Войти");
  const fail = (text: string) => {
    error.textContent = text;
    error.hidden = false;
    password.focus();
  };
  const form = h("form", { class: "login-form", testid: setup ? "setup-form" : "login-form", "aria-labelledby": "login-title" },
    h("h1", { id: "login-title" }, "Хаос Дня"),
    h("p", { class: "quiet" }, setup ? "Первый запуск. Задайте пароль владельца: не короче 8 знаков. Хранится только его проверка." : "Войдите, чтобы продолжить."),
    error,
    field("Пароль", password),
    repeat ? field("Повторите пароль", repeat) : null,
    submit);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    if (setup) {
      if (password.value.length < 8) return fail("Пароль должен быть не короче 8 знаков.");
      if (repeat && repeat.value !== password.value) return fail("Пароли не совпадают.");
    } else if (!password.value) return fail("Введите пароль.");
    submit.disabled = true;
    try {
      if (setup) await api.setup(password.value);
      else await api.login(password.value);
      password.value = "";
      if (repeat) repeat.value = "";
      await boot();
    } catch (err) {
      submit.disabled = false;
      fail(err instanceof ApiError && err.status === 401 ? "Неверный пароль." : errorText(err));
    }
  });
  root.append(h("main", { class: "login" }, form));
  password.focus();
}

// ───────────────────────── оболочка ─────────────────────────

function buildShell(): void {
  clear(root);
  const toggle = h("button", { type: "button", class: "nav-toggle", "aria-expanded": "false", "aria-controls": "nav", testid: "nav-toggle" }, "Разделы");
  navEl = h("nav", { id: "nav", class: "sidebar", "aria-label": "Разделы", testid: "nav" });
  const closeNav = () => {
    shellEl?.classList.remove("nav-open");
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", () => {
    const open = !shellEl?.classList.contains("nav-open");
    shellEl?.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) navEl?.querySelector<HTMLElement>("a")?.focus();
  });
  navEl.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("a")) closeNav();
  });
  navEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && shellEl?.classList.contains("nav-open")) {
      closeNav();
      toggle.focus();
    }
  });
  main = h("main", { id: "main", class: "content", tabindex: -1 });
  shellEl = h("div", { class: "shell" },
    h("a", { class: "skip", href: "#main", onclick: (ev: Event) => { ev.preventDefault(); main?.focus(); } }, "К содержимому"),
    h("header", { class: "topbar" }, h("span", { class: "brand" }, "Хаос Дня"), toggle),
    navEl,
    h("div", { class: "scrim", "aria-hidden": "true", onclick: closeNav }),
    main);
  root.append(shellEl);
  mountChrome(root);
}

function renderNav(route: Route): void {
  if (!navEl || !app.snapshot) return;
  const s = app.snapshot;
  const counts: Partial<Record<Route, number>> = { chaos: s.chaos.length };
  navEl.replaceChildren(
    h("div", { class: "brand side-brand" }, "Хаос Дня"),
    h("ul", { class: "nav-list" }, ROUTES.map((r) => h("li", null,
      h("a", { href: "#/" + r.id, class: "nav-link" + (r.id === route ? " active" : ""), "aria-current": r.id === route ? "page" : undefined, testid: "nav-" + r.id },
        h("span", null, r.title),
        counts[r.id] ? h("span", { class: "nav-count", "aria-label": `строк: ${counts[r.id]}` }, String(counts[r.id])) : null)))),
    h("div", { class: "nav-foot" },
      button("Выйти", async () => {
        try {
          await api.logout();
        } finally {
          location.hash = "";
          await showLogin();
          say("Вы вышли");
        }
      }, { class: "link", testid: "logout" })));
}

/** Перерисовать текущий раздел, сохранив фокус, выделение и прокрутку. */
function render(): void {
  if (!main || !app.snapshot) return;
  const route = currentRoute();
  const routeChanged = route !== lastRoute;
  const active = document.activeElement as HTMLElement | null;
  const focusId = !routeChanged && active && main.contains(active) ? active.getAttribute("data-testid") : null;
  const focusRow = active?.closest("[data-task-id],[data-chaos-id],[data-entry-id],[data-project-id]");
  const rowAttr = focusRow ? ["data-task-id", "data-chaos-id", "data-entry-id", "data-project-id"].find((a) => focusRow.hasAttribute(a)) : null;
  const rowValue = rowAttr ? focusRow!.getAttribute(rowAttr) : null;
  const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? [active.selectionStart ?? null, active.selectionEnd ?? null] as const : null;
  const scroll = window.scrollY;

  renderNav(route);
  main.replaceChildren(VIEWS[route]());
  document.title = (ROUTES.find((r) => r.id === route)?.title ?? "") + " · Хаос Дня";

  if (routeChanged) {
    lastRoute = route;
    window.scrollTo(0, 0);
    const title = main.querySelector<HTMLElement>("#view-title");
    // В «Месте хаоса» курсор сразу в поле записи, как в Mac-версии.
    if (route === "chaos") main.querySelector<HTMLElement>('[data-testid="chaos-input"]')?.focus();
    else title?.focus();
  } else {
    window.scrollTo(0, scroll);
    if (focusId) {
      const scope = rowAttr && rowValue ? main.querySelector(`[${rowAttr}="${CSS.escape(rowValue)}"]`) ?? main : main;
      const el = scope.querySelector<HTMLElement>(`[data-testid="${CSS.escape(focusId)}"]`);
      if (el) {
        el.focus();
        if (selection && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          try { el.setSelectionRange(selection[0], selection[1]); } catch { /* тип поля без выделения */ }
        }
      }
    }
  }
}

async function boot(): Promise<void> {
  hideError();
  let state;
  try {
    state = await api.authState();
  } catch {
    await showLogin();
    return;
  }
  if (!state.authenticated) {
    await showLogin();
    return;
  }
  try {
    await loadSnapshot();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin();
    clear(root);
    root.append(h("main", { class: "login" }, h("p", { class: "form-error", role: "alert" }, errorText(err)),
      button("Повторить", () => void boot(), { class: "primary", testid: "retry" })));
    return;
  }
  buildShell();
  lastRoute = null;
  render();
}

app.rerender = render;
setUnauthorizedHandler(() => void showLogin());
window.addEventListener("hashchange", () => render());
void boot();
