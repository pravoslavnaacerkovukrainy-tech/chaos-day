import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_GROUP_TEXT, REVIEW_GROUP_DEFS } from '../src/server/types.ts';
import { importDocument } from '../src/server/transfer.ts';
import { TODAY, createTestStore, ids, readFixture } from './helpers.ts';

const TITLES = REVIEW_GROUP_DEFS.map((group) => group.title);

function importV7() {
  const context = createTestStore();
  importDocument(context.store, readFixture('mac-v7-review.json'));
  return context;
}

describe('Обзор: шесть групп', () => {
  it('хранилище всегда возвращает шесть групп в фиксированном порядке', () => {
    const { store } = importV7();
    const groups = store.review(TODAY).groups;

    assert.equal(groups.length, 6);
    assert.deepEqual(
      groups.map((group) => group.title),
      TITLES,
    );
    assert.deepEqual(
      groups.map((group) => group.key),
      REVIEW_GROUP_DEFS.map((group) => group.key),
    );
  });

  it('пустое хранилище даёт шесть пустых групп с пометкой', () => {
    const { store } = createTestStore();
    const groups = store.review(TODAY).groups;

    assert.equal(groups.length, 6);
    for (const group of groups) {
      assert.deepEqual(group.items, []);
      assert.equal(group.is_empty, true);
      assert.equal(group.empty_text, EMPTY_GROUP_TEXT);
    }
  });

  it('дела распределены по группам в порядке методики', () => {
    const { store } = importV7();
    const groups = store.review(TODAY).groups;
    const titlesOf = (index: number) => groups[index]?.items.map((item) => item.title) ?? [];

    assert.deepEqual(titlesOf(0), ['Согласовать отчёт с Ольгой'], 'обещания со сроком');
    assert.deepEqual(titlesOf(1), ['Передать запасные ключи соседу'], 'обещания без срока');
    assert.deepEqual(titlesOf(2), ['Оплатить счёт за интернет'], 'под угрозой, включая отложенное');
    assert.deepEqual(titlesOf(3), ['Проверить расчёты по проекту'], 'сегодня и следующие шаги');
    assert.deepEqual(titlesOf(4), ['Дождаться ответа поставщика о сроках'], 'ожидания с условием');
    assert.deepEqual(titlesOf(5), ['Пересмотреть договор аренды гаража', 'Ремонт крыши'], 'пересмотр: задача и проект');
  });

  it('дублей нет: дело попадает только в первую подходящую группу', () => {
    const { store } = importV7();
    const groups = store.review(TODAY).groups;
    const all = groups.flatMap((group) => group.items.map((item) => item.id));

    assert.equal(new Set(all).size, all.length, 'одно дело встречается один раз');
    // «Согласовать отчёт с Ольгой» — следующий шаг проекта, но обещание со сроком побеждает.
    const promisedGroup = groups[0]?.items.map((item) => item.title) ?? [];
    const todayGroup = groups[3]?.items.map((item) => item.title) ?? [];
    assert.ok(promisedGroup.includes('Согласовать отчёт с Ольгой'));
    assert.ok(!todayGroup.includes('Согласовать отчёт с Ольгой'));
  });

  it('выполненные, снятые, архивные проекты и строки хаоса в обзор не входят', () => {
    const { store } = importV7();
    const items = store.review(TODAY).groups.flatMap((group) => group.items);

    assert.equal(items.some((item) => item.title === 'Отправить счёт на оплату'), false, 'выполненная');
    assert.equal(items.some((item) => item.title === 'Купить подарок на юбилей'), false, 'снятая');
    assert.equal(items.some((item) => item.title === 'Уточнить график отключения воды'), false, 'строка хаоса');
    assert.equal(
      items.some((item) => item.kind === 'project' && item.title === 'Годовой отчёт отдела'),
      false,
      'у проекта есть следующий шаг, а дата пересмотра ещё не наступила',
    );
  });

  it('группа «Под угрозой» собирает отложенное и ожидающее', () => {
    const { store } = createTestStore();
    store.createTask({ text: 'Отложено под угрозой', status: 'paused', at_risk: true });
    store.createTask({ text: 'Ожидаю под угрозой', status: 'waiting', at_risk: true });
    store.createTask({ text: 'Отложено без угрозы', status: 'paused' });

    const atRisk = store.review(TODAY).groups[2]?.items.map((item) => item.title) ?? [];
    assert.deepEqual(atRisk.sort(), ['Ожидаю под угрозой', 'Отложено под угрозой'].sort());
  });

  it('обещания со сроком идут от ближайшего', () => {
    const { store } = createTestStore();
    store.createTask({ text: 'Дальний срок', promised_to: 'Коллега', deadline: '2026-11-30' });
    store.createTask({ text: 'Ближний срок', promised_to: 'Коллега', deadline: '2026-11-15' });

    const titles = store.review(TODAY).groups[0]?.items.map((item) => item.title) ?? [];
    assert.deepEqual(titles, ['Ближний срок', 'Дальний срок']);
  });

  it('обещание без срока не получает выдуманную дату', () => {
    const { store } = createTestStore();
    const task = store.createTask({ text: 'Обещал соседу', promised_to: 'Сосед' });
    assert.equal(task.deadline, null);

    const groups = store.review(TODAY).groups;
    assert.deepEqual(groups[0]?.items, []);
    assert.deepEqual(groups[1]?.items.map((item) => item.title), ['Обещал соседу']);
  });

  it('строки места хаоса находит поиск, а не обзор', () => {
    const { store } = createTestStore();
    store.addChaos('Уточнить договор', false);

    assert.deepEqual(store.review(TODAY).groups.flatMap((group) => group.items), []);
    assert.deepEqual(ids(store.search('договор').chaos).length, 1);
  });
});

