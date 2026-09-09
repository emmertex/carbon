import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { E2E_INIT_SCRIPT } from '../helpers/reset';

test('capture synthetic GTD walkthrough from the current application', async ({ page }) => {
  test.skip(process.env.CARBON_CAPTURE_LANDING !== '1', 'Explicit asset-generation run only');
  const output = resolve('e2e/test-results/landing-captures');
  mkdirSync(output, { recursive: true });
  await page.addInitScript(E2E_INIT_SCRIPT);
  await page.addInitScript(() => {
    localStorage.setItem('carbon.themeMode', 'dark');
    localStorage.setItem('carbon.darkTheme', 'dark');
  });
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { role: 'single', status: 'ok' } }),
  );
  await page.goto('/local');
  await page.waitForFunction(() => (window as any).__carbonE2e?.ready);
  const core = `/@fs/${resolve('packages/core/src/index.ts')}`;
  await page.evaluate(async (corePath) => {
    const dbPath = '/src/lib/db.ts';
    const storePath = '/src/lib/store.ts';
    const [{ getDb, getDeviceId, flushPersist }, { useStore }, { createItem }] = await Promise.all([
      import(dbPath),
      import(storePath),
      import(corePath),
    ]);
    const db = getDb(),
      device = getDeviceId();
    createItem(db, device, { title: 'Sort out the garden', sortOrder: 0 });
    createItem(db, device, { title: 'Ask Sam about a weekend walk', sortOrder: 1 });
    createItem(db, device, { title: 'Find a recipe for the spare tomatoes', sortOrder: 2 });
    useStore.getState().bump();
    await flushPersist();
  }, core);
  await page.goto('/inbox');
  await expect(page.getByText('Sort out the garden', { exact: true }).first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${output}/landing-capture.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/inbox');
  await expect(page.getByText('Sort out the garden', { exact: true }).first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${output}/landing-phone.png` });
  await page.setViewportSize({ width: 1440, height: 960 });
  const projectId = await page.evaluate(async (corePath) => {
    const dbPath = '/src/lib/db.ts';
    const storePath = '/src/lib/store.ts';
    const [
      { getDb, getDeviceId, flushPersist },
      { useStore },
      { createItem, updateItem, addToPlan },
    ] = await Promise.all([import(dbPath), import(storePath), import(corePath)]);
    const db = getDb(),
      device = getDeviceId();
    const inboxItem = db.get("SELECT id FROM items WHERE title = 'Sort out the garden'");
    updateItem(db, device, inboxItem.id, {
      type: 'project',
      title: 'Plant the balcony garden',
      order_mode: 'sequential',
      review_interval: 7,
      reviewed_at: '2026-08-01T00:00:00.000Z',
    });
    const project = inboxItem;
    const first = createItem(db, device, {
      title: 'Measure the planter space',
      parentId: project.id,
      sortOrder: 0,
      note: 'Check the sunny corner and leave enough room to open the balcony door.',
    });
    updateItem(db, device, first.id, { estimate_minutes: 15 });
    createItem(db, device, {
      title: 'Choose pots that fit the space',
      parentId: project.id,
      sortOrder: 1,
    });
    createItem(db, device, {
      title: 'Buy soil and herb seedlings',
      parentId: project.id,
      sortOrder: 2,
    });
    createItem(db, device, {
      title: 'Plant the herbs and water them in',
      parentId: project.id,
      sortOrder: 3,
    });
    const weekend = createItem(db, device, {
      title: 'Plan a weekend walk',
      type: 'project',
      sortOrder: 1,
    });
    updateItem(db, device, weekend.id, {
      review_interval: 7,
      reviewed_at: '2026-08-01T00:00:00.000Z',
    });
    const walk = createItem(db, device, {
      title: 'Check the trail map',
      parentId: weekend.id,
      sortOrder: 0,
    });
    updateItem(db, device, walk.id, { estimate_minutes: 20 });
    addToPlan(db, device, null, first.id);
    addToPlan(db, device, null, walk.id);
    useStore.getState().bump();
    await flushPersist();
    return project.id;
  }, core);
  await page.goto(`/project/${projectId}`);
  await expect(page.getByText('Measure the planter space', { exact: true }).first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${output}/landing-organize.png` });
  await page.screenshot({ animations: 'disabled', path: `${output}/landing-overview.png` });
  await page.setViewportSize({ width: 840, height: 1000 });
  await page.goto(`/project/${projectId}`);
  await expect(page.getByText('Measure the planter space', { exact: true }).first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${output}/landing-fold.png` });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/plan');
  await expect(page.getByText('2 tasks budgeted')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${output}/landing-plan.png` });
  await page.goto('/review');
  await expect(page.getByRole('button', { name: 'Reviewed', exact: true }).first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${output}/landing-review.png` });
});
