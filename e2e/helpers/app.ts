import { expect, type Page } from '@playwright/test';

/** Wait until sql.js has booted and the main shell is interactive. */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const e2e = (window as unknown as { __carbonE2e?: { ready: boolean } }).__carbonE2e;
      if (e2e?.ready) return true;
      return !!document.querySelector('[data-testid="quick-add"]');
    },
    undefined,
    { timeout: 60_000 },
  );
}

export async function gotoFresh(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await waitForApp(page);
}

export async function expectActiveView(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId('active-view')).toHaveText(title);
}

export async function flushClientDb(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (
      window as unknown as { __carbonFlushPersist?: () => Promise<void> }
    ).__carbonFlushPersist?.();
  });
}

export async function dismissWelcomeIfPresent(page: Page): Promise<void> {
  const simple = page.getByRole('button', { name: 'Simple' });
  if (await simple.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await page.getByRole('button', { name: 'Advanced' }).click();
  }
  // Sync-server intro (SyncIntro) — seeded away via `welcomed: true`, but dismiss
  // defensively in case a future onboarding step reintroduces an overlay.
  const welcome = page.getByRole('button', { name: 'Welcome' });
  if (await welcome.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await welcome.click();
    await welcome.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }
}