describe('Поиск по делам', () => {
  it('охватывает задачи, проекты и строки хаоса и не выходит за раздел', () => {
    const { store } = createTestStore();
    store.createTask({ text: 'Согласовать отчёт', details: 'Внутренний документ' });
    store.createProject({ title: 'Годовой отчёт', outcome: 'Отчёт сдан' });
    store.addChaos('Отчёт по другой форме', false);
    store.addEntry({ text: 'Отчёт отправлен' });

    const found = store.search('отчёт');
    assert.equal(found.tasks.length, 1);
    assert.equal(found.projects.length, 1);
    assert.equal(found.chaos.length, 1);

    // Поиск по делам не переключает раздел и не тянет дневник.
    assert.deepEqual(store.search('отчёт').tasks.map((task) => task.text), ['Согласовать отчёт']);
  });

  it('находит по подробностям, ожиданию и адресату обещания', () => {
    const { store } = createTestStore();
    store.createTask({ text: 'Первая', details: 'нужна справка из архива' });
    store.createTask({ text: 'Вторая', waiting_for: 'ответ поставщика' });
    store.createTask({ text: 'Третья', promised_to: 'Ольга из отдела учёта' });

    assert.equal(store.search('архив').tasks.length, 1);
    assert.equal(store.search('поставщик').tasks.length, 1);
    assert.equal(store.search('ольга').tasks.length, 1, 'регистр не важен');
  });

  it('выполненные и снятые попадают в выдачу только с переключателем', () => {
    const { store } = createTestStore();
    const done = store.createTask({ text: 'Выполненная задача' });
    store.completeTask(done.id);
    const removed = store.createTask({ text: 'Снятая задача' });
    store.removeTask(removed.id, 'Не нужно');

    assert.equal(store.search('задача').tasks.length, 0);
    assert.equal(store.search('задача', true, false).tasks.length, 1);
    assert.equal(store.search('задача', false, true).tasks.length, 1);
    assert.equal(store.search('задача', true, true).tasks.length, 2);
  });

  it('пустой запрос ничего не ищет', () => {
    const { store } = createTestStore();
    store.createTask({ text: 'Какое-то дело' });
    const found = store.search('   ');
    assert.deepEqual(found.tasks, []);
    assert.deepEqual(found.projects, []);
    assert.deepEqual(found.chaos, []);
  });
});
