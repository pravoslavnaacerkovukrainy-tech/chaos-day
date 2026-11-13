import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayKeyFromDate, isValidDayKey, shiftDayKey, todayKey } from '../src/server/dates.ts';
import { TEST_TIMEZONE, TODAY, createTestStore } from './helpers.ts';

describe('Календарные даты', () => {
  it('принимает только существующие дни в формате ГГГГ-ММ-ДД', () => {
    assert.equal(isValidDayKey('2026-11-13'), true);
    assert.equal(isValidDayKey('2026-02-28'), true);
    assert.equal(isValidDayKey('2024-02-29'), true, 'високосный день допустим');
    assert.equal(isValidDayKey('2026-02-30'), false, 'несуществующий день отклоняется');
    assert.equal(isValidDayKey('2026-13-01'), false);
    assert.equal(isValidDayKey('2026-00-10'), false);
    assert.equal(isValidDayKey('2026-11-13T00:00:00Z'), false, 'момент времени не является днём');
    assert.equal(isValidDayKey('13.11.2026'), false);
    assert.equal(isValidDayKey(''), false);
    assert.equal(isValidDayKey(null), false);
  });

  it('сдвигает календарный день через границы месяца и года', () => {
    assert.equal(shiftDayKey('2026-11-13', 1), '2026-11-14');
    assert.equal(shiftDayKey('2026-11-30', 1), '2026-12-01');
    assert.equal(shiftDayKey('2026-12-31', 1), '2027-01-01');
    assert.equal(shiftDayKey('2026-11-13', -13), '2026-10-31');
    assert.equal(shiftDayKey('2026-11-13', 0), '2026-11-13');
  });

  it('один и тот же момент даёт разный календарный день в разных поясах', () => {
    // 22:30 UTC — это уже следующие сутки в Киеве и ещё те же в Нью-Йорке.
    const instant = new Date('2026-11-13T22:30:00Z');
    assert.equal(dayKeyFromDate(instant, 'Europe/Kyiv'), '2026-11-14');
    assert.equal(dayKeyFromDate(instant, 'UTC'), '2026-11-13');
    assert.equal(dayKeyFromDate(instant, 'America/New_York'), '2026-11-13');
  });

  it('«сегодня» считается в часовом поясе владельца', () => {
    const { store } = createTestStore();
    assert.equal(store.timeZone, TEST_TIMEZONE);
    assert.equal(store.today(), TODAY);
    assert.equal(todayKey('UTC', new Date('2026-11-13T09:00:00Z')), '2026-11-13');
    assert.equal(todayKey('Pacific/Kiritimati', new Date('2026-11-13T09:00:00Z')), '2026-11-13');
  });
});

describe('Подстраховка календарных дат', () => {
  it('срок результата не переезжает на соседний день при смене часового пояса', () => {
    const { store } = createTestStore();
    const task = store.createTask({
      text: 'Сдать отчёт',
      deadline: '2026-11-14',
      review_date: '2026-11-20',
      day: '2026-11-13',
    });
    assert.equal(task.deadline, '2026-11-14');

    for (const zone of ['America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati', 'UTC']) {
      store.setTimeZone(zone);
      const after = store.getTask(task.id);
      assert.equal(after.deadline, '2026-11-14', `срок уехал в поясе ${zone}`);
      assert.equal(after.review_date, '2026-11-20', `дата пересмотра уехала в поясе ${zone}`);
      assert.equal(after.day, '2026-11-13', `день работы уехал в поясе ${zone}`);
    }
  });

  it('день записи дневника пересчитывается при смене часового пояса', () => {
    const { store, clock } = createTestStore();
    clock.set('2026-11-13T22:30:00Z');
    const entry = store.addEntry({ text: 'Поздняя запись' });
    assert.equal(entry.day, '2026-11-14', 'в Киеве это уже следующие сутки');

    store.setTimeZone('UTC');
    const after = store.getEntry(entry.id);
    assert.equal(after.day, '2026-11-13', 'в UTC запись остаётся в тех же сутках');
    assert.equal(after.timestamp, entry.timestamp, 'момент времени не меняется');
  });

  it('отклоняет неизвестный часовой пояс', () => {
    const { store } = createTestStore();
    assert.throws(() => store.setTimeZone('Mars/Olympus'), /Часовой пояс/);
  });
});
