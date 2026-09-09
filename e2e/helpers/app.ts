import { expect, type Page } from "@playwright/test";

/** Wait for DB boot; callers also wait for the controls their route renders. */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const e2e = (window as unknown as { __carbonE2e?: { ready: boolean } })
        .__carbonE2e;
      // Every E2E fixture enables this hook. DOM presence must not bypass an
      // unfinished boot, and document load does not wait for async sql.js init.
      return e2e?.ready === true;
    },
    undefined,
    { timeout: 60_000 },
  );
}

export async function gotoFresh(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await waitForApp(page);
}

export async function expectActiveView(
  page: Page,
  title: string,
): Promise<void> {
  await expect(page.getByTestId("active-view")).toHaveText(title);
}

export async function flushClientDb(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (
      window as unknown as { __carbonFlushPersist?: () => Promise<void> }
    ).__carbonFlushPersist?.();
  });
}

export async function dismissWelcomeIfPresent(page: Page): Promise<void> {
  const simple = page.getByRole("button", { name: "Simple" });
  if (await simple.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await page.getByRole("button", { name: "Advanced" }).click();
  }
  // Sync-server intro (SyncIntro) — seeded away via `welcomed: true`, but dismiss
  // defensively in case a future onboarding step reintroduces an overlay.
  const welcome = page.getByRole("button", { name: "Welcome" });
  if (await welcome.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await welcome.click();
    await welcome
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(() => undefined);
  }
}
