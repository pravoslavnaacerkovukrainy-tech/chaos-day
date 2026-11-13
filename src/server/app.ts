import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
  COOKIE_NAME,
  LoginThrottle,
  clearedSessionCookie,
  parseCookies,
  sessionCookie,
} from './auth.ts';
import { assertDayKey, todayKey } from './dates.ts';
import { ApiError, MESSAGES } from './errors.ts';
import {
  IMPORT_BODY_LIMIT,
  JSON_BODY_LIMIT,
  clientIp,
  contentTypeIsJson,
  flag,
  hasBody,
  isSecureRequest,
  readJsonBody,
  readTextBody,
  sendError,
  sendFile,
  sendFromError,
  sendJson,
  sendOk,
} from './http.ts';
import type { Store, TaskDraft } from './store.ts';
import { exportFileName, exportJson, exportMarkdown, importDocument } from './transfer.ts';
import type { ImportMode } from './transfer.ts';
import type { Area, DayKey, Note, TaskStatus } from './types.ts';

export interface AppOptions {
  store: Store;
  sessionTtlSec: number;
  testing: boolean;
  allowFaults: boolean;
  /** Собранная статика клиента. Сервер раздаёт её на том же origin. */
  clientDistDir?: string | null;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  query: URLSearchParams;
  params: Record<string, string>;
  secure: boolean;
  ip: string;
  token: string | undefined;
  /** Живая сессия определена один раз на запрос, до вызова обработчика. */
  authenticated: boolean;
  json: () => Promise<Record<string, unknown>>;
  text: (limit?: number) => Promise<string>;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  auth: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Хаос Дня</title>
</head>
<body>
<main style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #263747;">
<h1>Хаос Дня</h1>
<p>Сервер запущен, интерфейс ещё не собран.</p>
<p>Соберите клиент командой <code>npm run build</code> или запустите его отдельно — сервер раздаёт
<code>client/dist</code> на этом же origin, а API доступен по путям <code>/api/*</code>.</p>
<p>Проверить сервер: <a href="/api/health">/api/health</a> и <a href="/api/auth/state">/api/auth/state</a>.</p>
</main>
</body>
</html>
`;

/* ------------------------------------------------------------------ */
/* Маршруты                                                            */
/* ------------------------------------------------------------------ */

function route(method: string, path: string, handler: Handler, auth = true): Route {
  return { method, segments: splitPath(path), handler, auth };
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function matchRoute(
  routes: readonly Route[],
  method: string,
  segments: readonly string[],
): { route: Route; params: Record<string, string> } | null {
  let pathMatched = false;
  for (const candidate of routes) {
    if (candidate.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let index = 0; index < candidate.segments.length; index += 1) {
      const pattern = candidate.segments[index] ?? '';
      const actual = segments[index] ?? '';
      if (pattern.startsWith(':')) {
        params[pattern.slice(1)] = decodeURIComponent(actual);
        continue;
      }
      if (pattern !== actual) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    pathMatched = true;
    if (candidate.method === method) return { route: candidate, params };
  }
  // Путь существует, метод нет — отдельный код, а не «не найдено».
  if (pathMatched) throw new ApiError(405, 'method_not_allowed', MESSAGES.methodNotAllowed(method));
  return null;
}

function buildRoutes(options: AppOptions): Route[] {
  const { store } = options;
  const throttle = new LoginThrottle();

  const setSessionCookie = (ctx: Ctx, token: string): void => {
    ctx.res.setHeader(
      'Set-Cookie',
      sessionCookie(token, { maxAgeSec: options.sessionTtlSec, secure: ctx.secure }),
    );
  };

  const clearSessionCookie = (ctx: Ctx): void => {
    ctx.res.setHeader('Set-Cookie', clearedSessionCookie(ctx.secure));
  };

  const requireTesting = (): void => {
    if (!options.testing) throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
  };

  return [
    /* --- служебные и вход --- */
    route(
      'GET',
      '/health',
      (ctx) => {
        sendJson(ctx.res, 200, { ok: true, version: '1.0.0' });
      },
      false,
    ),
    route(
      'GET',
      '/auth/state',
      (ctx) => {
        // Без входа не отдаётся ни одно название раздела: только два булевых поля.
        sendJson(ctx.res, 200, {
          setup_required: store.setupRequired(),
          authenticated: ctx.authenticated,
        });
      },
      false,
    ),
    route(
      'POST',
      '/auth/setup',
      async (ctx) => {
        const body = await ctx.json();
        store.setupPassword(body.password);
        const { token } = store.createSession();
        setSessionCookie(ctx, token);
        sendJson(ctx.res, 200, { ok: true, authenticated: true });
      },
      false,
    ),
    route(
      'POST',
      '/auth/login',
      async (ctx) => {
        const body = await ctx.json();
        if (store.setupRequired()) {
          throw new ApiError(403, 'setup_required', 'Пароль ещё не задан. Сначала откройте настройку.');
        }
        if (throttle.blocked(ctx.ip)) {
          throw new ApiError(429, 'too_many_attempts', MESSAGES.tooManyAttempts);
        }
        if (!store.checkPassword(body.password)) {
          throttle.recordFailure(ctx.ip);
          throw new ApiError(401, 'unauthorized', MESSAGES.wrongPassword);
        }
        throttle.reset(ctx.ip);
        const { token } = store.createSession();
        setSessionCookie(ctx, token);
        sendJson(ctx.res, 200, { ok: true, authenticated: true });
      },
      false,
    ),
    route('POST', '/auth/logout', (ctx) => {
      store.revokeSession(ctx.token);
      clearSessionCookie(ctx);
      sendJson(ctx.res, 200, { ok: true, authenticated: false });
    }),
    route('POST', '/auth/password', async (ctx) => {
      const body = await ctx.json();
      store.changePassword(body.current_password, body.next_password);
      clearSessionCookie(ctx);
      sendJson(ctx.res, 200, { ok: true, authenticated: false });
    }),

    /* --- снимок и выборки --- */
    route('GET', '/state', (ctx) => {
      sendOk(ctx.res, store.getState());
    }),
    route('GET', '/meta', (ctx) => {
      sendOk(ctx.res, {
        timezone: store.timeZone,
        today: store.today(),
        now: store.now().toISOString(),
      });
    }),
    route('PATCH', '/meta', async (ctx) => {
      const body = await ctx.json();
      if (typeof body.timezone !== 'string') {
        throw new ApiError(400, 'invalid_request', 'Ожидалось поле timezone.');
      }
      sendOk(ctx.res, store.setTimeZone(body.timezone.trim()));
    }),
    route('GET', '/day', (ctx) => {
      const raw = ctx.query.get('date');
      const day = raw === null || raw === '' ? store.today() : assertDayKey(raw, 'Дата');
      sendOk(ctx.res, store.tasksForDay(day));
    }),
    route('GET', '/review', (ctx) => {
      const raw = ctx.query.get('date');
      const day = raw === null || raw === '' ? store.today() : assertDayKey(raw, 'Дата');
      sendOk(ctx.res, store.review(day));
    }),
    route('GET', '/search', (ctx) => {
      sendOk(
        ctx.res,
        store.search(
          ctx.query.get('q') ?? '',
          flag(ctx.query.get('include_completed')),
          flag(ctx.query.get('include_removed')),
        ),
      );
    }),

    /* --- место хаоса --- */
    route('GET', '/chaos', (ctx) => {
      sendOk(ctx.res, { chaos: store.listChaos() });
    }),
    route('POST', '/chaos', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { chaos: store.addChaos(body.text, body.urgent) }, 201);
    }),
    route('PATCH', '/chaos/:id', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, {
        chaos: store.updateChaos(requireParam(ctx, 'id'), { text: body.text, urgent: body.urgent }),
      });
    }),
    route('POST', '/chaos/:id/urgent', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { chaos: store.setChaosUrgent(requireParam(ctx, 'id'), body.urgent) });
    }),
    route('POST', '/chaos/:id/to-task', async (ctx) => {
      const body = await ctx.json();
      const draft: TaskDraft = {
        text: body.text,
        area: body.area,
        project_id: body.project_id,
        status: body.status,
        day: body.day,
        deadline: body.deadline,
        review_date: body.review_date,
        waiting_for: body.waiting_for,
        promised_to: body.promised_to,
        at_risk: body.at_risk,
        details: body.details,
      };
      sendOk(ctx.res, store.chaosToTask(requireParam(ctx, 'id'), draft), 201);
    }),
    route('POST', '/chaos/:id/to-note', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, store.chaosToNote(requireParam(ctx, 'id'), body.title), 201);
    }),
    route('DELETE', '/chaos/:id', (ctx) => {
      sendOk(ctx.res, { removed_chaos_id: store.deleteChaos(requireParam(ctx, 'id')) });
    }),

    /* --- задачи --- */
    route('GET', '/tasks', (ctx) => {
      let tasks = store.visibleTaskList(
        flag(ctx.query.get('show_completed')),
        flag(ctx.query.get('show_removed')),
      );
      const area = ctx.query.get('area');
      if (area) tasks = tasks.filter((task) => task.area === area);
      const projectId = ctx.query.get('project_id');
      if (projectId) tasks = tasks.filter((task) => task.project_id === projectId.toLowerCase());
      const status = ctx.query.get('status');
      if (status) tasks = tasks.filter((task) => task.status === status);
      sendOk(ctx.res, { tasks });
    }),
    route('POST', '/tasks', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { task: store.createTask(taskDraftFrom(body)) }, 201);
    }),
    route('GET', '/tasks/:id', (ctx) => {
      sendOk(ctx.res, { task: store.getTask(requireParam(ctx, 'id')) });
    }),
    route('PATCH', '/tasks/:id', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { task: store.updateTask(requireParam(ctx, 'id'), taskDraftFrom(body)) });
    }),
    route('POST', '/tasks/:id/reschedule', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { task: store.rescheduleTask(requireParam(ctx, 'id'), body.day) });
    }),
    route('POST', '/tasks/:id/complete', (ctx) => {
      sendOk(ctx.res, store.completeTask(requireParam(ctx, 'id')));
    }),
    route('POST', '/tasks/:id/reopen', (ctx) => {
      sendOk(ctx.res, store.reopenTask(requireParam(ctx, 'id')));
    }),
    route('POST', '/tasks/:id/remove', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { task: store.removeTask(requireParam(ctx, 'id'), body.reason) });
    }),
    route('POST', '/tasks/:id/return-to-work', (ctx) => {
      sendOk(ctx.res, { task: store.returnTaskToWork(requireParam(ctx, 'id')) });
    }),
    route('POST', '/tasks/:id/at-risk', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { task: store.setTaskAtRisk(requireParam(ctx, 'id'), body.at_risk) });
    }),
    route('POST', '/tasks/:id/steps', async (ctx) => {
      const body = await ctx.json();
      sendOk(
        ctx.res,
        store.replaceTaskSteps(requireParam(ctx, 'id'), body.steps, {
          revision: body.base_revision,
          updated_at: body.base_updated_at,
        }),
      );
    }),
    route('DELETE', '/tasks/:id', (ctx) => {
      sendOk(ctx.res, { removed_task_id: store.deleteTask(requireParam(ctx, 'id')) });
    }),

    /* --- проекты --- */
    route('GET', '/projects', (ctx) => {
      let projects = store.listProjects();
      if (!flag(ctx.query.get('show_archived'))) {
        projects = projects.filter((project) => !project.archived);
      }
      const area = ctx.query.get('area');
      if (area) projects = projects.filter((project) => project.area === area);
      sendOk(ctx.res, { projects });
    }),
    route('POST', '/projects', async (ctx) => {
      const body = await ctx.json();
      sendOk(
        ctx.res,
        {
          project: store.createProject({
            title: body.title,
            outcome: body.outcome,
            area: body.area,
            uncertainty: body.uncertainty,
            review_date: body.review_date,
          }),
        },
        201,
      );
    }),
    route('GET', '/projects/:id', (ctx) => {
      sendOk(ctx.res, { project: store.getProject(requireParam(ctx, 'id')) });
    }),
    route('PATCH', '/projects/:id', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, {
        project: store.updateProject(requireParam(ctx, 'id'), {
          title: body.title,
          outcome: body.outcome,
          area: body.area,
          uncertainty: body.uncertainty,
          review_date: body.review_date,
        }),
      });
    }),
    route('POST', '/projects/:id/next-action', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { project: store.setNextAction(requireParam(ctx, 'id'), body.task_id) });
    }),
    route('POST', '/projects/:id/archive', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, { project: store.setProjectArchived(requireParam(ctx, 'id'), body.archived) });
    }),
    route('DELETE', '/projects/:id', (ctx) => {
      sendOk(ctx.res, { removed_project_id: store.deleteProject(requireParam(ctx, 'id')) });
    }),

    /* --- дневник --- */
    route('GET', '/entries', (ctx) => {
      const day = ctx.query.get('day');
      const from = ctx.query.get('from');
      const to = ctx.query.get('to');
      const filter: { day?: DayKey; from?: DayKey; to?: DayKey } = {};
      if (day) filter.day = assertDayKey(day, 'Дата');
      if (from) filter.from = assertDayKey(from, 'Начало диапазона');
      if (to) filter.to = assertDayKey(to, 'Конец диапазона');
      sendOk(ctx.res, { entries: store.listEntries(filter) });
    }),
    route('POST', '/entries', async (ctx) => {
      const body = await ctx.json();
      sendOk(
        ctx.res,
        { entry: store.addEntry({ text: body.text, context: body.context, timestamp: body.timestamp }) },
        201,
      );
    }),
    route('PATCH', '/entries/:id', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, {
        entry: store.updateEntry(requireParam(ctx, 'id'), {
          text: body.text,
          context: body.context,
          timestamp: body.timestamp,
        }),
      });
    }),
    route('DELETE', '/entries/:id', (ctx) => {
      sendOk(ctx.res, { removed_entry_id: store.deleteEntry(requireParam(ctx, 'id')) });
    }),

    /* --- заметки и папки --- */
    route('GET', '/notes', (ctx) => {
      const folderParam = ctx.query.get('folder_id');
      const query = ctx.query.get('q') ?? '';
      const filter: { folder_id?: string | null; q?: string } = { q: query };
      if (folderParam !== null) filter.folder_id = folderParam === 'none' ? null : folderParam.toLowerCase();
      let notes: Note[] = store.listNotes(filter);
      if (!flag(ctx.query.get('include_body'), true)) {
        notes = notes.map((note) => ({ ...note, body: '' }));
      }
      sendOk(ctx.res, { notes });
    }),
    route('POST', '/notes', async (ctx) => {
      const body = await ctx.json();
      sendOk(
        ctx.res,
        {
          note: store.createNote({
            title: body.title,
            body: body.body,
            folder_id: body.folder_id,
            pinned: body.pinned,
          }),
        },
        201,
      );
    }),
    route('PATCH', '/notes/:id', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, {
        note: store.updateNote(requireParam(ctx, 'id'), {
          title: body.title,
          body: body.body,
          folder_id: body.folder_id,
          pinned: body.pinned,
        }),
      });
    }),
    route('DELETE', '/notes/:id', (ctx) => {
      sendOk(ctx.res, { removed_note_id: store.deleteNote(requireParam(ctx, 'id')) });
    }),
    route('GET', '/note-folders', (ctx) => {
      sendOk(ctx.res, { note_folders: store.listNoteFolders() });
    }),
    route('POST', '/note-folders', async (ctx) => {
      const body = await ctx.json();
      sendOk(
        ctx.res,
        { note_folder: store.createNoteFolder({ name: body.name, parent_id: body.parent_id }) },
        201,
      );
    }),
    route('PATCH', '/note-folders/:id', async (ctx) => {
      const body = await ctx.json();
      sendOk(ctx.res, {
        note_folder: store.updateNoteFolder(requireParam(ctx, 'id'), {
          name: body.name,
          parent_id: body.parent_id,
        }),
      });
    }),
    route('DELETE', '/note-folders/:id', (ctx) => {
      sendOk(ctx.res, store.deleteNoteFolder(requireParam(ctx, 'id')));
    }),

    /* --- импорт и экспорт --- */
    route('POST', '/import', async (ctx) => {
      const mode = (ctx.query.get('mode') ?? 'merge') as ImportMode;
      if (mode !== 'merge' && mode !== 'overwrite') {
        throw new ApiError(400, 'invalid_request', 'Режим импорта: merge или overwrite.');
      }
      const text = await ctx.text(IMPORT_BODY_LIMIT);
      sendOk(ctx.res, importDocument(store, text, mode));
    }),
    route('GET', '/export.json', (ctx) => {
      const name = exportFileName('chaos-day-export', store.today(), 'json');
      sendFile(ctx.res, 200, exportJson(store), 'application/json; charset=utf-8', name);
    }),
    route('GET', '/export.md', (ctx) => {
      const name = exportFileName('chaos-day-export', store.today(), 'md');
      sendFile(ctx.res, 200, exportMarkdown(store), 'text/markdown; charset=utf-8', name);
    }),

    /* --- пути для приёмки --- */
    route(
      'POST',
      '/dev/reset',
      (ctx) => {
        requireTesting();
        store.resetAll();
        clearSessionCookie(ctx);
        sendOk(ctx.res, { reset: true, setup_required: true });
      },
      false,
    ),
    route(
      'POST',
      '/dev/bootstrap',
      async (ctx) => {
        requireTesting();
        const body = await ctx.json();
        store.resetAll();
        if (typeof body.timezone === 'string' && body.timezone.trim() !== '') {
          store.setTimeZone(body.timezone.trim());
        }
        store.setupPassword(body.password);
        const { token } = store.createSession();
        setSessionCookie(ctx, token);
        sendOk(ctx.res, { reset: true, setup_required: false, authenticated: true });
      },
      false,
    ),
    route(
      'POST',
      '/dev/fault',
      async (ctx) => {
        requireTesting();
        if (!options.allowFaults) throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
        const body = await ctx.json();
        const inject = typeof body.inject === 'string' ? body.inject : '';
        if (inject !== 'save') {
          throw new ApiError(400, 'invalid_request', 'Поддерживается только inject: "save".');
        }
        const times = Number(body.times ?? 1);
        if (!Number.isInteger(times) || times < 0 || times > 100) {
          throw new ApiError(400, 'invalid_request', 'times: целое число от 0 до 100.');
        }
        store.armFault('save', times);
        sendOk(ctx.res, { inject, times });
      },
      false,
    ),
    route(
      'GET',
      '/dev/now',
      (ctx) => {
        requireTesting();
        const shift = Number(ctx.query.get('shift_days') ?? 0);
        if (!Number.isInteger(shift) || Math.abs(shift) > 3650) {
          throw new ApiError(400, 'invalid_request', 'shift_days: целое число в пределах ±3650.');
        }
        const now = store.now();
        const shifted = shift === 0 ? now : new Date(now.getTime() + shift * 86_400_000);
        sendOk(ctx.res, {
          timezone: store.timeZone,
          now: shifted.toISOString(),
          today: todayKey(store.timeZone, shifted),
        });
      },
      false,
    ),
  ];
}

