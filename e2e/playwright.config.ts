import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const dataDir = process.env.E2E_DATA_DIR ?? join(process.cwd(), 'e2e', '.tmp');
const dbPath = join(dataDir, 'carbon.db');
const blobsDir = join(dataDir, 'blobs');

// sha256('e2e-test-pass') — matches `npm run add-user` legacy format for AUTH_USERS.
const E2E_AUTH_USERS = 'alice:114e2e4c08550bb4210c675e6e83da71ce3e4f30f352ed981d878a1fd9dbea45';

/**
 * Functional E2E: real web UI + live sync server. One worker, fresh server DB per
 * run (global-setup), fresh client storage per test (helpers/reset.ts).
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://localhost:3042',
    actionTimeout: 30_000,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
  },
  webServer: [
    {
      command: 'npm run dev -w @carbon/server',
      url: 'http://localhost:3069/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_PATH: dbPath,
        BLOBS_DIR: blobsDir,
        AUTH_USERS: E2E_AUTH_USERS,
        CORS_ORIGINS: 'http://localhost:3042',
      },
    },
    {
      command: 'npm run dev -w @carbon/web',
      url: 'http://localhost:3042',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        CARBON_NO_PWA: '1',
        VITE_CARBON_E2E: '1',
      },
    },
  ],
});
