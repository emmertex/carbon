import { test, expect } from '../fixtures/client';
import { addTask, signInWithApi } from '../helpers/scenario';
import { serverUrl, e2eCredentials } from '../helpers/reset';
import {
  login,
  createTask,
  addComment,
  agentLists,
} from '../helpers/api';

test.describe('Tier 5 — collaboration and server APIs', () => {
  test('adds a comment on a task in the detail pane', async ({ page }) => {
    const { username, password } = e2eCredentials();
    await signInWithApi(page, serverUrl(), username, password);
    const title = `Comment task ${Date.now()}`;
    await addTask(page, title);
    await page.getByTestId('task-row').filter({ hasText: title }).first().click();
    const body = 'E2E comment body';
    await page.getByPlaceholder('Write a comment').fill(body);
    await page.getByRole('button', { name: 'Send comment' }).click();
    await expect(page.getByText(body)).toBeVisible();
  });

  test('agent API lists endpoint responds when authenticated', async () => {
    const { username, password } = e2eCredentials();
    const { token } = await login(serverUrl(), username, password);
    const { lists } = await agentLists(token);
    expect(Array.isArray(lists)).toBe(true);
  });

  test('server comment via API is visible after sync pull', async ({ page }) => {
    const { username, password } = e2eCredentials();
    const { token } = await login(serverUrl(), username, password);
    const title = `API comment ${Date.now()}`;
    const task = await createTask(token, title);
    await addComment(token, task.id, 'From API');
    await signInWithApi(page, serverUrl(), username, password);
    await page.getByTestId('sync-status').click();
    await page.waitForResponse(
      (r) => r.url().includes('/api/sync') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.goto('/all');
    await page.getByTestId('task-row').filter({ hasText: title }).first().click();
    await expect(page.getByText('From API')).toBeVisible({ timeout: 30_000 });
  });

  test('admin can create a second user', async () => {
    const { username, password } = e2eCredentials();
    const { token } = await login(serverUrl(), username, password);
    const bob = `bob${Date.now()}`;
    const res = await fetch(`${serverUrl()}/api/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: bob, password: 'bob-pass', role: 'member' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { username: string };
    expect(body.username).toBe(bob);
  });
});
