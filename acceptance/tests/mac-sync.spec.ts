import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addChaos, bootstrap, card, login, navigate, password } from './helpers';

type Task = {
  id: string;
  day: string;
  text: string;
  details: string | null;
  revision: number;
};

type CliResult = {
  code: number;
  json: any;
  stdout: string;
  stderr: string;
};

const cliPath = process.env.MAC_SYNC_CLI;
const serverDir = process.env.MAC_SYNC_SERVER_DIR;
let server: ChildProcess | undefined;
let serverOutput = '';
let runDir = '';

test.skip(!cliPath || !serverDir, 'Нужны MAC_SYNC_CLI и MAC_SYNC_SERVER_DIR от готового клиента и сервера');
test.setTimeout(120_000);

async function startServer(baseURL: string) {
  expect(server).toBeUndefined();
  const url = new URL(baseURL);
  serverOutput = '';
  const child = spawn(process.execPath, ['src/server/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: url.port,
      CHAOS_DAY_DATA_DIR: path.join(runDir, 'server'),
      CHAOS_DAY_TIMEZONE: 'Europe/Kyiv',
      CHAOS_DAY_TESTING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  child.stdout.on('data', (chunk) => { serverOutput += String(chunk); });
  child.stderr.on('data', (chunk) => { serverOutput += String(chunk); });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Сервер завершился рано:\n${serverOutput}`);
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Сервер не запустился:\n${serverOutput}`);
}

async function stopServer() {
  const child = server;
  if (!child) return;
  server = undefined;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const forced = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(forced);
}

async function cli(data: string, args: string[], options: { server?: string; password?: string } = {}): Promise<CliResult> {
  if (!cliPath) throw new Error('MAC_SYNC_CLI не задан');
  const commandArgs = ['--data', data];
  if (options.server) commandArgs.push('--server', options.server);
  commandArgs.push(...args);
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, commandArgs, {
      env: { ...process.env, CHAOS_SYNC_PASSWORD: options.password ?? password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        reject(new Error(`CLI не вернул JSON (код ${code}): ${stdout}\n${stderr}`));
        return;
      }
      resolve({ code: code ?? -1, json, stdout, stderr });
    });
  });
}

function tasksOf(result: CliResult): Task[] {
  const tasks = result.json.tasks ?? result.json.data?.tasks;
  expect(Array.isArray(tasks), `В JSON CLI нет tasks: ${result.stdout}`).toBe(true);
  return tasks;
}

function queueOf(result: CliResult): any[] {
  const queue = result.json.status?.pending ?? result.json.queue ?? result.json.pending
    ?? result.json.data?.queue ?? result.json.data?.pending;
  expect(Array.isArray(queue), `В JSON CLI нет очереди: ${result.stdout}`).toBe(true);
  return queue;
}

function conflictsOf(result: CliResult): any[] {
  if (Array.isArray(result.json.report?.conflicts)) return result.json.report.conflicts;
  if (Array.isArray(result.json.conflicts)) return result.json.conflicts;
  const status = result.json.status ?? result.json.data?.status;
  if (Array.isArray(status?.pending)) {
    return status.pending.filter((item: any) => item.conflict_fields?.length > 0);
  }
  throw new Error(`В JSON CLI нет конфликтов: ${result.stdout}`);
}

function containsTask(items: any[], id: string) {
  return items.some((item) => item === id || item.id === id || item.task_id === id || item.task?.id === id);
}

async function createTask(request: APIRequestContext, text: string): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: { text, area: 'personal', day: '2026-11-14', details: 'Исходные подробности' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data.task;
}

