import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const acceptanceDir = path.dirname(fileURLToPath(import.meta.url));
const baseURL = process.env.ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: path.join(acceptanceDir, 'tests'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    timezoneId: 'Europe/Kyiv',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { browserName: 'chromium', channel: 'chrome' },
    },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
    },
  ],
  webServer: process.env.ACCEPTANCE_EXTERNAL_SERVER === '1' ? undefined : {
    command: 'npm run dev',
    cwd: process.env.ACCEPTANCE_SERVER_DIR ?? path.resolve(acceptanceDir, '..'),
    url: `${baseURL}/api/health`,
    reuseExistingServer: true,
    timeout: 30_000,
    env: {
      HOST: '127.0.0.1',
      PORT: new URL(baseURL).port || '3100',
      CHAOS_DAY_DATA_DIR: process.env.CHAOS_DAY_DATA_DIR ?? '/tmp/chaos-day-acceptance',
      CHAOS_DAY_TIMEZONE: 'Europe/Kyiv',
      CHAOS_DAY_TESTING: '1',
      CHAOS_DAY_ALLOW_FAULTS: '1',
    },
  },
});
