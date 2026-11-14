// «Заметки»: Markdown вне календаря, дерево папок, поиск только по заметкам.
import { api, ApiError } from "../api.ts";
import { app, run, snap } from "../app.ts";
import { button, field, h, setChildren } from "../dom.ts";
import type { Note, NoteFolder, UUID } from "../types.ts";
import { confirmAction, openModal, say, showError } from "../ui.ts";
import { draftInput, empty, header } from "./common.ts";
import { renderMarkdown } from "../markdown.ts";
import { applyEdit, formatEdit, type FormatAction } from "../markdown-format.ts";

/** "all" — все заметки, "none" — «Без папки», иначе id папки. */
let folder: "all" | "none" | UUID = "all";
let selected: UUID | "new" | null = null;
let mode: "view" | "edit" = "view";
const editing = new Map<string, { title: string; body: string }>();
/** Выделение в тексте заметки: переживает переключение «Редактор ↔ Просмотр». */
const carets = new Map<string, [number, number]>();
/** Папка, выбранная для ещё не сохранённой заметки. */
let newFolder: string | null = null;

export function notesView(): HTMLElement {
  const s = snap();
  if (folder !== "all" && folder !== "none" && !s.note_folders.some((f) => f.id === folder)) folder = "all";
  if (selected && selected !== "new" && !s.notes.some((n) => n.id === selected)) selected = null;

  const search = draftInput("notes-search", h("input", {
    type: "search", placeholder: "Найти заметку", "aria-label": "Поиск по заметкам", testid: "notes-search",
  })) as HTMLInputElement;
  const listWrap = h("div", { class: "notes-list" });
  const renderList = () => {
    const q = search.value.trim().toLocaleLowerCase("ru");
    const notes = s.notes
      .filter((n) => folder === "all" || (folder === "none" ? !n.folder_id : n.folder_id === folder))
      .filter((n) => !q || n.title.toLocaleLowerCase("ru").includes(q) || n.body.toLocaleLowerCase("ru").includes(q))
      .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.created_at < b.created_at ? 1 : -1));
    setChildren(listWrap, notes.length
      ? h("ul", { class: "list", testid: "notes-list" }, notes.map((n) => h("li", null,
          button((n.pinned ? "★ " : "") + (n.title || "Без заголовка"), () => {
            selected = n.id;
            mode = "view";
            app.rerender();
          }, { class: "note-link" + (selected === n.id ? " active" : ""), testid: "note-item", "aria-current": selected === n.id ? "true" : undefined }))))
      : empty(q ? "Заметок не найдено" : "Здесь пока нет заметок. Сейчас здесь ничего нет.", "notes-empty"));
  };
  search.addEventListener("input", renderList);
  renderList();

  return h("section", { class: "view", "aria-labelledby": "view-title" },
    header("Заметки", "view-notes",
      button("Новая заметка", () => {
        if (selected !== "new") newFolder = null;
        selected = "new";
        mode = "edit";
        app.rerender();
      }, { class: "primary", testid: "note-new" })),
    h("div", { class: "notes-layout" },
      h("aside", { class: "folders", "aria-label": "Папки заметок" }, folderTree(s.note_folders),
        h("div", { class: "actions start" },
          button("Новая папка", () => openFolderDialog(null), { class: "ghost", testid: "folder-new" }),
          folder !== "all" && folder !== "none"
            ? button("Новая подпапка", () => openFolderDialog(folder as UUID), { class: "ghost", testid: "folder-new-sub" }) : null)),
      h("div", { class: "notes-col" }, h("div", { class: "search", role: "search" }, search), listWrap),
      h("div", { class: "note-pane" }, selected ? noteEditor(selected === "new" ? null : s.notes.find((n) => n.id === selected) ?? null) : empty("Выберите заметку или создайте новую.", "note-none"))),
  );
}

function folderTree(folders: NoteFolder[]): HTMLElement {
  const item = (id: "all" | "none" | UUID, label: string, depth: number, f?: NoteFolder) =>
    h("li", { style: `--depth:${depth}` },
      h("div", { class: "folder-row" },
        button(label, () => {
          folder = id;
          app.rerender();
        }, { class: "folder" + (folder === id ? " active" : ""), testid: "folder-item", "aria-current": folder === id ? "true" : undefined }),
        f && folder === id ? h("span", { class: "folder-actions" },
          button("Переименовать…", () => openFolderDialog(f.parent_id, f), { class: "link", testid: "folder-rename" }),
          button("Удалить", async () => {
            const ok = await confirmAction("Удалить папку?",
              f.parent_id ? "Заметки и подпапки перейдут на уровень выше." : "Заметки останутся в «Без папки», подпапки станут верхним уровнем.",
              "Удалить", "confirm-folder-delete");
            if (ok) {
              folder = "all";
              await run(() => api.deleteFolder(f.id), "Папка удалена");
            }
          }, { class: "link danger", testid: "folder-delete" })) : null));
  const rows: HTMLElement[] = [item("all", "Все заметки", 0), item("none", "Без папки", 0)];
  const walk = (parent: UUID | null, depth: number) => {
    folders.filter((f) => f.parent_id === parent).sort((a, b) => a.name.localeCompare(b.name, "ru")).forEach((f) => {
      rows.push(item(f.id, f.name, depth, f));
      walk(f.id, depth + 1);
    });
  };
  walk(null, 0);
  return h("ul", { class: "folder-tree", testid: "folder-tree" }, rows);
}

