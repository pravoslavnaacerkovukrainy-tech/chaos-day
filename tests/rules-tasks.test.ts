import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TODAY, createTestStore, ids, throwsCode } from './helpers.ts';

describe('Три независимые даты', () => {
  it('перенос меняет только день работы', () => {
    const { store } = createTestStore();
    const task = store.createTask({
      text: 'Проверить расчёты по проекту',
      day: '2026-11-13',
      deadline: '2026-11-17',
      review_date: '2026-11-15',
    });

    const moved = store.rescheduleTask(task.id, '2026-11-16');
    assert.equal(moved.day, '2026-11-16');
    assert.equal(moved.deadline, '2026-11-17', 'срок результата не должен меняться');
    assert.equal(moved.review_date, '2026-11-15', 'дата пересмотра не должна меняться');

    const again = store.rescheduleTask(task.id, '2026-11-20');
    assert.equal(again.deadline, '2026-11-17');
    assert.equal(again.review_date, '2026-11-15');
  });

  it('перенос на тот же день не трогает задачу', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Позвонить в сервис', day: '2026-11-13' });
    const same = store.rescheduleTask(task.id, '2026-11-13');
    assert.equal(same.updated_at, task.updated_at);
  });

  it('обычная правка не подменяет даты друг другом', () => {
    const { store } = createTestStore();
    const task = store.createTask({
      text: 'Согласовать отчёт',
      day: '2026-11-13',
      deadline: '2026-11-17',
      review_date: '2026-11-15',
    });
    const changed = store.updateTask(task.id, { text: 'Согласовать отчёт с Ольгой' });
    assert.equal(changed.day, '2026-11-13');
    assert.equal(changed.deadline, '2026-11-17');
    assert.equal(changed.review_date, '2026-11-15');
  });

  it('отклоняет несуществующую календарную дату', () => {
    const { store } = createTestStore();
    throwsCode(() => store.createTask({ text: 'Дело', deadline: '2026-02-30' }), 'invalid_date');
    throwsCode(() => store.createTask({ text: 'Дело', day: '13.11.2026' }), 'invalid_date');
  });
});

describe('Снятие не равно выполнению', () => {
  it('требует непустую причину и не создаёт запись дневника', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Купить подарок на юбилей', day: TODAY });

    throwsCode(() => store.removeTask(task.id, '   '), 'removal_reason_required');
    throwsCode(() => store.removeTask(task.id, undefined), 'removal_reason_required');

    const removed = store.removeTask(task.id, 'Юбилей перенесли, подарок не нужен');
    assert.equal(removed.status, 'removed');
    assert.equal(removed.removal_reason, 'Юбилей перенесли, подарок не нужен');
    assert.equal(removed.completed_at, null, 'снятие не заполняет выполнение');
    assert.equal(removed.is_removed, true);
    assert.equal(removed.is_open, false);
    assert.equal(store.listEntries().length, 0, 'снятие не пишет дневник');
  });

  it('сохраняет шаги снятой задачи', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    store.replaceTaskSteps(task.id, [{ id: undefined, text: 'Заказать справку' }], task.updated_at);
    const removed = store.removeTask(task.id, 'Документы больше не нужны');
    assert.equal(removed.steps.length, 1);
  });

  it('скрывает снятое из «Сегодня», «Ожидаю» и обзора', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Снятое дело', day: TODAY });
    store.removeTask(task.id, 'Передумал');

    assert.equal(store.tasksForDay(TODAY).tasks.some((item) => item.id === task.id), false);
    assert.equal(store.visibleTaskList(false, false).some((item) => item.id === task.id), false);
    assert.equal(store.visibleTaskList(false, true).some((item) => item.id === task.id), true);
    const groups = store.review(TODAY).groups;
    assert.equal(
      groups.some((group) => group.items.some((item) => item.id === task.id)),
      false,
    );
  });

  it('возврат в работу ставит «Можно делать» и стирает прежнюю причину', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Снятое дело' });
    store.removeTask(task.id, 'Первая причина');
    const back = store.returnTaskToWork(task.id);
    assert.equal(back.status, 'ready');
    assert.equal(back.removal_reason, null, 'прежняя причина не должна выглядеть текущей');

    throwsCode(() => store.returnTaskToWork(task.id), 'task_is_not_removed');
  });

  it('снятую задачу нельзя выполнить и изменить до возврата', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Снятое дело' });
    store.removeTask(task.id, 'Не нужно');

    throwsCode(() => store.completeTask(task.id), 'task_is_removed');
    throwsCode(() => store.updateTask(task.id, { text: 'Другой текст' }), 'task_is_removed');
    throwsCode(() => store.rescheduleTask(task.id, '2026-11-20'), 'task_is_removed');
    throwsCode(() => store.setTaskAtRisk(task.id, true), 'task_is_removed');
  });
});

