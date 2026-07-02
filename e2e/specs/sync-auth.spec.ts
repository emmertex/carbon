import { test, expect } from '../fixtures/client';
import { addTask, signInWithApi } from '../helpers/scenario';
import { serverUrl, e2eCredentials } from '../helpers/reset';
import { createTask, listTasks, login, health, createApiToken } from '../helpers/api';

test.describe('Tier 2 — sync and auth', () => {
  test('server health endpoint responds', async () => {
    const h = await health(serverUrl());
    expect(h).toBeTruthy();
  });

  test('signs in and shows synced status', async ({ page }) => {
    const { username, password } = e2eCredentials();
    await signInWithApi(page, serverUrl(), username, password);
  });

  test('sync push: UI task appears on server', async ({ page }) => {
    const { username, password } = e2eCredentials();
    await signInWithApi(page, serverUrl(), username, password);
    const title = `E2E push ${Date.now()}`;
    await addTask(page, title);
    const syncResp = page.waitForResponse(
      (r) => r.url().includes('/api/sync') && r.request().method() === 'POST',
    );
    await page.getByTestId('sync-status').click();
    await syncResp;
    const { token } = await login(serverUrl(), username, password);
    await expect
      .poll(async () => (await listTasks(token)).some((t) => t.title === title), {
        timeout: 30_000,
      })
      .toBe(true);
  });

  test('sync pull: server task appears in UI', async ({ page }) => {
    const { username, password } = e2eCredentials();
    const { token } = await login(serverUrl(), username, password);
    const title = `E2E pull ${Date.now()}`;
    await createTask(token, title);
    await signInWithApi(page, serverUrl(), username, password);
    await page.getByTestId('sync-status').click();
    await page.waitForResponse(
      (r) => r.url().includes('/api/sync') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.goto('/all');
    await expect(page.getByTestId('task-row').filter({ hasText: title })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('scoped API token can read tasks', async () => {
    const { username, password } = e2eCredentials();
    const { basic, token: session } = await login(serverUrl(), username, password);
    const title = `E2E token ${Date.now()}`;
    await createTask(session, title);
    const { token: apiToken } = await createApiToken(basic, 'e2e-read', ['tasks:read']);
    const tasks = await listTasks(apiToken);
    expect(tasks.some((t) => t.title === title)).toBe(true);
  });
});
