import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAC_MAX_VERSION, exportJson, exportMarkdown, importDocument, parseMacDocument } from '../src/server/transfer.ts';
import { ApiError } from '../src/server/errors.ts';
import { TODAY, createTestStore, ids, readFixture, throwsCode } from './helpers.ts';

describe('Импорт форматов Mac v1–v9', () => {
  it('v1: только записи дневника', () => {
    const { store } = createTestStore();
    const report = importDocument(store, readFixture('mac-v1-entries-only.json'));

    assert.equal(report.source_version, 1);
    assert.equal(report.added.entries, 2);
    assert.equal(report.added.tasks, 0);
    const entries = store.listEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.context, 'На чём остановился: забрать ключи завтра до обеда');
    assert.equal(entries[1]?.day, '2026-11-10');
  });

  it('v3: записи, задачи, заметки и связь выполнения', () => {
    const { store } = createTestStore();
    const report = importDocument(store, readFixture('mac-v3-notes.json'));

    assert.equal(report.source_version, 3);
    assert.equal(report.added.tasks, 2);
    assert.equal(report.added.notes, 1);
    assert.equal(report.added.entries, 1);

    const done = store.listTasks().find((task) => task.text === 'Подготовить смету на ремонт крыши');
    assert.ok(done);
    assert.equal(done.completed_at, '2026-11-11T12:05:00.000Z');
    assert.equal(done.entry_id, 'e0000000-0000-4000-8000-000000000011');

    const entry = store.getEntry(done.entry_id as string);
    assert.equal(entry.plan_id, done.id, 'связь записи и задачи сохранена');
    assert.equal(store.listNotes()[0]?.title, 'Список контактов ЖЭКа');
  });

  it('v5: шаги сохраняют порядок и выполнение', () => {
    const { store } = createTestStore();
    importDocument(store, readFixture('mac-v5-steps.json'));

    const task = store.listTasks()[0];
    assert.ok(task);
    assert.deepEqual(
      task.steps.map((step) => step.text),
      ['Заказать справку о доходах', 'Скачать форму декларации', 'Отправить пакет в налоговую'],
    );
    assert.notEqual(task.steps[0]?.completed_at, null);
    assert.equal(task.steps[1]?.completed_at, null);
    assert.equal(task.next_step?.text, 'Скачать форму декларации');
    assert.equal(task.deadline, '2026-11-20');
    assert.equal(task.day, '2026-11-14');
  });

  it('v6: место хаоса и прежняя входящая задача', () => {
    const { store } = createTestStore();
    const report = importDocument(store, readFixture('mac-v6-chaos.json'));

    assert.equal(report.source_version, 6);
    assert.equal(report.added.chaos, 2);
    const chaos = store.listChaos();
    assert.equal(chaos[0]?.text, 'Срочно перезвонить в сервис по стиральной машине');
    assert.equal(chaos[0]?.urgent, true, 'срочные выше');

    const inbox = store.listTasks().find((task) => task.status === 'inbox');
    assert.ok(inbox, 'прежняя входящая задача остаётся задачей');
    assert.equal(store.listChaos().some((item) => item.id === inbox.id), false);
  });

  it('v7: поля пересмотра и статус «Снято»', () => {
    const { store } = createTestStore();
    const report = importDocument(store, readFixture('mac-v7-review.json'));
    assert.equal(report.source_version, 7);

    const tasks = store.listTasks();
    const promised = tasks.find((task) => task.text === 'Согласовать отчёт с Ольгой');
    assert.equal(promised?.promised_to, 'Ольга, отдел учёта');
    assert.equal(promised?.deadline, '2026-11-14', 'момент времени стал календарным днём в поясе владельца');

    const atRisk = tasks.find((task) => task.text === 'Оплатить счёт за интернет');
    assert.equal(atRisk?.at_risk, true);
    assert.equal(atRisk?.status, 'paused');

    const removed = tasks.find((task) => task.text === 'Купить подарок на юбилей');
    assert.equal(removed?.status, 'removed');
    assert.equal(removed?.removal_reason, 'Юбилей перенесли на следующий месяц, подарок не нужен');
    assert.equal(removed?.completed_at, null, 'снятие не является выполнением');

    const waiting = tasks.find((task) => task.text === 'Дождаться ответа поставщика о сроках');
    assert.equal(waiting?.waiting_for, 'Ответ поставщика о дате отгрузки');
  });

  it('v9: дерево папок заметок', () => {
    const { store } = createTestStore();
    const report = importDocument(store, readFixture('mac-v9-note-folder-tree.json'));
    assert.equal(report.source_version, 9);

    const folders = store.listNoteFolders();
    assert.equal(folders.length, 4);
    const deep = folders.find((folder) => folder.name === '2026');
    const middle = folders.find((folder) => folder.name === 'Переписка');
    const root = folders.find((folder) => folder.name === 'Работа');
    assert.equal(deep?.parent_id, middle?.id);
    assert.equal(middle?.parent_id, root?.id);
    assert.equal(root?.parent_id, null);

    const note = store.listNotes().find((item) => item.title === 'Черновик письма о переносе срока');
    assert.equal(note?.folder_id, middle?.id);
    assert.equal(note?.pinned, true);
  });

  it('идентификаторы из файла приводятся к нижнему регистру', () => {
    const { store } = createTestStore();
    importDocument(store, readFixture('mac-v3-notes.json'));
    assert.deepEqual(ids(store.listNotes()), ['d0000000-0000-4000-8000-000000000031']);
  });

  it('неизвестная более новая версия отклоняется с объяснением', () => {
    const { store } = createTestStore();
    const error = throwsCode(
      () => importDocument(store, readFixture('mac-v10-unsupported.json')),
      'unsupported_format',
    );
    assert.match(error.message, /версия 10/);
    assert.match(error.message, new RegExp(`до ${MAC_MAX_VERSION}`));
    assert.equal(store.listEntries().length, 0, 'ничего не импортировано частично');
  });

  it('чужой формат и повреждённый файл отклоняются', () => {
    const { store } = createTestStore();
    throwsCode(() => importDocument(store, readFixture('mac-bad-format.json')), 'unsupported_format');
    throwsCode(() => importDocument(store, readFixture('mac-corrupt.json')), 'unreadable_file');
    throwsCode(() => parseMacDocument('{"format":"daylog","version":0}'), 'unsupported_format');
    throwsCode(() => parseMacDocument('[]'), 'unreadable_file');
  });

  it('повторный импорт не плодит копии и сохраняет идентификаторы', () => {
    const { store } = createTestStore();
    const text = readFixture('mac-v7-review.json');
    const first = importDocument(store, text);
    const idsBefore = {
      tasks: ids(store.listTasks()).sort(),
      entries: ids(store.listEntries()).sort(),
      projects: ids(store.listProjects()).sort(),
      notes: ids(store.listNotes()).sort(),
      chaos: ids(store.listChaos()).sort(),
    };

    const second = importDocument(store, text);
    assert.deepEqual(second.added, {
      tasks: 0, projects: 0, chaos: 0, entries: 0, notes: 0, note_folders: 0,
    });
    assert.equal(first.added.tasks, second.skipped.tasks + second.updated.tasks);

    assert.deepEqual(ids(store.listTasks()).sort(), idsBefore.tasks);
    assert.deepEqual(ids(store.listEntries()).sort(), idsBefore.entries);
    assert.deepEqual(ids(store.listProjects()).sort(), idsBefore.projects);
    assert.deepEqual(ids(store.listNotes()).sort(), idsBefore.notes);
    assert.deepEqual(ids(store.listChaos()).sort(), idsBefore.chaos);
  });

  it('режим merge не затирает более свежие локальные правки', () => {
    const { store, clock } = createTestStore();
    importDocument(store, readFixture('mac-v1-entries-only.json'));
    const entry = store.listEntries()[0];
    assert.ok(entry);

    clock.advanceSeconds(600);
    store.updateEntry(entry.id, { text: 'Локальная правка после импорта' });

    importDocument(store, readFixture('mac-v1-entries-only.json'), 'merge');
    assert.equal(store.getEntry(entry.id).text, 'Локальная правка после импорта');

    importDocument(store, readFixture('mac-v1-entries-only.json'), 'overwrite');
    assert.equal(
      store.getEntry(entry.id).text,
      'Утром отключили свет, работал с ноутбука от повербанка',
    );
  });

  it('импорт атомарен: ошибка сохранения не оставляет половину данных', () => {
    const { store } = createTestStore();
    store.armFault('save', 1);
    throwsCode(
      () => importDocument(store, readFixture('mac-v7-review.json')),
      'save_failed',
    );
    assert.equal(store.listTasks().length, 0);
    assert.equal(store.listEntries().length, 0);
    assert.equal(store.listProjects().length, 0);
    assert.equal(store.listNotes().length, 0);
    assert.equal(store.listChaos().length, 0);
  });

  it('битая ссылка на папку оставляет заметку в «Без папки» с предупреждением', () => {
    const { store } = createTestStore();
    const text = JSON.stringify({
      format: 'daylog',
      version: 8,
      entries: [],
      notes: [
        {
          id: 'D0000000-0000-4000-8000-00000000AA01',
          title: 'Заметка без папки',
          body: 'Текст',
          createdAt: '2026-11-10T09:00:00Z',
          updatedAt: '2026-11-10T09:00:00Z',
          pinned: false,
          folderID: 'F0000000-0000-4000-8000-00000000AA99',
        },
      ],
      noteFolders: [],
    });
    const report = importDocument(store, text);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0] ?? '', /несуществующую папку/);
    assert.equal(store.listNotes()[0]?.folder_id, null);
  });
});