describe('Выполнение и дневник', () => {
  it('создаёт ровно одну запись, повтор не создаёт вторую', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Отправить счёт на оплату', day: TODAY });

    const first = store.completeTask(task.id);
    assert.equal(store.listEntries().length, 1);
    assert.equal(first.entry.plan_id, task.id);
    assert.equal(first.entry.text, task.text);
    assert.equal(first.entry.context, null);
    assert.equal(first.entry.day, TODAY);
    assert.equal(first.task.entry_id, first.entry.id);

    throwsCode(() => store.completeTask(task.id), 'task_already_completed');
    assert.equal(store.listEntries().length, 1, 'вторая запись не создаётся');
  });

  it('«Кому обещано» не копируется в запись дневника', () => {
    const { store } = createTestStore();
    const task = store.createTask({
      text: 'Согласовать отчёт',
      promised_to: 'Ольга, отдел учёта',
      details: 'Внутренние подробности',
      waiting_for: 'Ответ бухгалтерии',
    });
    assert.equal(task.promised_to, 'Ольга, отдел учёта');

    const { entry } = store.completeTask(task.id);
    assert.equal(entry.text, 'Согласовать отчёт');
    assert.equal(entry.context, null);
    const serialized = JSON.stringify(store.listEntries());
    assert.ok(!serialized.includes('Ольга'), 'адресат обещания не должен попадать в дневник');
    assert.ok(!serialized.includes('бухгалтерии'));
  });

  it('возврат в работу удаляет неизменённую запись', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Отправить счёт' });
    store.completeTask(task.id);

    const result = store.reopenTask(task.id);
    assert.equal(result.outcome, 'removed_entry');
    assert.equal(result.task.completed_at, null);
    assert.equal(result.task.entry_id, null);
    assert.equal(store.listEntries().length, 0);

    throwsCode(() => store.reopenTask(task.id), 'task_not_completed');
  });

  it('изменённая запись остаётся в дневнике и теряет связь с задачей', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Отправить счёт' });
    const { entry } = store.completeTask(task.id);
    store.updateEntry(entry.id, { context: 'На чём остановился: жду подтверждения оплаты' });

    const result = store.reopenTask(task.id);
    assert.equal(result.outcome, 'kept_entry');
    const entries = store.listEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.plan_id, null);
    assert.equal(entries[0]?.context, 'На чём остановился: жду подтверждения оплаты');
  });

  it('удаление задачи сохраняет запись дневника', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Отправить счёт' });
    const { entry } = store.completeTask(task.id);

    store.deleteTask(task.id);
    const entries = store.listEntries();
    assert.equal(entries.length, 1, 'запись дневника переживает удаление задачи');
    assert.equal(entries[0]?.id, entry.id);
    assert.equal(entries[0]?.plan_id, null);
  });

  it('удаление записи сохраняет отметку выполнения задачи', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Отправить счёт' });
    const { entry } = store.completeTask(task.id);
    store.deleteEntry(entry.id);

    const after = store.getTask(task.id);
    assert.notEqual(after.completed_at, null);
    assert.equal(after.entry_id, null);
    assert.equal(store.listEntries().length, 0);
  });

  it('выполненную задачу нельзя править до возврата в план', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Отправить счёт' });
    store.completeTask(task.id);
    throwsCode(() => store.updateTask(task.id, { text: 'Другое' }), 'task_is_completed');
    throwsCode(() => store.rescheduleTask(task.id, '2026-11-20'), 'task_is_completed');
    throwsCode(() => store.removeTask(task.id, 'Причина'), 'task_is_completed');
  });
});

