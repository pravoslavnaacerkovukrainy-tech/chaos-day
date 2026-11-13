import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/server/db.ts';
import { ApiError } from '../src/server/errors.ts';
import { Store } from '../src/server/store.ts';
import type { Task } from '../src/server/types.ts';

/** Часы проверок: 13 ноября 2026, 09:00 UTC = 11:00 в Europe/Kyiv. */
export const FIXED_NOW_ISO = '2026-11-13T09:00:00.000Z';
export const TODAY = '2026-11-13';
export const TEST_TIMEZONE = 'Europe/Kyiv';

export interface TestClock {
  now: () => Date;
  set: (iso: string) => void;
  advanceSeconds: (seconds: number) => void;
}

export function createClock(start: string = FIXED_NOW_ISO): TestClock {
  let ms = new Date(start).getTime();
  return {
    now: () => new Date(ms),
    set: (iso: string) => {
      ms = new Date(iso).getTime();
    },
    advanceSeconds: (seconds: number) => {
      ms += seconds * 1000;
    },
  };
}

export interface TestContext {
  store: Store;
  clock: TestClock;
}

export function createTestStore(
  options: { timeZone?: string; clock?: TestClock } = {},
): TestContext {
  const clock = options.clock ?? createClock();
  const db = openDatabase(':memory:');
  const store = new Store(db, {
    timeZone: options.timeZone ?? TEST_TIMEZONE,
    sessionTtlSec: 60,
    now: clock.now,
  });
  return { store, clock };
}

export function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

export function ids(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id);
}

/** Проверяет, что вызов бросает ApiError с ожидаемым кодом. */
export function throwsCode(fn: () => unknown, code: string, note?: string): ApiError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  const label = note === undefined ? code : `${code} (${note})`;
  assert.ok(caught !== undefined, `ожидалась ошибка ${label}, но вызов завершился успешно`);
  assert.ok(caught instanceof ApiError, `ожидалась ApiError ${label}, получено ${String(caught)}`);
  assert.equal(caught.code, code, note);
  return caught;
}

export function findByText(tasks: readonly Task[], text: string): Task {
  const found = tasks.find((task) => task.text === text);
  assert.ok(found !== undefined, `задача «${text}» не найдена`);
  return found;
}