function openFolderDialog(parent: UUID | null, existing?: NoteFolder): void {
  const modal = openModal(existing ? "Переименовать папку" : parent ? "Новая подпапка" : "Новая папка", "folder-dialog");
  const name = h("input", { type: "text", value: existing?.name ?? "", testid: "folder-name-input", required: true });
  const save = button(existing ? "Переименовать" : "Создать", async () => {
    if (!name.value.trim()) return;
    modal.setBusy(true);
    try {
      if (existing) await api.updateFolder(existing.id, { name: name.value.trim() });
      else {
        const r = await api.createFolder(name.value.trim(), parent);
        folder = r.note_folder.id;
      }
      modal.close();
      await run(async () => undefined, "Папка сохранена");
    } catch (err) {
      modal.setError(err);
      modal.setBusy(false);
    }
  }, { class: "primary", testid: "folder-save", "data-submit": true });
  modal.body.append(field("Название папки", name),
    h("div", { class: "actions" }, button("Отмена", () => modal.close(), { testid: "folder-cancel" }), save));
  name.focus();
}

const FORMATS: { action: FormatAction; label: string; name: string; key?: string }[] = [
  { action: "heading", label: "H", name: "Заголовок" },
  { action: "bold", label: "Ж", name: "Жирный", key: "b" },
  { action: "italic", label: "К", name: "Курсив", key: "i" },
  { action: "bullet", label: "•", name: "Маркированный список" },
  { action: "ordered", label: "1.", name: "Нумерованный список" },
  { action: "quote", label: "❝", name: "Цитата" },
  { action: "code", label: "</>", name: "Код" },
  { action: "link", label: "Ссылка", name: "Ссылка", key: "k" },
];
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** Применить правку к полю так, чтобы её можно было отменить ⌘Z, и сообщить об изменении. */
function applyFormat(area: HTMLTextAreaElement, action: FormatAction): void {
  const e = formatEdit(action, area.value, area.selectionStart, area.selectionEnd);
  area.focus();
  area.setSelectionRange(e.from, e.to);
  // execCommand сохраняет историю отмены; если браузер его не поддерживает — прямая замена.
  const expected = applyEdit(area.value, e);
  let native = false;
  try {
    native = e.insert ? document.execCommand("insertText", false, e.insert) : document.execCommand("delete");
  } catch {
    native = false;
  }
  if (area.value !== expected) {
    area.value = expected;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (!native) {
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
  area.setSelectionRange(e.selStart, e.selEnd);
  carets.set(area.dataset.key ?? "", [e.selStart, e.selEnd]);
}

function formatBar(area: HTMLTextAreaElement): HTMLElement {
  const buttons = FORMATS.map((f, i) => button(f.label, () => applyFormat(area, f.action), {
    class: "fmt fmt-" + f.action,
    "aria-label": f.name, title: f.name + (f.key ? ` (${MOD}${f.key.toUpperCase()})` : ""),
    "aria-keyshortcuts": f.key ? (MOD === "⌘" ? "Meta+" : "Control+") + f.key.toUpperCase() : undefined,
    tabindex: i === 0 ? "0" : "-1", testid: `note-format-${f.action}`,
    // Нажатие не уводит фокус из текста: выделение остаётся на месте.
    onmousedown: (ev: MouseEvent) => ev.preventDefault(),
  }));
  const bar = h("div", { class: "format-bar", role: "toolbar", "aria-label": "Форматирование Markdown", "aria-controls": "note-body", testid: "note-format-bar" }, buttons);
  // Одна остановка Tab на всю панель, внутри — стрелки, Home и End.
  bar.addEventListener("keydown", (ev) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = ev.key === "ArrowRight" ? (i + 1) % buttons.length : ev.key === "ArrowLeft" ? (i - 1 + buttons.length) % buttons.length
      : ev.key === "Home" ? 0 : ev.key === "End" ? buttons.length - 1 : -1;
    if (next < 0) return;
    ev.preventDefault();
    buttons[i]!.tabIndex = -1;
    buttons[next]!.tabIndex = 0;
    buttons[next]!.focus();
  });
  area.addEventListener("keydown", (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
    const f = FORMATS.find((x) => x.key === ev.key.toLowerCase());
    if (!f) return;
    ev.preventDefault();
    applyFormat(area, f.action);
  });
  return bar;
}

function noteEditor(note: Note | null): HTMLElement {
  const key = note?.id ?? "new";
  const draft = editing.get(key) ?? { title: note?.title ?? "", body: note?.body ?? "" };
  const dirty = () => !note || draft.title !== note.title || draft.body !== note.body;
  const title = h("input", { type: "text", value: draft.title, testid: "note-title-input", "aria-label": "Заголовок заметки", placeholder: "Заголовок" });
  const body = h("textarea", { id: "note-body", rows: 16, value: draft.body, testid: "note-body-input", "aria-label": "Текст заметки (Markdown)", placeholder: "Здесь можно записывать идеи и мысли. Поддерживается Markdown." });
  body.dataset.key = key;
  const caret = carets.get(key);
  if (caret) body.setSelectionRange(caret[0], caret[1]);
  const sync = () => {
    draft.title = title.value;
    draft.body = body.value;
    editing.set(key, draft);
  };
  title.addEventListener("input", sync);
  body.addEventListener("input", sync);
  // Курсор запоминаем, чтобы после «Просмотра» вернуться туда же.
  const keepSel = () => { carets.set(key, [body.selectionStart, body.selectionEnd]); };
  body.addEventListener("select", keepSel);
  body.addEventListener("keyup", keepSel);
  body.addEventListener("pointerup", keepSel);
  body.addEventListener("blur", keepSel);

  const folders = snap().note_folders;
  const move = h("select", { testid: "note-folder", "aria-label": "Папка заметки" },
    h("option", { value: "" }, "Без папки"), folders.map((f) => h("option", { value: f.id }, f.name)));
  move.value = note?.folder_id ?? newFolder ?? (folder !== "all" && folder !== "none" ? folder : "");
  if (note) move.addEventListener("change", () => void run(() => api.updateNote(note.id, { folder_id: move.value || null }), "Заметка перемещена"));
  // Папка новой заметки переживает переключение в «Просмотр».
  else move.addEventListener("change", () => { newFolder = move.value; });

  const save = button("Сохранить", async () => {
    sync();
    if (!draft.title.trim() && !draft.body.trim()) {
      showError(new ApiError(400, "empty_text", "Пустую заметку сохранить нельзя."));
      return;
    }
    // Без заголовка берём первую строку текста, без маркеров Markdown в начале.
    const titleText = draft.title.trim()
      || draft.body.trim().split("\n")[0]!.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "").slice(0, 80);
    const result = await run(async () => (note
      ? (await api.updateNote(note.id, { title: titleText, body: draft.body })).note
      : (await api.createNote(titleText, draft.body, move.value || null)).note), "Заметка сохранена");
    if (result) {
      editing.delete(key);
      carets.delete(key);
      if (!note) newFolder = null;
      selected = result.id;
      mode = "view";
      app.rerender();
    }
  }, { class: "primary", testid: "note-save" });

  // Переключение не теряет черновик: текст уже в editing, режим просто перерисовывает панель.
  const setMode = (m: typeof mode) => {
    if (mode === m) return;
    mode = m;
    app.rerender();
  };
  const tabs = h("div", { class: "segmented", role: "tablist", "aria-label": "Режим заметки" },
    button("Просмотр", () => setMode("view"), { role: "tab", "aria-selected": String(mode === "view"), "aria-controls": "note-panel", testid: "note-mode-view" }),
    button("Редактор", () => setMode("edit"), { role: "tab", "aria-selected": String(mode === "edit"), "aria-controls": "note-panel", testid: "note-mode-edit" }));

  const content = mode === "edit"
    ? h("div", { class: "note-edit", id: "note-panel", role: "tabpanel", "aria-label": "Редактор" }, title, formatBar(body), body)
    : h("article", { class: "note-view", id: "note-panel", role: "tabpanel", "aria-label": "Просмотр", testid: "note-view" },
        h("h2", null, draft.title.trim() || "Без заголовка"),
        draft.body.trim()
          ? h("div", { class: "md", testid: "note-rendered" }, renderMarkdown(draft.body))
          : h("p", { class: "empty" }, "Текста пока нет."),
        !note ? h("p", { class: "quiet small", testid: "note-unsaved" }, "Заметка ещё не сохранена.") : null);

  return h("div", { class: "note-editor", testid: "note-editor" },
    h("div", { class: "note-toolbar" }, tabs, move,
      note ? button(note.pinned ? "Открепить" : "Закрепить", () => void run(() => api.updateNote(note.id, { pinned: !note.pinned }), note.pinned ? "Заметка откреплена" : "Заметка закреплена"), { class: "ghost", testid: "note-pin" }) : null),
    content,
    h("div", { class: "actions start" },
      save,
      dirty() ? button("Отменить правки", () => {
        editing.delete(key);
        carets.delete(key);
        if (!note) newFolder = null;
        if (!note) selected = null;
        mode = "view";
        app.rerender();
        say("Правки отменены");
      }, { class: "ghost", testid: "note-discard" }) : null,
      note ? button("Удалить", async () => {
        const ok = await confirmAction("Удалить заметку?", note.title || "Без заголовка", "Удалить", "confirm-note-delete");
        if (ok) {
          selected = null;
          editing.delete(key);
          await run(() => api.deleteNote(note.id), "Заметка удалена");
        }
      }, { class: "ghost danger", testid: "note-delete" }) : null));
}
