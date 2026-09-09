import { expect, type Locator, type Page } from "@playwright/test";
import { login } from "./api";
import { E2E_UI_PREFS } from "./reset";
import { flushClientDb, waitForApp } from "./app";

const GO_KEY = {
  today: "t",
  inbox: "i",
  flagged: "f",
  all: "a",
  plan: "p",
  forecast: "o",
  review: "r",
} as const;

const GO_TITLE: Record<keyof typeof GO_KEY, string> = {
  today: "Today",
  inbox: "Inbox",
  flagged: "Flagged",
  all: "All Tasks",
  plan: "Plan",
  forecast: "Forecast",
  review: "Review",
};

async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
}

/** Switch screen via the `g`-leader shortcut. */
export async function switchScreen(
  page: Page,
  screen: keyof typeof GO_KEY,
): Promise<void> {
  await waitForApp(page);
  await blurActive(page);
  await page.keyboard.press("g");
  await page.keyboard.press(GO_KEY[screen]!);
  await page.waitForURL(`**/${screen}`, { timeout: 30_000 });
  // History updates before React commits the destination. The previous view's
  // quick-add can still be visible, with its old creation defaults, until then.
  if (["today", "inbox", "flagged", "all"].includes(screen)) {
    await expect(page.getByTestId("active-view")).toHaveText(GO_TITLE[screen]);
  } else {
    await expect(
      page.getByRole("heading", {
        name: GO_TITLE[screen],
        exact: true,
        level: 1,
      }),
    ).toBeVisible();
  }
}

/** Focus quick-add via `c`, type a title, commit with Enter. */
export async function addTask(
  page: Page,
  title: string,
  opts?: { visibleTitle?: string },
): Promise<void> {
  await waitForApp(page);
  const input = page.getByTestId("quick-add");
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await blurActive(page);
  await page.keyboard.press("c");
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill(title);
  await input.press("Enter");
  const needle = opts?.visibleTitle ?? title.replace(/\s#[^\s]+$/, "").trim();
  await expect(
    page.getByTestId("task-row").filter({ hasText: needle }).first(),
  ).toBeVisible({
    timeout: 15_000,
  });
}

/** Complete a task; default views hide completed rows, so assert it leaves the list. */
export async function completeFirstTask(
  page: Page,
  title: string,
): Promise<void> {
  const row = page.getByTestId("task-row").filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Mark complete" }).click();
  await expect(
    page.getByTestId("task-row").filter({ hasText: title }),
  ).toHaveCount(0, {
    timeout: 15_000,
  });
}

/** Click a task row and return the docked detail pane once visible. */
export async function openDetail(page: Page, title: string): Promise<Locator> {
  await page.getByTestId("task-row").filter({ hasText: title }).first().click();
  const pane = page.getByTestId("task-detail");
  await expect(pane).toBeVisible();
  return pane;
}

/**
 * The innermost field group in the detail pane whose <Label> matches exactly —
 * scopes chip buttons like "Today"/"Tomorrow" that repeat across Due and Defer.
 */
export function detailField(pane: Locator, label: string): Locator {
  return pane
    .locator("div")
    .filter({ has: pane.page().getByText(label, { exact: true }) })
    .last();
}

/** Trigger a manual sync via the header indicator and wait for the round-trip. */
export async function syncNow(page: Page): Promise<void> {
  const resp = page.waitForResponse(
    (r) => r.url().includes("/api/sync") && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page.getByTestId("sync-status").click();
  await resp;
  // Synced-in records live in the in-memory sql.js DB until the debounced
  // IndexedDB persist fires — flush so a follow-up goto can't lose them.
  await flushClientDb(page);
}

/**
 * Navigate after mutations. Client persistence is debounced (sql.js →
 * IndexedDB); a bare goto reloads the page and drops unflushed writes.
 */
export async function gotoFlushed(page: Page, path: string): Promise<void> {
  await flushClientDb(page);
  await page.goto(path);
  await waitForApp(page);
}

export async function openSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.waitForURL("**/settings");
}

export async function signInViaUi(
  page: Page,
  serverUrl: string,
  username: string,
  password: string,
): Promise<void> {
  await page.evaluate(
    ({ url, username }) => {
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({
          url,
          username,
          password: "",
          token: "",
          autoSync: true,
        }),
      );
    },
    { url: serverUrl, username },
  );
  await openSettings(page);
  await page.locator("#sync").scrollIntoViewIfNeeded();
  await page
    .getByTestId("settings-sync")
    .getByRole("button", { name: "Login" })
    .click();
  const gate = page.getByTestId("sign-in");
  await expect(gate).toBeVisible();
  if (
    await gate
      .getByLabel("Server URL")
      .isVisible()
      .catch(() => false)
  ) {
    await gate.getByLabel("Server URL").fill(serverUrl);
    await gate.getByRole("button", { name: "Continue" }).click();
  }
  await gate.getByLabel("Username").fill(username);
  await gate.getByLabel("Password").fill(password);
  const syncPromise = page.waitForResponse(
    (r) => r.url().includes("/api/sync") && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await gate.getByRole("button", { name: "Sign in" }).click();
  await syncPromise.catch(() => undefined);
  await expect(page.getByTestId("sign-in")).toBeHidden({ timeout: 30_000 });
}

/** Faster, more stable sign-in for sync specs — exchanges password via API, reloads. */
export async function signInWithApi(
  page: Page,
  serverUrl: string,
  username: string,
  password: string,
): Promise<void> {
  const { token, user } = await login(serverUrl, username, password);
  await page.evaluate(
    ({ url, username, token, userId, prefs }) => {
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url, username, password: "", token, autoSync: true }),
      );
      const workspace = url.trim().toLowerCase().replace(/\/+$/, "");
      // This helper bypasses UI login, so mirror its positive auth marker and
      // seed the account that /api/me will bind, not the old local namespace.
      localStorage.setItem(
        `carbon.wsauth.${workspace}`,
        JSON.stringify({ s: "in", t: Date.now() }),
      );
      localStorage.setItem(
        `carbon.ui::${workspace}|u:${userId}`,
        JSON.stringify(prefs),
      );
    },
    { url: serverUrl, username, token, userId: user.id, prefs: E2E_UI_PREFS },
  );
  await page.reload();
  await waitForApp(page);
  await expect(page.getByTestId("sync-status")).toContainText(/Synced|alice/i, {
    timeout: 30_000,
  });
  await expect(
    page.getByRole("dialog", { name: "Welcome to Carbon" }),
  ).toBeHidden();
  await expect(
    page.getByRole("dialog", { name: "Carbon is better connected" }),
  ).toBeHidden();
}

export async function configureServerUrl(
  page: Page,
  url: string,
  username = "",
): Promise<void> {
  const { setServerConfig } = await import("./reset");
  await setServerConfig(page, url, username);
}
