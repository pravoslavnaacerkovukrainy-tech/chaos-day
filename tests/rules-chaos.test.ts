import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClock, createTestStore, ids, throwsCode } from './helpers.ts';

describe('Строка места хаоса', () => {
  it('ещё не задача и не заметка: без сферы, проекта и трёх дат', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Уточнить, нужен ли новый договор', false);

    assert.equal(item.text, 'Уточнить, нужен ли новый договор');
    assert.equal(item.urgent, false);
    assert.equal(store.listTasks().length, 0, 'строка не становится задачей сама');
    assert.equal(store.listNotes().length, 0, 'строка не становится заметкой сама');
    assert.equal(store.listEntries().length, 0, 'дневник не пополняется');
  });

  it('«Не может ждать» показывает строку, но не назначает дат', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Перезвонить в сервис', true);
    const urgent = store.setChaosUrgent(item.id, true);

    assert.equal(urgent.urgent, true);
    assert.equal(store.listTasks().length, 0);
    assert.equal(store.listNotes().length, 0);

    const calmed = store.setChaosUrgent(item.id, false);
    assert.equal(calmed.urgent, false);
  });

  it('срочные выше, новые раньше', () => {
    const clock = createClock();
    const { store } = createTestStore({ clock });
    store.addChaos('Первая строка', false);
    clock.advanceSeconds(10);
    store.addChaos('Вторая строка', false);
    clock.advanceSeconds(10);
    store.addChaos('Срочная строка', true);

    const texts = store.listChaos().map((item) => item.text);
    assert.deepEqual(texts, ['Срочная строка', 'Вторая строка', 'Первая строка']);
  });

  it('отмена разбора оставляет строку с прежним идентификатором', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Строка до отмены', false);

    // Отмена — это отсутствие вызова: сервер ничего не меняет.
    assert.deepEqual(ids(store.listChaos()), [item.id]);
    assert.equal(store.listTasks().length, 0);
  });

  it('разбор атомарен: ошибка сохранения оставляет строку с прежним id', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Строка, которую не удалось разобрать', false);

    store.armFault('save', 1);
    throwsCode(() => store.chaosToTask(item.id, { text: 'Строка, которую не удалось разобрать' }), 'save_failed');

    const after = store.listChaos();
    assert.equal(after.length, 1, 'строка осталась на месте');
    assert.equal(after[0]?.id, item.id, 'идентификатор строки прежний');
    assert.equal(store.listTasks().length, 0, 'задача не создалась');

    store.armFault('save', 1);
    throwsCode(() => store.chaosToNote(item.id), 'save_failed');
    assert.equal(store.listChaos().length, 1);
    assert.equal(store.listNotes().length, 0);

    // После сбоя тот же разбор проходит.
    const result = store.chaosToTask(item.id, { text: 'Строка, которую не удалось разобрать' });
    assert.equal(result.removed_chaos_id, item.id);
    assert.equal(store.listChaos().length, 0);
    assert.equal(store.listTasks().length, 1);
  });

  it('«Это задача»: срочная строка получает угрозу и не получает дат', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Срочно оплатить штраф', true);
    const { task } = store.chaosToTask(item.id, { text: 'Срочно оплатить штраф', area: 'personal' });

    assert.equal(task.at_risk, true, 'пометка «Не может ждать» переходит в угрозу');
    assert.equal(task.day, '');
    assert.equal(task.deadline, null);
    assert.equal(task.review_date, null);
    assert.equal(task.status, 'ready');
    assert.equal(store.listChaos().length, 0);
    assert.equal(store.listEntries().length, 0, 'разбор не пополняет дневник');
  });

  it('«Это задача»: не срочная строка не получает угрозу', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Записаться к стоматологу', false);
    const { task } = store.chaosToTask(item.id, { text: 'Записаться к стоматологу' });

    assert.equal(task.at_risk, false);
    assert.equal(task.day, '');
    assert.equal(task.deadline, null);
  });

  it('«Это задача» принимает заполненный черновик и сохраняет сферу', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Короткая строка', false);
    const { task } = store.chaosToTask(item.id, {
      text: 'Согласовать отчёт с Ольгой',
      area: 'work',
      day: '2026-11-14',
      deadline: '2026-11-17',
      promised_to: 'Ольга',
    });

    assert.equal(task.text, 'Согласовать отчёт с Ольгой');
    assert.equal(task.area, 'work');
    assert.equal(task.day, '2026-11-14');
    assert.equal(task.deadline, '2026-11-17');
    assert.equal(task.promised_to, 'Ольга');
  });

  it('«Это заметка»: заголовок — первая строка, тело — весь текст', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Список контактов ЖЭКа\nДиспетчер: 15-00', false);
    const { note, removed_chaos_id } = store.chaosToNote(item.id);

    assert.equal(removed_chaos_id, item.id);
    assert.equal(note.title, 'Список контактов ЖЭКа');
    assert.equal(note.body, 'Список контактов ЖЭКа\nДиспетчер: 15-00');
    assert.equal(store.listChaos().length, 0);
    assert.equal(store.listEntries().length, 0);
  });

  it('снятие строки мгновенное: без причины и без записи дневника', () => {
    const { store } = createTestStore();
    const item = store.addChaos('Строка, которая больше не нужна', true);

    const removed = store.deleteChaos(item.id);
    assert.equal(removed, item.id);
    assert.equal(store.listChaos().length, 0);
    assert.equal(store.listEntries().length, 0, 'снятие строки не пишет дневник');
    assert.equal(store.listTasks().length, 0, 'снятие строки не создаёт задачу');

    throwsCode(() => store.deleteChaos(item.id), 'not_found');
  });

  it('прежняя задача со статусом входящих остаётся задачей', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Прежняя входящая задача', status: 'inbox' });

    assert.equal(task.status, 'inbox');
    assert.equal(store.listChaos().length, 0, 'она не превращается в строку места хаоса');
    assert.equal(store.listTasks().length, 1, 'и не дублируется');
  });

  it('пустая строка не сохраняется', () => {
    const { store } = createTestStore();
    throwsCode(() => store.addChaos('   ', false), 'empty_text');
  });
});