describe('«Обещание под угрозой»', () => {
  it('ставится человеком и не меняет статус и даты', () => {
    const { store } = createTestStore();
    const task = store.createTask({
      text: 'Оплатить счёт',
      day: '2026-11-13',
      deadline: '2026-11-17',
      review_date: '2026-11-15',
      status: 'paused',
    });
    const marked = store.setTaskAtRisk(task.id, true);
    assert.equal(marked.at_risk, true);
    assert.equal(marked.status, 'paused', 'отметка не меняет статус');
    assert.equal(marked.day, '2026-11-13');
    assert.equal(marked.deadline, '2026-11-17');
    assert.equal(marked.review_date, '2026-11-15');

    const cleared = store.setTaskAtRisk(task.id, false);
    assert.equal(cleared.at_risk, false);
  });

  it('отложенное дело с угрозой видно в «Сегодня», без угрозы — нет', () => {
    const { store } = createTestStore();
    const paused = store.createTask({ text: 'Отложено без угрозы', status: 'paused' });
    const pausedAtRisk = store.createTask({
      text: 'Отложено под угрозой',
      status: 'paused',
      at_risk: true,
    });

    const today = ids(store.tasksForDay(TODAY).tasks);
    assert.equal(today.includes(paused.id), false);
    assert.equal(today.includes(pausedAtRisk.id), true);
  });

  it('выполненные и снятые не входят в выборку угрозы', () => {
    const { store } = createTestStore();
    const done = store.createTask({ text: 'Выполненная', at_risk: true });
    store.completeTask(done.id);
    const removed = store.createTask({ text: 'Снятая', at_risk: true });
    store.removeTask(removed.id, 'Не нужно');

    const atRisk = ids(store.review(TODAY).groups.flatMap((group) => group.items));
    assert.equal(atRisk.includes(done.id), false);
    assert.equal(atRisk.includes(removed.id), false);
  });
});

describe('«Сегодня» и другие дни', () => {
  it('показывает день работы, просрочку, наступивший срок и угрозу', () => {
    const { store } = createTestStore();
    const todayTask = store.createTask({ text: 'На сегодня', day: TODAY });
    const overdue = store.createTask({ text: 'Незавершённое с прошлых дней', day: '2026-11-10' });
    const dueDeadline = store.createTask({ text: 'Наступил срок', deadline: '2026-11-12' });
    const threatened = store.createTask({ text: 'Под угрозой без дня', at_risk: true });
    const future = store.createTask({ text: 'Ещё не время', day: '2026-11-20' });

    const shown = ids(store.tasksForDay(TODAY).tasks);
    assert.deepEqual(
      [todayTask.id, overdue.id, dueDeadline.id, threatened.id].every((id) => shown.includes(id)),
      true,
    );
    assert.equal(shown.includes(future.id), false);
  });

  it('совпадение дня работы и срока даёт одну строку', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Две даты в один день', day: '2026-11-20', deadline: '2026-11-20' });
    const day = store.tasksForDay('2026-11-20');
    assert.equal(day.is_today, false);
    assert.deepEqual(ids(day.tasks), [task.id]);
  });

  it('другая дата не показывает просрочку и угрозу', () => {
    const { store } = createTestStore();
    store.createTask({ text: 'Просроченное', day: '2026-11-10' });
    store.createTask({ text: 'Под угрозой', at_risk: true });
    const day = store.tasksForDay('2026-11-25');
    assert.deepEqual(day.tasks, []);
  });
});