async function fetchTask(request: APIRequestContext, id: string): Promise<Task> {
  const response = await request.get(`/api/tasks/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data.task;
}

async function createThroughWeb(page: Page): Promise<Task> {
  const text = 'Синтетическая задача Mac sync';
  await login(page);
  await addChaos(page, text);
  await card(page, text).getByTestId('chaos-to-task').click();
  const dialog = page.getByTestId('task-editor');
  await dialog.getByTestId('task-day-input').fill('2026-11-14');
  await dialog.getByTestId('task-extra').click();
  await dialog.getByTestId('task-details-input').fill('Исходные подробности');
  await dialog.getByTestId('task-save').click();
  await expect(dialog).toHaveCount(0);
  const response = await page.request.get('/api/tasks?show_completed=1&show_removed=1');
  expect(response.status()).toBe(200);
  const tasks = (await response.json()).data.tasks.filter((task: Task) => task.text === text);
  expect(tasks).toHaveLength(1);
  return tasks[0];
}

test.beforeEach(async ({ request, baseURL }) => {
  expect(baseURL).toBeTruthy();
  runDir = await mkdtemp(path.join(tmpdir(), 'chaos-day-mac-sync-'));
  await startServer(baseURL!);
  await bootstrap(request);
});

test.afterEach(async () => {
  await stopServer();
});

test('web → Mac → offline edit → restart core/server → reconnect без копий', async ({ page, request, baseURL }) => {
  const task = await createThroughWeb(page);
  const mac = path.join(runDir, 'mac-a');

  expect((await cli(mac, ['pull'], { server: baseURL })).code).toBe(0);
  const initial = await cli(mac, ['list']);
  expect(tasksOf(initial).filter((item) => item.id === task.id)).toHaveLength(1);

  expect((await cli(mac, ['offline', 'on'])).code).toBe(0);
  expect((await cli(mac, ['edit', task.id, '--day', '2026-11-15'])).code).toBe(0);
  expect(tasksOf(await cli(mac, ['list'])).find((item) => item.id === task.id)?.day).toBe('2026-11-15');
  expect(containsTask(queueOf(await cli(mac, ['status'])), task.id)).toBe(true);
  expect((await fetchTask(request, task.id)).day).toBe('2026-11-14');

  await stopServer();
  expect(tasksOf(await cli(mac, ['list'])).find((item) => item.id === task.id)?.day).toBe('2026-11-15');
  expect(containsTask(queueOf(await cli(mac, ['status'])), task.id)).toBe(true);
  expect((await cli(mac, ['offline', 'off'])).code).toBe(0);
  expect((await cli(mac, ['push'])).code).not.toBe(0);
  expect(containsTask(queueOf(await cli(mac, ['status'])), task.id)).toBe(true);

  await startServer(baseURL!);
  expect((await cli(mac, ['push'])).code).toBe(0);
  const synced = await fetchTask(request, task.id);
  expect(synced).toMatchObject({ id: task.id, day: '2026-11-15', text: task.text, details: task.details });
  expect((await cli(mac, ['push'])).code).toBe(0);
  expect((await fetchTask(request, task.id)).revision).toBe(synced.revision);

  const all = await request.get('/api/tasks?show_completed=1&show_removed=1');
  expect((await all.json()).data.tasks.filter((item: Task) => item.id === task.id)).toHaveLength(1);
  await page.reload();
  await navigate(page, 'Все задачи');
  await expect(card(page, task.text)).toHaveCount(1);
  await expect(card(page, task.text)).toBeVisible();
});

test('разные поля объединяются; конфликт одного поля решается mine и server', async ({ request, baseURL }) => {
  const macA = path.join(runDir, 'mac-a');
  const macB = path.join(runDir, 'mac-b');
  const task = await createTask(request, 'Синтетическая проверка полей');
  expect((await cli(macA, ['pull'], { server: baseURL })).code).toBe(0);
  expect((await cli(macB, ['pull'], { server: baseURL })).code).toBe(0);

  expect((await cli(macB, ['edit', task.id, '--text', 'Правка второго клиента'])).code).toBe(0);
  expect((await cli(macB, ['push'])).code).toBe(0);
  expect((await cli(macA, ['edit', task.id, '--day', '2026-11-15', '--details', 'Правка Mac'])).code).toBe(0);
  expect((await cli(macA, ['push'])).code).toBe(0);
  expect(await fetchTask(request, task.id)).toMatchObject({
    text: 'Правка второго клиента',
    day: '2026-11-15',
    details: 'Правка Mac',
  });

  expect((await cli(macA, ['pull'])).code).toBe(0);
  expect((await cli(macB, ['pull'])).code).toBe(0);
  expect((await cli(macA, ['edit', task.id, '--day', '2026-11-17'])).code).toBe(0);
  expect((await cli(macB, ['edit', task.id, '--day', '2026-11-16'])).code).toBe(0);
  expect((await cli(macB, ['push'])).code).toBe(0);
  const rejected = await cli(macA, ['push']);
  expect(rejected.code).toBe(3);
  expect(containsTask(conflictsOf(rejected), task.id)).toBe(true);
  expect((await fetchTask(request, task.id)).day).toBe('2026-11-16');
  expect((await cli(macA, ['resolve', task.id, 'day', 'mine'])).code).toBe(0);
  expect((await cli(macA, ['push'])).code).toBe(0);
  expect((await fetchTask(request, task.id)).day).toBe('2026-11-17');

  const serverChoice = await createTask(request, 'Синтетический выбор сервера');
  expect((await cli(macA, ['pull'])).code).toBe(0);
  expect((await cli(macB, ['pull'])).code).toBe(0);
  expect((await cli(macA, ['edit', serverChoice.id, '--text', 'Локальная правка'])).code).toBe(0);
  expect((await cli(macB, ['edit', serverChoice.id, '--text', 'Серверная правка'])).code).toBe(0);
  expect((await cli(macB, ['push'])).code).toBe(0);
  expect((await cli(macA, ['push'])).code).toBe(3);
  expect((await cli(macA, ['resolve', serverChoice.id, 'text', 'server'])).code).toBe(0);
  expect(tasksOf(await cli(macA, ['list'])).find((item) => item.id === serverChoice.id)?.text).toBe('Серверная правка');
  expect(containsTask(queueOf(await cli(macA, ['status'])), serverChoice.id)).toBe(false);
  expect(containsTask(conflictsOf(await cli(macA, ['status'])), serverChoice.id)).toBe(false);
});

test('очередь сохраняется при 401, 404 и требует явного решения', async ({ request, baseURL }) => {
  const mac = path.join(runDir, 'mac-a');
  const unauthorized = await createTask(request, 'Синтетическая проверка 401');
  expect((await cli(mac, ['pull'], { server: baseURL })).code).toBe(0);
  expect((await cli(mac, ['edit', unauthorized.id, '--day', '2026-11-15'])).code).toBe(0);
  expect((await cli(mac, ['push'], { password: 'неверный-пароль' })).code).not.toBe(0);
  expect(containsTask(queueOf(await cli(mac, ['status'])), unauthorized.id)).toBe(true);
  expect((await cli(mac, ['push'])).code).toBe(0);

  const missing = await createTask(request, 'Синтетическая проверка 404');
  expect((await cli(mac, ['pull'])).code).toBe(0);
  expect((await cli(mac, ['edit', missing.id, '--clear-details'])).code).toBe(0);
  expect((await request.delete(`/api/tasks/${missing.id}`)).status()).toBe(200);
  expect((await cli(mac, ['push'])).code).not.toBe(0);
  expect(containsTask(queueOf(await cli(mac, ['status'])), missing.id)).toBe(true);
  expect((await cli(mac, ['discard', missing.id])).code).toBe(0);
  expect(containsTask(queueOf(await cli(mac, ['status'])), missing.id)).toBe(false);
});
