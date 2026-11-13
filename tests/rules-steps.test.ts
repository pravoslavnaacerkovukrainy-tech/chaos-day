import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClock, createTestStore, throwsCode } from './helpers.ts';

describe('Шаги задачи', () => {
  it('шаг — часть задачи: только id, текст и выполнение', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    const saved = store.replaceTaskSteps(
      task.id,
      [
        { id: 'a1000000-0000-4000-8000-000000000001', text: 'Заказать справку' },
        { id: 'a1000000-0000-4000-8000-000000000002', text: 'Скачать форму' },
      ],
      task.updated_at,
    );

    assert.equal(saved.steps.length, 2);
    for (const step of saved.steps) {
      assert.deepEqual(Object.keys(step).sort(), ['completed_at', 'id', 'text']);
      assert.equal(step.completed_at, null);
    }
  });

  it('следующий незавершённый шаг виден у задачи', () => {
    const { store, clock } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    const steps = [
      { id: 'a1000000-0000-4000-8000-000000000011', text: 'Первый' },
      { id: 'a1000000-0000-4000-8000-000000000012', text: 'Второй' },
    ];
    let saved = store.replaceTaskSteps(task.id, steps, task.updated_at);
    assert.equal(saved.next_step?.text, 'Первый');

    clock.advanceSeconds(30);
    const current = store.getTask(task.id);
    saved = store.replaceTaskSteps(
      task.id,
      [{ ...steps[0], completed_at: current.updated_at }, steps[1]],
      current.updated_at,
    );
    assert.equal(saved.next_step?.text, 'Второй');
  });

  it('результат родителя подтверждается отдельно от отметок шагов', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы', day: '2026-11-13' });
    const now = new Date().toISOString();
    const saved = store.replaceTaskSteps(
      task.id,
      [
        { id: 'a1000000-0000-4000-8000-000000000021', text: 'Первый', completed_at: now },
        { id: 'a1000000-0000-4000-8000-000000000022', text: 'Второй', completed_at: now },
      ],
      task.updated_at,
    );

    assert.equal(saved.next_step, null);
    assert.equal(saved.completed_at, null, 'все шаги отмечены, но задача не выполнена');
    assert.equal(store.listEntries().length, 0, 'шаги не пишут дневник');
  });

  it('выполнение родителя сохраняет шаги', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    store.replaceTaskSteps(task.id, [{ text: 'Единственный шаг' }], task.updated_at);

    const { task: done } = store.completeTask(task.id);
    assert.equal(done.steps.length, 1);
    assert.equal(store.listEntries().length, 1, 'одна запись на задачу, а не на шаг');
  });

  it('задачу с шагами нельзя удалить, пока шаги не удалены', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    store.replaceTaskSteps(task.id, [{ text: 'Шаг' }], task.updated_at);

    throwsCode(() => store.deleteTask(task.id), 'parent_has_steps');

    const cleared = store.replaceTaskSteps(task.id, [], store.getTask(task.id).updated_at);
    assert.equal(cleared.steps.length, 0);
    assert.equal(store.deleteTask(task.id), task.id);
  });

  it('изменённый в другом месте список не затирается', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    const stale = { revision: task.revision };

    store.replaceTaskSteps(task.id, [{ text: 'Шаг из другого окна' }], stale);
    throwsCode(
      () => store.replaceTaskSteps(task.id, [{ text: 'Мой черновик' }], stale),
      'conflicting_changes',
    );

    const fresh = store.getTask(task.id);
    const saved = store.replaceTaskSteps(task.id, [{ text: 'Мой черновик' }], {
      revision: fresh.revision,
    });
    assert.deepEqual(saved.steps.map((step) => step.text), ['Мой черновик']);
  });

  it('счётчик версий растёт на каждую правку, даже в пределах одной секунды', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    assert.equal(task.revision, 0);

    const first = store.replaceTaskSteps(task.id, [{ text: 'Шаг' }], { revision: task.revision });
    assert.equal(first.revision, 1);
    assert.equal(first.updated_at, task.updated_at, 'часы проверок стоят на месте');

    const second = store.updateTask(task.id, { details: 'Уточнение' });
    assert.equal(second.revision, 2);
  });

  it('устаревшая отметка времени тоже считается конфликтом', () => {
    const clock = createClock();
    const { store } = createTestStore({ clock });
    const task = store.createTask({ text: 'Собрать документы' });
    const stale = task.updated_at;

    clock.advanceSeconds(120);
    store.updateTask(task.id, { details: 'Правка из другого окна' });
    throwsCode(() => store.replaceTaskSteps(task.id, [{ text: 'Шаг' }], stale), 'conflicting_changes');
  });

  it('выполненную задачу нельзя править до возврата в план', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    store.completeTask(task.id);
    throwsCode(() => store.replaceTaskSteps(task.id, [{ text: 'Шаг' }], undefined), 'task_is_completed');
  });

  it('снятие и возврат в работу сохраняют шаги', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    store.replaceTaskSteps(task.id, [{ text: 'Шаг' }], task.updated_at);

    const removed = store.removeTask(task.id, 'Пока не нужно');
    assert.equal(removed.steps.length, 1);
    const back = store.returnTaskToWork(task.id);
    assert.equal(back.steps.length, 1);
  });

  it('проверяет список шагов', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    const base = task.updated_at;

    throwsCode(() => store.replaceTaskSteps(task.id, [{ text: '   ' }], base), 'invalid_steps');
    throwsCode(() => store.replaceTaskSteps(task.id, [{ text: 'а'.repeat(501) }], base), 'invalid_steps');
    throwsCode(() => store.replaceTaskSteps(task.id, 'не список', base), 'invalid_steps');

    const sameId = 'a1000000-0000-4000-8000-000000000031';
    throwsCode(
      () => store.replaceTaskSteps(task.id, [{ id: sameId, text: 'Один' }, { id: sameId, text: 'Два' }], base),
      'invalid_steps',
    );
    throwsCode(
      () => store.replaceTaskSteps(task.id, [{ text: 'Один шаг' }, { text: 'один шаг' }], base),
      'invalid_steps',
      'повтор текста с точностью до регистра отклоняется',
    );

    const many = Array.from({ length: 101 }, (_, index) => ({ text: `Шаг ${index}` }));
    throwsCode(() => store.replaceTaskSteps(task.id, many, base), 'invalid_steps');

    const allowed = Array.from({ length: 100 }, (_, index) => ({ text: `Шаг ${index}` }));
    assert.equal(store.replaceTaskSteps(task.id, allowed, base).steps.length, 100);
  });

  it('шаги не дают задаче собственных сроков, проекта и дневника', () => {
    const { store } = createTestStore();
    const project = store.createProject({ title: 'Проект', outcome: 'Результат' });
    const task = store.createTask({ text: 'Задача', project_id: project.id, deadline: '2026-11-20' });
    const saved = store.replaceTaskSteps(
      task.id,
      [{ text: 'Шаг один' }, { text: 'Шаг два' }],
      task.updated_at,
    );

    assert.equal(saved.deadline, '2026-11-20', 'срок остался у задачи');
    assert.equal(saved.project_id, project.id);
    assert.equal(saved.steps.length, 2);
    assert.deepEqual(store.listEntries(), []);
  });
});
