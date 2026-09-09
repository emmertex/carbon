import type { BrowserContext, Page } from "@playwright/test";

const SERVER_URL = "http://localhost:3069";
const E2E_USER = "alice";
const E2E_PASS = "e2e-test-pass";

/** Stable functional-test preferences for scenarios that do not exercise onboarding. */
export const E2E_UI_PREFS = {
  swipeLeftAction: "plan",
  paneGestures: true,
  edgeGestureAction: "projectRoot",
  countScope: "all",
  planGrouping: "nested",
  rowIcons: {
    focus: false,
    shared: true,
    assigned: true,
    tags: true,
    flag: true,
    plan: false,
  },
  complexity: "advanced",
  complexityChosen: true,
  welcomed: true,
  features: {},
};

/** Seed the device-local identity directly, without relying on legacy migration.
 * Existing preferences survive reloads. API sign-in seeds its own full identity. */
export const E2E_INIT_SCRIPT = `
  try {
    const key = 'carbon.ui::local|local';
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify(${JSON.stringify(E2E_UI_PREFS)}));
    }
    localStorage.setItem('carbon.e2e', '1');
  } catch { /* ignore */ }
`;

export async function installE2eInit(context: BrowserContext): Promise<void> {
  await context.addInitScript(E2E_INIT_SCRIPT);
}

/** Wipe client-side persistence (IndexedDB + localStorage) for a greenfield tab. */
export async function clearClientStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = await indexedDB.databases?.();
    if (dbs) {
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
    }
    // localforage default store
    indexedDB.deleteDatabase("localforage");
  });
}

export async function resetClient(page: Page): Promise<void> {
  await clearClientStorage(page);
  await page.addInitScript(E2E_INIT_SCRIPT);
  await page.reload({ waitUntil: "domcontentloaded" });
}

export function serverUrl(): string {
  return SERVER_URL;
}

export function e2eCredentials(): { username: string; password: string } {
  return { username: E2E_USER, password: E2E_PASS };
}

export { E2E_USER, E2E_PASS, SERVER_URL };
