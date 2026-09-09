import { test, expect } from '@playwright/test';
import { E2E_INIT_SCRIPT } from '../helpers/reset';

// The built server serves the built web bundle; no route handlers are mocked.
test('production apex is static and local CTA reaches the configured offline host', async ({
  page,
  request,
}) => {
  const response = await request.get('/');
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('A clear place for your projects and next actions.');
  expect(html).toContain('href="//offline.localhost:3051/local"');
  expect(html).not.toMatch(/registerSW|registerSW\.js|\/assets\/app-|\.wasm|rel="manifest"/);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://localhost/');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    'https://localhost/shots/landing-overview.png',
  );
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  expect(
    await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)),
  ).toBe(0);
  expect(
    requests.filter((url) => /\.wasm|\/api\/|\/assets\/(boot|db|store|app)-/.test(url)),
  ).toEqual([]);
  await page.addInitScript(E2E_INIT_SCRIPT);
  await page
    .getByRole('link', { name: /Try locally/ })
    .first()
    .click();
  await expect(page).toHaveURL('http://offline.localhost:3051/today');
  await expect(page.getByText('Local only', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('carbon.server')!).url)).toBe(
    '',
  );
  await page.goto('http://offline.localhost:3051/inbox');
  const add = page.getByPlaceholder(/Add a task/).first();
  await add.fill('Production local capture');
  await add.press('Enter');
  await expect(page.getByText('Production local capture', { exact: true }).first()).toBeVisible();
  // Wait for the normal debounced write to reach durable browser storage.
  // Immediate reload/termination durability belongs to the application A3 gate.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open('carbon');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const read = db.transaction('carbon').objectStore('carbon').get('carbon_db');
              read.onsuccess = () => {
                db.close();
                resolve(new TextDecoder().decode(read.result).includes('Production local capture'));
              };
              read.onerror = () => {
                db.close();
                reject(read.error);
              };
            };
          }),
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)),
    )
    .toBe(1);
  await page.reload();
  await expect(page.getByText('Production local capture', { exact: true }).first()).toBeVisible();
  expect(requests.filter((url) => /\/api\/(sync|me|login)/.test(url))).toEqual([]);
});

test('production signup stays on the apex and workspace finder preserves environment', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Workspace name').fill('bad.evil.test');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('status')).toContainText('Enter a workspace name');
  await page.getByLabel('Workspace name').fill('my-work');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page).toHaveURL('http://my-work.localhost:3051/');
  await page.goto('/');
  await page.getByRole('link', { name: 'Create a hosted workspace', exact: true }).first().click();
  await expect(page).toHaveURL('http://localhost:3051/signup');
  await expect(page.getByRole('heading', { name: 'Create a Carbon workspace' })).toBeVisible();
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
});

test('a cached app shell on the apex hands off before loading the database', async ({
  page,
  request,
}) => {
  const shell = await (await request.get('/index.html')).text();
  await page.route('http://localhost:3051/', (route) =>
    route.fulfill({ contentType: 'text/html', body: shell }),
  );
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/');
  await expect(page).toHaveURL('http://localhost:3051/landing');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'A clear place for your projects and next actions.',
  );
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  expect(requests.filter((url) => /\.wasm|\/assets\/(boot|db|store)-/.test(url))).toEqual([]);
});
