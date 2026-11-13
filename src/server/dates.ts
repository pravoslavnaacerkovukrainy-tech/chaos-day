/**
 * Календарные даты владельца.
 *
 * Подстраховка известного дефекта Mac-версии: срок, записанный календарной датой,
 * не должен переезжать на соседний день из-за UTC. Поэтому все три даты задачи
 * живут как текст ГГГГ-ММ-ДД и сравниваются лексически, а моменты времени
 * переводятся в календарный день только через часовой пояс владельца.
 */
import { ApiError, MESSAGES } from './errors.ts';
import type { DayKey, Iso } from './types.ts';

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dayFormatters.get(timeZone);
  if (cached) return cached;
  if (!isValidTimeZone(timeZone)) {
    throw new ApiError(400, 'invalid_timezone', MESSAGES.invalidTimezone(timeZone));
  }
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  dayFormatters.set(timeZone, created);
  return created;
}

/** Календарный день момента времени в часовом поясе владельца. */
export function dayKeyFromDate(instant: Date, timeZone: string): DayKey {
  const parts = dayFormatter(timeZone).formatToParts(instant);
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

export function todayKey(timeZone: string, now: Date = new Date()): DayKey {
  return dayKeyFromDate(now, timeZone);
}

export function isValidDayKey(value: unknown): value is DayKey {
  if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const round = new Date(Date.UTC(year, month - 1, day));
  return (
    round.getUTCFullYear() === year &&
    round.getUTCMonth() === month - 1 &&
    round.getUTCDate() === day
  );
}

export function assertDayKey(value: unknown, what: string): DayKey {
  if (!isValidDayKey(value)) {
    throw new ApiError(400, 'invalid_date', `${what}: ${MESSAGES.invalidDate(value)}`);
  }
  return value;
}

/** Пустая строка, null и undefined означают «день не выбран». */
export function optionalDayKey(value: unknown, what: string): DayKey | null {
  if (value === null || value === undefined || value === '') return null;
  return assertDayKey(value, what);
}

/** День работы: пустая строка допустима и означает отсутствие дня. */
export function workDayKey(value: unknown, what: string): DayKey | '' {
  if (value === null || value === undefined || value === '') return '';
  return assertDayKey(value, what);
}

export function parseIso(value: unknown, what: string): number {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    throw new ApiError(400, 'invalid_request', `${what}: ${MESSAGES.invalidTimestamp(value)}`);
  }
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new ApiError(400, 'invalid_request', `${what}: ${MESSAGES.invalidTimestamp(value)}`);
  }
  return ms;
}

export function isoOf(ms: number | null | undefined): Iso | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export function requireIso(ms: number | null | undefined, what: string): Iso {
  const value = isoOf(ms);
  if (value === null) throw new ApiError(400, 'invalid_request', `${what}: время не задано.`);
  return value;
}

/**
 * Сдвиг календарного дня. Арифметика идёт в UTC над самим ключом, поэтому
 * часовые пояса и переходы на летнее время на результат не влияют.
 */
export function shiftDayKey(key: DayKey, days: number): DayKey {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  const y = String(moved.getUTCFullYear()).padStart(4, '0');
  const m = String(moved.getUTCMonth() + 1).padStart(2, '0');
  const d = String(moved.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** День из ISO-момента в часовом поясе владельца. */
export function dayKeyFromIso(iso: Iso, timeZone: string): DayKey {
  return dayKeyFromDate(new Date(iso), timeZone);
}
