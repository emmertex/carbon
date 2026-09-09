import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'carbon-landing-server-'));
export default defineConfig({
  testDir: './landing',
  testMatch: 'production.spec.ts',
  outputDir: './test-results/landing-production',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: { baseURL: 'http://localhost:3051', viewport: { width: 1440, height: 960 } },
  webServer: {
    command: 'node apps/server/dist/index.js',
    cwd: resolve('.'),
    url: 'http://localhost:3051/api/health',
    reuseExistingServer: false,
    env: {
      PORT: '3051',
      DATABASE_PATH: join(data, 'carbon.db'),
      CONTROL_DB_PATH: join(data, 'control.db'),
      BLOBS_DIR: join(data, 'blobs'),
      TENANTS_DIR: join(data, 'tenants'),
      STATIC_DIR: resolve('apps/web/dist'),
      BASE_DOMAIN: 'localhost',
      APP_HOST: 'offline',
      CORS_ORIGINS: 'http://localhost:3051,http://offline.localhost:3051',
      AUTH_USERS: '',
      HOST_ADMINS: '',
      TELEGRAM_BOT_TOKEN: '',
    },
  },
});
