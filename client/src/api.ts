// Единственное место, где клиент говорит с сервером. Пути и формы — docs/web-v1-api.md.
import type {
  ChaosItem, DayKey, DiaryEntry, ImportReport, Iso, Note, NoteFolder, Project, ProjectDraft,
  ReviewGroup, Snapshot, Task, TaskDraft, TaskStep, UUID,
} from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Вызывается при 401 на защищённом пути: сессия закончилась. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

const FALLBACK: Record<number, string> = {
  400: "Запрос не принят. Проверьте введённые данные.",
  401: "Нужно войти заново.",
  403: "Действие недоступно.",
  404: "Объект не найден. Возможно, его уже удалили.",
  409: "Действие не выполнено: состояние изменилось.",
  413: "Файл слишком большой.",
  415: "Нужен файл JSON.",
  422: "Файл не удалось прочитать.",
  429: "Слишком много попыток. Подождите и попробуйте снова.",
  500: "Не удалось сохранить. Изменение не записано.",
};

async function request<T>(method: string, path: string, body?: unknown, raw?: string): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (raw !== undefined) {
    init.body = raw;
    (init.headers as Record<string, string>)["Content-Type"] = "application/json; charset=utf-8";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json; charset=utf-8";
  } else if (method !== "GET") {
    // CSRF: изменяющие запросы приходят только с application/json.
    init.body = "{}";
    (init.headers as Record<string, string>)["Content-Type"] = "application/json; charset=utf-8";
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network", "Нет связи с сервером. Изменение не записано.");
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? "http_" + response.status;
    const message = err?.message || FALLBACK[response.status] || "Что-то пошло не так.";
    if (response.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized();
    throw new ApiError(response.status, code, message);
  }
  const data = (payload as { data?: T } | null)?.data;
  return (data ?? payload) as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);
const id = (value: string) => encodeURIComponent(value);

export interface AuthState { setup_required: boolean; authenticated: boolean }

