import { defineConfig } from '@playwright/test';

// Isolated browser fixtures: no customer server and no shared E2E authentication.
export default defineConfig({
  testDir: './landing',
  testIgnore: 'production.spec.ts',
  outputDir: './test-results/landing',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: { baseURL: 'http://localhost:3044', viewport: { width: 1440, height: 960 } },
  webServer: {
    command: 'npm run dev -w @carbon/web -- --port 3044 --strictPort',
    url: 'http://localhost:3044/landing.html',
    reuseExistingServer: !process.env.CI,
    env: { CARBON_NO_PWA: '1', VITE_CARBON_E2E: '1' },
  },
});