describe('Проекты', () => {
  it('проект задаёт сферу задачи', () => {
    const { store } = createTestStore();
    const project = store.createProject({
      title: 'Ремонт крыши',
      outcome: 'Крыша не протекает',
      area: 'work',
    });
    const task = store.createTask({ text: 'Заказать материал', area: 'personal', project_id: project.id });
    assert.equal(task.area, 'work');
  });

  it('смена сферы проекта распространяется на его задачи', () => {
    const { store } = createTestStore();
    const project = store.createProject({ title: 'Проект', outcome: 'Результат', area: 'work' });
    const task = store.createTask({ text: 'Задача', project_id: project.id });
    assert.equal(task.area, 'work');

    store.updateProject(project.id, { area: 'personal' });
    assert.equal(store.getTask(task.id).area, 'personal');
  });

  it('следующим шагом может быть только открытая задача этого проекта', () => {
    const { store } = createTestStore();
    const project = store.createProject({ title: 'Проект', outcome: 'Результат', area: 'work' });
    const other = store.createProject({ title: 'Другой проект', outcome: 'Другой результат' });

    const own = store.createTask({ text: 'Своя задача', project_id: project.id });
    const foreign = store.createTask({ text: 'Чужая задача', project_id: other.id });
    assert.equal(store.setNextAction(project.id, own.id).next_action_id, own.id);

    throwsCode(() => store.setNextAction(project.id, foreign.id), 'invalid_next_action');

    const waiting = store.createTask({ text: 'Ожидание', project_id: project.id, status: 'waiting' });
    throwsCode(() => store.setNextAction(project.id, waiting.id), 'invalid_next_action');

    store.completeTask(own.id);
    throwsCode(() => store.setNextAction(project.id, own.id), 'invalid_next_action');

    assert.equal(store.setNextAction(project.id, null).next_action_id, null);
  });

  it('архив невозможен при открытых задачах, снятая задача проект не держит', () => {
    const { store } = createTestStore();
    const project = store.createProject({ title: 'Проект', outcome: 'Результат' });
    const open = store.createTask({ text: 'Открытая задача', project_id: project.id });
    throwsCode(() => store.setProjectArchived(project.id, true), 'project_has_open_tasks');

    store.completeTask(open.id);
    const removed = store.createTask({ text: 'Снятая задача', project_id: project.id });
    store.removeTask(removed.id, 'Больше не нужно');
    assert.equal(store.setProjectArchived(project.id, true).archived, true);
  });

  it('удаление проекта обнуляет связь, задачи остаются', () => {
    const { store } = createTestStore();
    const project = store.createProject({ title: 'Проект', outcome: 'Результат' });
    const task = store.createTask({ text: 'Задача проекта', project_id: project.id });
    store.deleteProject(project.id);

    assert.equal(store.listProjects().length, 0);
    assert.equal(store.getTask(task.id).project_id, null);
  });

  it('нельзя привязать задачу к архивному проекту', () => {
    const { store } = createTestStore();
    const project = store.createProject({ title: 'Проект', outcome: 'Результат' });
    store.setProjectArchived(project.id, true);
    throwsCode(() => store.createTask({ text: 'Задача', project_id: project.id }), 'not_found');
  });
});

describe('Проверка текста', () => {
  it('пустой текст задачи отклоняется', () => {
    const { store } = createTestStore();
    throwsCode(() => store.createTask({ text: '   ' }), 'empty_text');
    throwsCode(() => store.createTask({ text: '' }), 'empty_text');
    throwsCode(() => store.createTask({ text: 42 }), 'invalid_request');
  });

  it('статус «Снято» нельзя задать напрямую', () => {
    const { store } = createTestStore();
    throwsCode(() => store.createTask({ text: 'Дело', status: 'removed' }), 'invalid_request');
    throwsCode(() => store.createTask({ text: 'Дело', status: 'unknown' }), 'invalid_request');
  });

  it('пустые строки хранятся как отсутствие поля', () => {
    const { store } = createTestStore();
    const task = store.createTask({
      text: 'Дело',
      promised_to: '   ',
      waiting_for: '',
      details: '  \n ',
    });
    assert.equal(task.promised_to, null);
    assert.equal(task.waiting_for, null);
    assert.equal(task.details, null);
  });
});