describe('Экспорт', () => {
  it('JSON повторяет формат Mac и вычисляет версию', () => {
    const { store } = createTestStore();
    importDocument(store, readFixture('mac-v7-review.json'));

    const document = JSON.parse(exportJson(store));
    assert.equal(document.format, 'daylog');
    assert.equal(document.version, 9, 'вложенная папка поднимает версию до v9');
    assert.equal(Array.isArray(document.entries), true);
    assert.equal(document.plans.length, 8);
    assert.equal(document.noteFolders.length, 2);
    assert.match(document.exportedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'без долей секунды');
  });

  it('пустое хранилище экспортируется как v1', () => {
    const { store } = createTestStore();
    const document = JSON.parse(exportJson(store));
    assert.equal(document.version, 1);
    assert.deepEqual(document.entries, []);
    assert.equal(document.plans, undefined);
    assert.equal(document.notes, undefined);
  });

  it('экспорт читается обратно без новых объектов', () => {
    const { store } = createTestStore();
    importDocument(store, readFixture('mac-v7-review.json'));
    const snapshot = exportJson(store);

    const report = importDocument(store, snapshot);
    assert.deepEqual(report.added, {
      tasks: 0, projects: 0, chaos: 0, entries: 0, notes: 0, note_folders: 0,
    });
    assert.equal(store.listTasks().length, 8);
    assert.equal(store.listProjects().length, 2);
  });

  it('экспорт в другую базу переносит те же дела', () => {
    const source = createTestStore();
    importDocument(source.store, readFixture('mac-v7-review.json'));
    const snapshot = exportJson(source.store);

    const target = createTestStore();
    const report = importDocument(target.store, snapshot);
    assert.equal(report.added.tasks, 8);
    assert.equal(report.added.projects, 2);
    assert.deepEqual(
      ids(target.store.listTasks()).sort(),
      ids(source.store.listTasks()).sort(),
    );
  });

  it('Markdown содержит разделы, дела и «Кому обещано»', () => {
    const { store } = createTestStore();
    importDocument(store, readFixture('mac-v7-review.json'));
    const markdown = exportMarkdown(store);

    for (const heading of ['# Хаос Дня — экспорт', '## Место хаоса', '## Проекты', '## Задачи', '## Дни', '## Заметки']) {
      assert.ok(markdown.includes(heading), `нет раздела ${heading}`);
    }
    assert.ok(markdown.includes('Кому обещано: Ольга, отдел учёта'));
    assert.ok(markdown.includes('Причина снятия: Юбилей перенесли'));
    assert.ok(markdown.includes(`Дата выгрузки: ${TODAY}`));
    assert.ok(markdown.includes('Europe/Kyiv'));
  });

  it('Markdown пустого хранилища показывает пустые разделы', () => {
    const { store } = createTestStore();
    const markdown = exportMarkdown(store);
    assert.ok(markdown.includes('Сейчас здесь ничего нет.'));
  });

  it('экспорт не включает черновик несохранённого поля', () => {
    const { store } = createTestStore();
    store.createTask({ text: 'Сохранённое дело' });
    const draft = 'Черновик, который никто не сохранял';

    const json = exportJson(store);
    const markdown = exportMarkdown(store);
    assert.ok(!json.includes(draft));
    assert.ok(!markdown.includes(draft));
    assert.ok(json.includes('Сохранённое дело'));
  });

  it('заметка с Markdown не ломает документ экспорта', () => {
    const { store } = createTestStore();
    store.createNote({ title: 'Заметка', body: '# Свой заголовок\n\n```js\nкод без закрытия\n' });
    const markdown = exportMarkdown(store);

    assert.ok(markdown.includes('\\# Свой заголовок'), 'строка-заголовок экранирована');
    const fences = (markdown.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, 'незакрытая ограда кода закрыта');
  });

  it('экспорт не содержит пароль и данные сессий', () => {
    const { store } = createTestStore();
    store.setupPassword('очень-секретный-пароль');
    store.createSession();
    store.createTask({ text: 'Дело' });

    const json = exportJson(store);
    const markdown = exportMarkdown(store);
    assert.ok(!json.includes('очень-секретный-пароль'));
    assert.ok(!markdown.includes('очень-секретный-пароль'));
    assert.ok(!json.includes('password'));
  });
});

describe('Ошибка ApiError при импорте', () => {
  it('отклонение версии — это ApiError с русским текстом', () => {
    let caught: unknown;
    try {
      parseMacDocument('{"format":"daylog","version":42,"entries":[]}');
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ApiError);
    assert.equal(caught.status, 422);
    assert.match(caught.message, /версия 42/);
  });
});
