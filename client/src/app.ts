// Состояние клиента. Канон — сервер: после каждого изменения берём свежий снимок.
import { api } from "./api.ts";
import type { Area, DayKey, Snapshot, Task, Project } from "./types.ts";
import { hideError, say, showError } from "./ui.ts";

export type Route = "chaos" | "plan" | "projects" | "waiting" | "review" | "tasks" | "notes" | "diary" | "data";

export const ROUTES: { id: Route; title: string }[] = [
  { id: "chaos", title: "Место хаоса" },
  { id: "plan", title: "План" },
  { id: "projects", title: "Проекты" },
  { id: "waiting", title: "Ожидаю" },
  { id: "review", title: "Обзор" },
  { id: "tasks", title: "Все задачи" },
  { id: "notes", title: "Заметки" },
  { id: "diary", title: "Дневник" },
  { id: "data", title: "Импорт и экспорт" },
];

export type AreaFilter = "all" | Area;

export const app = {
  snapshot: null as Snapshot | null,
  area: "all" as AreaFilter,
  /** Выбранный день плана; null — «Сегодня» по часовому поясу владельца. */
  planDay: null as DayKey | null,
  /** Выбранный день дневника. */
  diaryDay: null as DayKey | null,
  showCompleted: false,
  showRemoved: false,
  showArchived: false,
  /** Черновики полей ввода по ключу. Живут до перезагрузки страницы и в экспорт не попадают. */
  drafts: new Map<string, string>(),
  rerender: () => {},
  /**
   * Версия данных. Растёт после каждого успешного изменения, ещё до прихода свежего снимка:
   * выборки сервера (План, Обзор), полученные раньше, становятся недействительными.
   */
  version: 0,
};

export function snap(): Snapshot {
  if (!app.snapshot) throw new Error("снимок ещё не загружен");
  return app.snapshot;
}

export function today(): DayKey {
  return snap().today;
}

export async function loadSnapshot(): Promise<void> {
  app.snapshot = await api.state();
}

export async function refresh(): Promise<void> {
  try {
    await loadSnapshot();
  } catch (err) {
    showError(err);
  }
  app.rerender();
}

/**
 * Выполнить изменение. Успех — подтверждение и свежий снимок. Ошибка — красная строка,
 * данные на экране остаются прежними (сервер откатывает изменение целиком).
 */
export async function run<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await action();
    app.version++;
    hideError();
    if (success) say(success);
    await refresh();
    return result;
  } catch (err) {
    showError(err);
    return undefined;
  }
}

export function areaMatches(area: Area): boolean {
  return app.area === "all" || app.area === area;
}

export function projectById(id: string | null): Project | undefined {
  if (!id) return undefined;
  return snap().projects.find((p) => p.id === id);
}

export function taskById(id: string): Task | undefined {
  return snap().tasks.find((t) => t.id === id);
}

export const STATUS_TITLES: Record<string, string> = {
  inbox: "Место хаоса",
  ready: "Можно делать",
  waiting: "Ожидаю",
  paused: "Отложено",
  removed: "Снято",
};

export const AREA_TITLES: Record<Area, string> = { work: "Работа", personal: "Личное" };

/** Каноничный порядок задач Mac: день, затем время создания, затем id. */
export function taskOrder(a: Task, b: Task): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}