describe('Счётчик правок и base_revision', () => {
  it('правка со свежим основанием проходит и возвращает новый счётчик', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Согласовать отчёт', day: '2026-11-13' });
    assert.equal(task.revision, 0);

    const saved = store.updateTask(
      task.id,
      { text: 'Согласовать отчёт с Ольгой' },
      { revision: task.revision },
    );

    assert.equal(saved.text, 'Согласовать отчёт с Ольгой');
    assert.equal(saved.revision, 1);
    assert.equal(store.getTask(task.id).revision, 1);
  });

  it('без основания правка проходит прежним порядком', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Дело' });

    const first = store.updateTask(task.id, { details: 'Первая' });
    const second = store.updateTask(task.id, { details: 'Вторая' }, {});
    const third = store.updateTask(task.id, { details: 'Третья' }, { revision: null });
    const fourth = store.updateTask(task.id, { details: 'Четвёртая' }, { revision: undefined });

    assert.equal(fourth.details, 'Четвёртая');
    assert.equal(fourth.revision, first.revision + 3);
    assert.equal(second.revision, first.revision + 1);
    assert.equal(third.revision, first.revision + 2);
    assert.equal(store.getTask(task.id).revision, task.revision + 4);
  });

  it('устаревший редактор не затирает правку Mac', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Согласовать отчёт', day: '2026-11-13' });
    const openedInBrowser = task.revision;

    const fromMac = store.syncTask(task.id, { day: '2026-11-13' }, { day: '2026-11-16' });
    assert.deepEqual(fromMac.conflicts, []);

    throwsCode(
      () =>
        store.updateTask(
          task.id,
          { text: 'Черновик браузера', day: '2026-11-14' },
          { revision: openedInBrowser },
        ),
      'conflicting_changes',
    );

    const kept = store.getTask(task.id);
    assert.equal(kept.text, 'Согласовать отчёт', 'черновик не применён');
    assert.equal(kept.day, '2026-11-16', 'день из Mac сохранён');
    assert.equal(kept.revision, fromMac.task.revision, 'отказ не пишет в базу');

    // Перезагрузив редактор, человек видит свежий счётчик и сохраняет черновик.
    const retried = store.updateTask(
      task.id,
      { text: 'Черновик браузера' },
      { revision: kept.revision },
    );
    assert.equal(retried.text, 'Черновик браузера');
    assert.equal(retried.day, '2026-11-16', 'правка Mac не потеряна');
    assert.equal(retried.revision, kept.revision + 1);
  });

  it('основание сравнивается с текущим счётчиком, а не с черновиком', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Дело' });
    store.updateTask(task.id, { details: 'Правка из другого окна' });

    throwsCode(
      () => store.updateTask(task.id, { details: 'Мой черновик' }, { revision: task.revision }),
      'conflicting_changes',
    );
    assert.equal(store.getTask(task.id).details, 'Правка из другого окна');

    const fresh = store.updateTask(
      task.id,
      { details: 'Мой черновик' },
      { revision: task.revision + 1 },
    );
    assert.equal(fresh.details, 'Мой черновик');
  });

  it('неверное основание отклоняется раньше, чем поиск задачи', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Дело' });

    for (const bad of ['1', 1.5, -1, true, {}, []]) {
      throwsCode(
        () => store.updateTask(task.id, { details: 'Правка' }, { revision: bad }),
        'invalid_request',
        String(bad),
      );
    }
    throwsCode(
      () =>
        store.updateTask(
          'a1000000-0000-4000-8000-0000000000bb',
          { details: 'Правка' },
          { revision: 'не число' },
        ),
      'invalid_request',
      'проверка формы раньше 404',
    );
    throwsCode(
      () =>
        store.updateTask(
          'a1000000-0000-4000-8000-0000000000bb',
          { details: 'Правка' },
          { revision: 0 },
        ),
      'not_found',
    );

    assert.equal(store.getTask(task.id).revision, task.revision, 'задача не изменена');
  });

  it('состояние задачи важнее устаревшего основания', () => {
    const { store } = createTestStore();
    const done = store.createTask({ text: 'Выполненная' });
    store.completeTask(done.id);
    throwsCode(
      () => store.updateTask(done.id, { text: 'Другое' }, { revision: 99 }),
      'task_is_completed',
    );

    const removed = store.createTask({ text: 'Снятая' });
    store.removeTask(removed.id, 'Пока не нужно');
    throwsCode(
      () => store.updateTask(removed.id, { text: 'Другое' }, { revision: 0 }),
      'task_is_removed',
    );
  });

  it('правка с основанием не трогает шаги', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Собрать документы' });
    store.replaceTaskSteps(task.id, [{ text: 'Первый шаг' }], task.updated_at);
    const withSteps = store.getTask(task.id);

    const saved = store.updateTask(
      task.id,
      { text: 'Собрать документы и справку' },
      { revision: withSteps.revision },
    );

    assert.deepEqual(
      saved.steps.map((step) => step.text),
      ['Первый шаг'],
    );
    assert.equal(saved.revision, withSteps.revision + 1);
  });
});
