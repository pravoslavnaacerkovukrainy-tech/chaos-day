import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createNodeServer } from './app.ts';
import type { AppOptions } from './app.ts';
import { databasePath, openDatabase } from './db.ts';
import { DEFAULT_TIMEZONE, Store } from './store.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  databaseFile: string;
  timeZone: string;
  sessionTtlSec: number;
  testing: boolean;
  allowFaults: boolean;
  clientDistDir: string | null;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function enabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dataDir = env.CHAOS_DAY_DATA_DIR
    ? resolve(env.CHAOS_DAY_DATA_DIR)
    : resolve(PROJECT_ROOT, '.data');
  const dist = resolve(PROJECT_ROOT, 'client', 'dist');
  return {
    host: env.HOST ?? '127.0.0.1',
    port: positiveInt(env.PORT, 3000),
    dataDir,
    databaseFile: env.CHAOS_DAY_DB_FILE ? resolve(env.CHAOS_DAY_DB_FILE) : databasePath(dataDir),
    timeZone: env.CHAOS_DAY_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
    sessionTtlSec: positiveInt(env.CHAOS_DAY_SESSION_TTL_SEC, 12 * 60 * 60),
    testing: enabled(env.CHAOS_DAY_TESTING),
    allowFaults: enabled(env.CHAOS_DAY_ALLOW_FAULTS),
    clientDistDir: existsSync(dist) ? dist : null,
  };
}

export function appOptions(config: RuntimeConfig, store: Store): AppOptions {
  return {
    store,
    sessionTtlSec: config.sessionTtlSec,
    testing: config.testing,
    allowFaults: config.allowFaults,
    clientDistDir: config.clientDistDir,
  };
}

export interface Runtime {
  store: Store;
  server: Server;
  config: RuntimeConfig;
  url: string;
  close: () => Promise<void>;
}

/** Открывает хранилище и поднимает HTTP-сервер. Порт 0 даёт свободный порт — для проверок. */
export function startRuntime(config: RuntimeConfig): Promise<Runtime> {
  const database = openDatabase(config.databaseFile);
  const store = new Store(database, {
    timeZone: config.timeZone,
    sessionTtlSec: config.sessionTtlSec,
  });
  const server = createNodeServer(appOptions(config, store));

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Сервер не сообщил адрес прослушивания.'));
        return;
      }
      const url = `http://${address.family === '::' ? '[::1]' : address.address}:${address.port}`;
      resolvePromise({
        store,
        server,
        config,
        url,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              try {
                database.close();
              } catch {
                /* уже закрыта */
              }
              done();
            });
          }),
      });
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await startRuntime(config);
  const shutdown = (): void => {
    void runtime.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // В журнал не пишется текст задач, заметок и пароль.
  process.stdout.write(
    `«Хаос Дня» слушает ${runtime.url}\nДанные: ${config.databaseFile}\nЧасовой пояс: ${runtime.store.timeZone}\n`,
  );
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`Не удалось запустить сервер: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
