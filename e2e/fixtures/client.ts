import { test as base } from '@playwright/test';
import { installE2eInit, clearClientStorage, E2E_INIT_SCRIPT } from '../helpers/reset';
import { waitForApp, dismissWelcomeIfPresent } from '../helpers/app';

/** Shared fresh-client fixture for every functional E2E spec. */
export const test = base.extend({
  page: async ({ page, context }, use) => {
    await installE2eInit(context);
    await page.goto('/');
    await clearClientStorage(page);
    await page.reload();
    await waitForApp(page);
    await dismissWelcomeIfPresent(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
