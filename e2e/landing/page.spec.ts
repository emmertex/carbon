import { test, expect } from '@playwright/test';
import { E2E_INIT_SCRIPT } from '../helpers/reset';

const title = 'A clear place for your projects and next actions.';

test('static content and crawlable actions remain available without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://localhost:3044/landing.html');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('link', { name: /Try locally/ }).first()).toHaveAttribute(
    'href',
    '/local',
  );
  await expect(page.getByText('$7.50')).toBeVisible();
  await expect(page.getByText('$20', { exact: false }).first()).toBeVisible();
  await page.getByText('Do I need an account?', { exact: true }).click();
  await expect(page.getByText('No. Choose Try locally', { exact: false })).toBeVisible();
  await context.close();
});

test('landing never initializes the app, database or service worker', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/landing.html');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  expect(
    requests.filter((url) => /sql|wasm|\/boot\.|\/db\.|\/store\.|\/api\/|\/sw\.js/.test(url)),
  ).toEqual([]);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  expect(
    await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)),
  ).toBe(0);
});

test('Try locally survives reload without an account or a sync request on a single host', async ({
  page,
}) => {
  await page.addInitScript(E2E_INIT_SCRIPT);
  await page.route('**/api/health', (r) => r.fulfill({ json: { status: 'ok', role: 'single' } }));
  const sync: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/(sync|me|login)/.test(r.url())) sync.push(r.url());
  });
  await page.goto('/landing.html');
  await page
    .getByRole('link', { name: /Try locally/ })
    .first()
    .click();
  await expect(page).toHaveURL(/localhost:3044\/today$/);
  await page.waitForFunction(() => (window as any).__carbonE2e?.ready);
  await page.goto('/inbox');
  const add = page.getByPlaceholder(/Add a task/).first();
  await add.fill('Measure the planter space');
  await add.press('Enter');
  await expect(page.getByText('Measure the planter space', { exact: true }).first()).toBeVisible();
  // Exercise the real persist flush before navigation, as a tab hide does.
  await page.evaluate(async () => {
    const path = '/src/lib/db.ts';
    await (await import(path)).flushPersist();
  });
  await page.reload();
  await expect(page.getByText('Measure the planter space', { exact: true }).first()).toBeVisible();
  expect(sync).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('carbon.server')!).url)).toBe(
    '',
  );
});

test('signup and privacy render without the task database; Back runs the app entry', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/signup');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: false }).first()).toBeVisible();
  expect(requests.filter((url) => /sql|wasm|\/boot\.|\/db\.|\/store\./.test(url))).toEqual([]);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible();
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
});

for (const width of [320, 390, 840, 1440]) {
  test(`landing fits ${width}px, loads images and works at 200% text size`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto('/landing.html');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const image of await page.locator('main img').all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);
      expect(await image.getAttribute('alt')).toBeTruthy();
      expect(await image.getAttribute('width')).toBeTruthy();
      expect(await image.getAttribute('height')).toBeTruthy();
    }
    for (const link of await page.locator('a[href^="#"]').all()) {
      const href = (await link.getAttribute('href'))!;
      await expect(page.locator(href)).toHaveCount(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `e2e/test-results/landing-${width}.png`, fullPage: true });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `e2e/test-results/landing-${width}-text200.png`,
      fullPage: true,
    });
  });
}

test('keyboard focus, skip navigation and FAQ are usable', async ({ page }) => {
  await page.goto('/landing.html');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  const question = page.locator('summary').first();
  await question.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('details').first()).toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(page.locator('details').first()).not.toHaveAttribute('open', '');
});

test('screenshots reserve space, and full-size image links load', async ({ page, request }) => {
  await page.addInitScript(() => {
    (window as any).__landingShift = 0;
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries() as any[]) {
        if (!entry.hadRecentInput) (window as any).__landingShift += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto('/landing.html');
  for (const img of await page.locator('main img').all()) {
    await img.scrollIntoViewIfNeeded();
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);
  }
  expect(await page.evaluate(() => (window as any).__landingShift)).toBeLessThan(0.01);
  for (const link of await page.locator('a[href^="/shots/"]').all()) {
    const response = await request.get((await link.getAttribute('href'))!);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toMatch(/^image\//);
  }
});