export const api = {
  authState: () => get<AuthState>("/api/auth/state"),
  setup: (password: string) => post<AuthState>("/api/auth/setup", { password }),
  login: (password: string) => post<AuthState>("/api/auth/login", { password }),
  logout: () => post<AuthState>("/api/auth/logout"),

  state: () => get<Snapshot>("/api/state"),
  setTimezone: (timezone: string) => patch<{ timezone: string; today: DayKey }>("/api/meta", { timezone }),
  day: (date?: DayKey) =>
    get<{ date: DayKey; is_today: boolean; tasks: Task[] }>("/api/day" + (date ? "?date=" + date : "")),
  review: (date?: DayKey) =>
    get<{ date: DayKey; groups: ReviewGroup[] }>("/api/review" + (date ? "?date=" + date : "")),
  search: (q: string, includeCompleted: boolean, includeRemoved: boolean) =>
    get<{ tasks: Task[]; projects: Project[]; chaos: ChaosItem[] }>(
      "/api/search?q=" + encodeURIComponent(q) +
        "&include_completed=" + (includeCompleted ? "1" : "0") +
        "&include_removed=" + (includeRemoved ? "1" : "0"),
    ),

  addChaos: (text: string, urgent = false) => post<{ chaos: ChaosItem }>("/api/chaos", { text, urgent }),
  setChaosUrgent: (chaosId: UUID, urgent: boolean) =>
    post<{ chaos: ChaosItem }>(`/api/chaos/${id(chaosId)}/urgent`, { urgent }),
  chaosToTask: (chaosId: UUID, draft: TaskDraft) =>
    post<{ task: Task; removed_chaos_id: UUID }>(`/api/chaos/${id(chaosId)}/to-task`, draft),
  chaosToNote: (chaosId: UUID) =>
    post<{ note: Note; removed_chaos_id: UUID }>(`/api/chaos/${id(chaosId)}/to-note`, {}),
  deleteChaos: (chaosId: UUID) => del<{ removed_chaos_id: UUID }>(`/api/chaos/${id(chaosId)}`),

  createTask: (draft: TaskDraft) => post<{ task: Task }>("/api/tasks", draft),
  updateTask: (taskId: UUID, draft: Partial<TaskDraft>) => patch<{ task: Task }>(`/api/tasks/${id(taskId)}`, draft),
  reschedule: (taskId: UUID, day: DayKey | "") =>
    post<{ task: Task }>(`/api/tasks/${id(taskId)}/reschedule`, { day }),
  complete: (taskId: UUID) => post<{ task: Task; entry: DiaryEntry }>(`/api/tasks/${id(taskId)}/complete`),
  reopen: (taskId: UUID) =>
    post<{ task: Task; outcome: "removed_entry" | "kept_entry" | "no_entry"; entry: DiaryEntry | null }>(
      `/api/tasks/${id(taskId)}/reopen`,
    ),
  remove: (taskId: UUID, reason: string) => post<{ task: Task }>(`/api/tasks/${id(taskId)}/remove`, { reason }),
  returnToWork: (taskId: UUID) => post<{ task: Task }>(`/api/tasks/${id(taskId)}/return-to-work`),
  setAtRisk: (taskId: UUID, atRisk: boolean) =>
    post<{ task: Task }>(`/api/tasks/${id(taskId)}/at-risk`, { at_risk: atRisk }),
  saveSteps: (taskId: UUID, steps: TaskStep[], baseUpdatedAt: Iso) =>
    post<{ task: Task }>(`/api/tasks/${id(taskId)}/steps`, { steps, base_updated_at: baseUpdatedAt }),
  deleteTask: (taskId: UUID) => del<{ removed_task_id: UUID }>(`/api/tasks/${id(taskId)}`),

  createProject: (draft: ProjectDraft) => post<{ project: Project }>("/api/projects", draft),
  updateProject: (projectId: UUID, draft: Partial<ProjectDraft>) =>
    patch<{ project: Project }>(`/api/projects/${id(projectId)}`, draft),
  setNextAction: (projectId: UUID, taskId: UUID | null) =>
    post<{ project: Project }>(`/api/projects/${id(projectId)}/next-action`, { task_id: taskId }),
  archiveProject: (projectId: UUID, archived: boolean) =>
    post<{ project: Project }>(`/api/projects/${id(projectId)}/archive`, { archived }),
  deleteProject: (projectId: UUID) => del<{ removed_project_id: UUID }>(`/api/projects/${id(projectId)}`),

  addEntry: (text: string, context: string | null, timestamp?: Iso) =>
    post<{ entry: DiaryEntry }>("/api/entries", timestamp ? { text, context, timestamp } : { text, context }),
  updateEntry: (entryId: UUID, body: { text?: string; context?: string | null; timestamp?: Iso }) =>
    patch<{ entry: DiaryEntry }>(`/api/entries/${id(entryId)}`, body),
  deleteEntry: (entryId: UUID) => del<{ removed_entry_id: UUID }>(`/api/entries/${id(entryId)}`),

  createNote: (title: string, body: string, folderId: UUID | null) =>
    post<{ note: Note }>("/api/notes", { title, body, folder_id: folderId }),
  updateNote: (noteId: UUID, body: Partial<Pick<Note, "title" | "body" | "folder_id" | "pinned">>) =>
    patch<{ note: Note }>(`/api/notes/${id(noteId)}`, body),
  deleteNote: (noteId: UUID) => del<{ removed_note_id: UUID }>(`/api/notes/${id(noteId)}`),
  createFolder: (name: string, parentId: UUID | null) =>
    post<{ note_folder: NoteFolder }>("/api/note-folders", { name, parent_id: parentId }),
  updateFolder: (folderId: UUID, body: { name?: string; parent_id?: UUID | null }) =>
    patch<{ note_folder: NoteFolder }>(`/api/note-folders/${id(folderId)}`, body),
  deleteFolder: (folderId: UUID) =>
    del<{ removed_folder_id: UUID; moved_up: number }>(`/api/note-folders/${id(folderId)}`),

  importFile: (text: string, mode: "merge" | "overwrite") =>
    request<ImportReport>("POST", "/api/import?mode=" + mode, undefined, text),
};

export const EXPORT_JSON_URL = "/api/export.json";
export const EXPORT_MD_URL = "/api/export.md";
