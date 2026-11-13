import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig, startRuntime } from '../src/server/index.ts';
import type { Runtime } from '../src/server/index.ts';
import { readFixture } from './helpers.ts';

const PASSWORD = 'пароль-приёмки-123';

/** Названия разделов, которые не должен увидеть человек без входа. */
const SECTION_NAMES = [
  'Место хаоса',
  'Обзор',
  'Проекты',
  'Ожидаю',
  'Все задачи',
  'Заметки',
  'Дневник',
];

const config = {
  ...loadConfig({}),
  host: '127.0.0.1',
  port: 0,
  databaseFile: ':memory:',
  testing: true,
  allowFaults: true,
  clientDistDir: null,
};

let runtime: Runtime;
let cookie = '';

interface Response {
  status: number;
  body: any;
  text: string;
  headers: globalThis.Headers;
  setCookies: string[];
}

async function api(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    raw?: string;
    contentType?: string;
    withCookie?: boolean;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.withCookie !== false && cookie !== '') headers.cookie = cookie;
  let payload: string | undefined;
  if (options.raw !== undefined) {
    payload = options.raw;
    headers['content-type'] = options.contentType ?? 'application/json';
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(`${runtime.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: payload,
  });
  const setCookies = response.headers.getSetCookie();
  for (const value of setCookies) {
    const pair = value.split(';')[0];
    if (pair) cookie = pair;
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* не JSON — остаётся текстом */
  }
  return { status: response.status, body, text, headers: response.headers, setCookies };
}

before(async () => {
  runtime = await startRuntime(config);
});

after(async () => {
  await runtime.close();
});

describe('HTTP API: вход', () => {
  it('health доступен без входа', async () => {
    const res = await api('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, version: '1.0.0' });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('auth/state до настройки отдаёт только два булевых поля', async () => {
    const res = await api('/api/auth/state');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { setup_required: true, authenticated: false });
  });

  it('без входа ни один раздел не читается', async () => {
    for (const path of ['/api/state', '/api/chaos', '/api/tasks', '/api/review', '/api/notes', '/api/entries']) {
      const res = await api(path);
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error.code, 'unauthorized');
      for (const name of SECTION_NAMES) {
        assert.ok(!res.text.includes(name), `${path} не должен раскрывать «${name}»`);
      }
    }
  });

  it('короткий пароль отклоняется', async () => {
    const res = await api('/api/auth/setup', { method: 'POST', body: { password: '123' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_password');
  });

  it('настройка задаёт httpOnly cookie без Secure на http', async () => {
    const res = await api('/api/auth/setup', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, authenticated: true });

    const raw = res.setCookies[0] ?? '';
    assert.match(raw, /^chaos_day_session=/);
    assert.ok(raw.includes('HttpOnly'));
    assert.ok(raw.includes('SameSite=Strict'));
    assert.ok(raw.includes('Path=/'));
    assert.ok(raw.includes('Max-Age=43200'));
    assert.ok(!raw.includes('Secure'), 'на http://127.0.0.1 флаг Secure не ставится');
  });

  it('повторная настройка недоступна', async () => {
    const res = await api('/api/auth/setup', { method: 'POST', body: { password: 'другой-пароль-1' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'setup_already_done');
  });

  it('после входа снимок доступен, auth/state по-прежнему без названий разделов', async () => {
    const state = await api('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.ok, true);
    assert.equal(state.body.data.timezone, 'Europe/Kyiv');
    assert.deepEqual(Object.keys(state.body.data).sort(), [
      'chaos', 'entries', 'note_folders', 'notes', 'now', 'projects', 'tasks', 'timezone', 'today',
    ]);

    const auth = await api('/api/auth/state');
    assert.deepEqual(auth.body, { setup_required: false, authenticated: true });
  });

  it('неверный пароль отклоняется нейтральным сообщением', async () => {
    const saved = cookie;
    cookie = '';
    const res = await api('/api/auth/login', { method: 'POST', body: { password: 'не тот пароль' } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Неверный пароль.');
    assert.ok(!res.text.includes('существует'), 'сервер не выдаёт наличие учётной записи');

    // Удачный вход возвращает сессию и обнуляет счётчик неудач.
    const ok = await api('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(ok.status, 200);
    assert.notEqual(cookie, saved);
  });
});

describe('HTTP API: форма ответов', () => {
  it('изменяющий запрос без JSON отклоняется', async () => {
    const res = await api('/api/chaos', {
      method: 'POST',
      raw: 'text=обычный текст',
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, 'unsupported_media_type');
  });

  it('неизвестный путь API отдаёт JSON, а не HTML', async () => {
    const res = await api('/api/несуществующий-путь');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });

  it('неверный метод отдаёт 405', async () => {
    const res = await api('/api/state', { method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.equal(res.body.error.code, 'method_not_allowed');
  });

  it('некорректная дата отдаёт 400', async () => {
    const res = await api('/api/day?date=2026-02-30');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_date');
  });

  it('корень отдаёт HTML', async () => {
    const res = await api('/', { withCookie: false });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  });
});

describe('HTTP API: цикл приёмки одного дня', () => {
  let chaosId = '';
  let taskId = '';

  it('1. записать одну строку', async () => {
    const res = await api('/api/chaos', { method: 'POST', body: { text: 'Уточнить график отключения воды' } });
    assert.equal(res.status, 201);
    chaosId = res.body.data.chaos.id;
    assert.ok(chaosId !== '');
    assert.equal(res.body.data.chaos.urgent, false);
  });

  it('2. превратить строку в задачу, строка уходит атомарно', async () => {
    const res = await api(`/api/chaos/${chaosId}/to-task`, {
      method: 'POST',
      body: { text: 'Уточнить график отключения воды', area: 'personal' },
    });
    assert.equal(res.status, 201);
    taskId = res.body.data.task.id;
    assert.equal(res.body.data.removed_chaos_id, chaosId);

    const chaos = await api('/api/chaos');
    assert.equal(chaos.body.data.chaos.length, 0);
  });

  it('3. назначить день работы, перенос не меняет срок', async () => {
    const patch = await api(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: { day: '2026-11-13', deadline: '2026-11-17' },
    });
    assert.equal(patch.status, 200);

    const moved = await api(`/api/tasks/${taskId}/reschedule`, { method: 'POST', body: { day: '2026-11-16' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data.task.day, '2026-11-16');
    assert.equal(moved.body.data.task.deadline, '2026-11-17');
  });

  it('4. отметить выполнение и увидеть одну запись дневника', async () => {
    const done = await api(`/api/tasks/${taskId}/complete`, { method: 'POST', body: {} });
    assert.equal(done.status, 200);
    assert.equal(done.body.data.entry.plan_id, taskId);

    const again = await api(`/api/tasks/${taskId}/complete`, { method: 'POST', body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'task_already_completed');

    const entries = await api('/api/entries');
    assert.equal(entries.body.data.entries.length, 1);
  });

  it('5. снимок после «обновления страницы» сохраняет состояние', async () => {
    const res = await api('/api/state');
    assert.equal(res.status, 200);
    const task = res.body.data.tasks.find((item: any) => item.id === taskId);
    assert.ok(task);
    assert.equal(task.day, '2026-11-16');
    assert.equal(task.deadline, '2026-11-17');
    assert.notEqual(task.completed_at, null);
    assert.equal(res.body.data.entries.length, 1);
  });

  it('обзор всегда отдаёт шесть групп', async () => {
    const res = await api('/api/review');
    assert.equal(res.status, 200);
    const groups = res.body.data.groups;
    assert.equal(groups.length, 6);
    assert.deepEqual(
      groups.map((group: any) => group.key),
      [
        'promised_with_deadline',
        'promised_without_deadline',
        'at_risk',
        'today_and_next_steps',
        'waiting',
        'review',
      ],
    );
    for (const group of groups) {
      assert.equal(typeof group.empty_text, 'string');
      assert.equal(group.is_empty, group.items.length === 0);
    }
  });
});

describe('HTTP API: импорт и экспорт', () => {
  it('импорт синтетического файла v1', async () => {
    const res = await api('/api/import', { method: 'POST', raw: readFixture('mac-v1-entries-only.json') });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.source_version, 1);
    assert.equal(res.body.data.added.entries, 2);
  });

  it('повторный импорт не плодит копии', async () => {
    const res = await api('/api/import', { method: 'POST', raw: readFixture('mac-v1-entries-only.json') });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.added, {
      tasks: 0, projects: 0, chaos: 0, entries: 0, notes: 0, note_folders: 0,
    });
  });

  it('импорт v9 с деревом папок', async () => {
    const res = await api('/api/import', { method: 'POST', raw: readFixture('mac-v9-note-folder-tree.json') });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.source_version, 9);
    assert.equal(res.body.data.added.note_folders, 4);
  });

  it('неизвестная версия отклоняется с объяснением', async () => {
    const res = await api('/api/import', { method: 'POST', raw: readFixture('mac-v10-unsupported.json') });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'unsupported_format');
    assert.match(res.body.error.message, /версия 10/);
  });

  it('повреждённый файл отклоняется', async () => {
    const res = await api('/api/import', { method: 'POST', raw: readFixture('mac-corrupt.json') });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'unreadable_file');
  });

  it('неверный режим импорта отклоняется', async () => {
    const res = await api('/api/import?mode=replace', { method: 'POST', raw: '{}' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_request');
  });

  it('экспорт JSON отдаёт файл формата daylog', async () => {
    const res = await api('/api/export.json');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="chaos-day-export-\d{4}-\d{2}-\d{2}\.json"/);

    const document = JSON.parse(res.text);
    assert.equal(document.format, 'daylog');
    assert.ok(document.version >= 1 && document.version <= 9);
    assert.ok(Array.isArray(document.entries));
  });

  it('экспорт Markdown отдаёт файл', async () => {
    const res = await api('/api/export.md');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
    assert.ok(res.text.startsWith('# Хаос Дня — экспорт'));
    assert.match(res.headers.get('content-disposition') ?? '', /\.md"$/);
  });
});

describe('HTTP API: управляемая ошибка сохранения', () => {
  it('ошибка записи откатывает разбор строки целиком', async () => {
    const created = await api('/api/chaos', { method: 'POST', body: { text: 'Строка для проверки сбоя' } });
    const chaosId = created.body.data.chaos.id;

    const fault = await api('/api/dev/fault', { method: 'POST', body: { inject: 'save', times: 1 } });
    assert.equal(fault.status, 200);

    const failed = await api(`/api/chaos/${chaosId}/to-task`, {
      method: 'POST',
      body: { text: 'Строка для проверки сбоя' },
    });
    assert.equal(failed.status, 500);
    assert.equal(failed.body.error.code, 'save_failed');

    const chaos = await api('/api/chaos');
    assert.equal(chaos.body.data.chaos.length, 1);
    assert.equal(chaos.body.data.chaos[0].id, chaosId, 'идентификатор строки прежний');

    const tasks = await api('/api/tasks');
    assert.equal(
      tasks.body.data.tasks.filter((task: any) => task.text === 'Строка для проверки сбоя').length,
      0,
      'задача не создалась',
    );

    const retried = await api(`/api/chaos/${chaosId}/to-task`, {
      method: 'POST',
      body: { text: 'Строка для проверки сбоя' },
    });
    assert.equal(retried.status, 201);
  });

  it('без CHAOS_DAY_ALLOW_FAULTS ошибка не включается', async () => {
    const strictRuntime = await startRuntime({ ...config, allowFaults: false });
    try {
      const res = await fetch(`${strictRuntime.url}/api/dev/fault`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inject: 'save', times: 1 }),
      });
      assert.equal(res.status, 403);
    } finally {
      await strictRuntime.close();
    }
  });

  it('без режима приёмки пути /api/dev закрыты', async () => {
    const prodRuntime = await startRuntime({ ...config, testing: false });
    try {
      const res = await fetch(`${prodRuntime.url}/api/dev/reset`, { method: 'POST' });
      assert.equal(res.status, 403);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, 'forbidden');
    } finally {
      await prodRuntime.close();
    }
  });
});

describe('HTTP API: сброс, выход и подбор пароля', () => {
  it('dev/bootstrap задаёт пароль и входит одним вызовом', async () => {
    const res = await api('/api/dev/bootstrap', { method: 'POST', body: { password: PASSWORD, timezone: 'UTC' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.setup_required, false);
    assert.equal(res.body.data.authenticated, true);

    const meta = await api('/api/meta');
    assert.equal(meta.body.data.timezone, 'UTC');

    const state = await api('/api/state');
    assert.deepEqual(state.body.data.tasks, [], 'хранилище очищено');
  });

  it('dev/reset очищает хранилище и отзывает сессию', async () => {
    await api('/api/chaos', { method: 'POST', body: { text: 'Временная строка' } });
    const reset = await api('/api/dev/reset', { method: 'POST', body: {} });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.data.setup_required, true);

    const state = await api('/api/state');
    assert.equal(state.status, 401, 'прежняя сессия отозвана');
  });

  it('logout завершает сессию', async () => {
    await api('/api/auth/setup', { method: 'POST', body: { password: PASSWORD } });
    const before = await api('/api/state');
    assert.equal(before.status, 200);

    const out = await api('/api/auth/logout', { method: 'POST', body: {} });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, authenticated: false });

    const after = await api('/api/state');
    assert.equal(after.status, 401);
  });

  it('подбор пароля ограничен', async () => {
    cookie = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await api('/api/auth/login', { method: 'POST', body: { password: 'неверный-пароль' } });
      assert.equal(res.status, 401);
    }
    const blocked = await api('/api/auth/login', { method: 'POST', body: { password: 'неверный-пароль' } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'too_many_attempts');

    const evenCorrect = await api('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(evenCorrect.status, 429, 'после блокировки верный пароль тоже не проходит');
  });
});