function requireParam(ctx: Ctx, name: string): string {
  const value = ctx.params[name];
  if (!value) throw new ApiError(400, 'invalid_request', `Не задан параметр ${name}.`);
  return value;
}

function taskDraftFrom(body: Record<string, unknown>): TaskDraft {
  return {
    text: body.text,
    day: body.day,
    deadline: body.deadline,
    review_date: body.review_date,
    area: body.area as Area | undefined,
    project_id: body.project_id,
    status: body.status as TaskStatus | undefined,
    waiting_for: body.waiting_for,
    promised_to: body.promised_to,
    at_risk: body.at_risk,
    details: body.details,
  };
}

/* ------------------------------------------------------------------ */
/* Статика                                                             */
/* ------------------------------------------------------------------ */

function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  if (decoded.includes('\0')) return null;
  const full = resolve(join(root, normalize(decoded)));
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (full !== resolve(root) && !full.startsWith(rootWithSep)) return null;
  return full;
}

function sendStaticFile(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const stats = statSync(filePath);
  if (!stats.isFile()) return false;
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const body = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(body.byteLength),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
  return true;
}

function serveClient(options: AppOptions, res: ServerResponse, urlPath: string): void {
  const roots = [options.clientDistDir].filter(
    (dir): dir is string => typeof dir === 'string' && dir !== '' && existsSync(dir),
  );
  const relative = urlPath === '/' ? '/index.html' : urlPath;

  for (const root of roots) {
    const target = safeJoin(root, relative);
    if (target && sendStaticFile(res, target)) return;
  }

  // SPA-fallback: путь без расширения отдаёт index.html.
  if (extname(relative) === '') {
    for (const root of roots) {
      const index = safeJoin(root, '/index.html');
      if (index && sendStaticFile(res, index)) return;
    }
  }

  if (roots.length === 0) {
    sendFile(res, 200, PLACEHOLDER_PAGE, 'text/html; charset=utf-8');
    return;
  }
  sendError(res, 404, 'not_found', 'Страница не найдена.');
}

