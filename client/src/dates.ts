// Календарные даты как строки YYYY-MM-DD. Никаких Date в UTC для дней: срок не уезжает.
import type { DayKey, Iso } from "./types.ts";

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(key: DayKey): [number, number, number] {
  const m = KEY.exec(key);
  if (!m) throw new Error("bad day key " + key);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Сдвиг календарного дня. Считаем в UTC-полдень, чтобы переход на летнее время не мешал. */
export function addDays(key: DayKey, days: number): DayKey {
  const [y, m, d] = parts(key);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + days);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
  "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

const WEEKDAYS_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function dayIndex(key: DayKey): number {
  const [y, m, d] = parts(key);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export function weekday(key: DayKey): string {
  return WEEKDAYS[dayIndex(key)] ?? "";
}

export function weekdayShort(key: DayKey): string {
  return WEEKDAYS_SHORT[dayIndex(key)] ?? "";
}

/** Число месяца без ведущего нуля. */
export function dayOfMonth(key: DayKey): number {
  return parts(key)[2];
}

/** Семь календарных дней недели, содержащей день: с понедельника по воскресенье. */
export function weekOf(key: DayKey): DayKey[] {
  const monday = addDays(key, -((dayIndex(key) + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** «13 ноября» или «13 ноября 2027», если год другой. */
export function shortDate(key: DayKey, today?: DayKey): string {
  const [y, m, d] = parts(key);
  const sameYear = today ? parts(today)[0] === y : false;
  return `${d} ${MONTHS[m - 1]}${sameYear ? "" : " " + y}`;
}

/** Относительное имя дня для заголовка плана. */
export function relativeName(key: DayKey, today: DayKey): string | null {
  if (key === today) return "Сегодня";
  if (key === addDays(today, 1)) return "Завтра";
  if (key === addDays(today, -1)) return "Вчера";
  return null;
}

export function dayLabel(key: DayKey, today: DayKey): string {
  return relativeName(key, today) ?? shortDate(key, today);
}

/** Время записи в часовом поясе владельца. */
export function timeIn(iso: Iso, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: timezone })
      .format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
}

/**
 * Перевод «дата + время» в часовом поясе владельца в момент ISO.
 * Поиск смещения пояса через Intl, без сторонних библиотек.
 */
export function zonedToIso(day: DayKey, time: string, timezone: string): Iso {
  const [y, m, d] = parts(day);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh ?? 0, mm ?? 0);
  const offset = (at: number) => {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(at));
    const v = (t: string) => Number(f.find((p) => p.type === t)?.value);
    return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) - at;
  };
  let ts = guess - offset(guess);
  ts = guess - offset(ts);
  return new Date(ts).toISOString();
}

export function isDayKey(value: string): boolean {
  return KEY.test(value);
}
