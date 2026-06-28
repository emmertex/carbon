import { defineConfig } from '@playwright/test';

/**
 * Config for the Carbon keyboard-driven performance benchmark.
 *
 * The benchmark grows the in-browser task list to 1k then 10k tasks and drives
 * real keyboard interactions while collecting in-app timing. It is long-running
 * and stateful, so: one worker, no parallelism, no retries, a generous timeout.
 *
 * `webServer` starts the web app (only) with the service worker disabled. If you
 * already have `CARBON_NO_PWA=1 npm run dev` running, it is reused.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 45 * 60 * 1000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://localhost:3042',
    actionTimeout: 60_000,
  },
  webServer: {
    command: 'npm run dev --workspace @carbon/web',
    url: 'http://localhost:3042',
    reuseExistingServer: true,
    timeout: 120_000,
    env: { CARBON_NO_PWA: '1' },
  },
});