/* ------------------------------------------------------------------ */
/* Приложение                                                          */
/* ------------------------------------------------------------------ */

export function createApp(options: AppOptions) {
  const routes = buildRoutes(options);
  const { store } = options;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendError(res, 400, 'invalid_request', 'Некорректный адрес запроса.');
      return;
    }
    const pathname = url.pathname;

    try {
      if (!pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendError(res, 405, 'method_not_allowed', MESSAGES.methodNotAllowed(method));
          return;
        }
        serveClient(options, res, pathname);
        return;
      }

      const segments = splitPath(pathname.slice('/api/'.length));
      const secure = isSecureRequest(req);
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];

      // Живая сессия определяется один раз на запрос.
      const session = store.touchSession(token);

      const matched = matchRoute(routes, method, segments);
      if (!matched) {
        sendError(res, 404, 'not_found', 'Такого пути API нет.');
        return;
      }

      if (matched.route.auth && session === null) {
        sendError(res, 401, 'unauthorized', MESSAGES.unauthorized);
        return;
      }

      // Изменяющий запрос с телом обязан объявлять JSON: дополнительная защита от CSRF.
      if (
        ['POST', 'PATCH', 'PUT'].includes(method) &&
        hasBody(req) &&
        !contentTypeIsJson(req)
      ) {
        sendError(res, 415, 'unsupported_media_type', 'Изменяющие запросы принимаются только в JSON.');
        return;
      }

      const ctx: Ctx = {
        req,
        res,
        store,
        query: url.searchParams,
        params: matched.params,
        secure,
        ip: clientIp(req),
        token: session ? token : undefined,
        authenticated: session !== null,
        json: async () => {
          const body = await readJsonBody(req, JSON_BODY_LIMIT);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new ApiError(400, 'invalid_request', 'Ожидался JSON-объект.');
          }
          return body as Record<string, unknown>;
        },
        text: (limit = JSON_BODY_LIMIT) => readTextBody(req, limit),
      };

      await matched.route.handler(ctx);
    } catch (error) {
      sendFromError(res, error);
    }
  };
}

export function createNodeServer(options: AppOptions): Server {
  // Обработчик и его состояние (в том числе счётчик подбора пароля) создаются один раз,
  // а не на каждый запрос.
  const handle = createApp(options);
  return createServer((req, res) => {
    void handle(req, res);
  });
}
