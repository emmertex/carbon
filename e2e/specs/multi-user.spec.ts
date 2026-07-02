import { test, expect } from '../fixtures/client';
import { addTask, gotoFlushed, openDetail, signInWithApi, syncNow } from '../helpers/scenario';
import { serverUrl, e2eCredentials, installE2eInit } from '../helpers/reset';
import { waitForApp, dismissWelcomeIfPresent } from '../helpers/app';
import { login, createUser } from '../helpers/api';

/**
 * Tier 7 — two real browser contexts against one server: alice shares a task
 * with bob, bob sees it after sync and comments back. This is the single-server
 * baseline the future federation e2e (cross-server share) will diff against.
 */
test.describe('Tier 7 — multi-user sharing', () => {
  test('task shared with a second user syncs both ways', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const { username, password } = e2eCredentials();
    const { basic } = await login(serverUrl(), username, password);
    const bob = `bob${Date.now()}`;
    const bobPass = 'bob-pass';
    // Bob must exist before alice's first sync so he lands in her roster.
    await createUser(basic, bob, bobPass);

    await signInWithApi(page, serverUrl(), username, password);
    await gotoFlushed(page, '/all');
    const title = `Shared task ${Date.now()}`;
    await addTask(page, title);

    // Grant bob write access from the detail pane's Sharing section.
    const pane = await openDetail(page, title);
    await pane.getByRole('button', { name: /^Sharing/ }).click();
    const bobShareRow = pane
      .locator('div.flex.items-center')
      .filter({ hasText: bob })
      .filter({ has: page.locator('select') })
      .first();
    await bobShareRow.locator('select').selectOption('write');
    await syncNow(page);

    // Bob signs in from a second, isolated browser context.
    const ctx = await browser.newContext();
    await installE2eInit(ctx);
    const page2 = await ctx.newPage();
    await page2.goto('/');
    await waitForApp(page2);
    await dismissWelcomeIfPresent(page2);
    await signInWithApi(page2, serverUrl(), bob, bobPass);
    await gotoFlushed(page2, '/all');
    const sharedRow = page2.getByTestId('task-row').filter({ hasText: title }).first();
    await expect(sharedRow).toBeVisible({ timeout: 30_000 });

    // Bob comments; the comment flows back to alice on her next sync.
    await sharedRow.click();
    const reply = `Reply from ${bob}`;
    await page2.getByPlaceholder('Write a comment').fill(reply);
    await page2.getByRole('button', { name: 'Send comment' }).click();
    await expect(page2.getByText(reply)).toBeVisible();
    await syncNow(page2);

    await syncNow(page);
    await openDetail(page, title);
    await expect(page.getByText(reply)).toBeVisible({ timeout: 30_000 });

    await ctx.close();
  });

  test('assigning a user auto-shares the task', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const { username, password } = e2eCredentials();
    const { basic } = await login(serverUrl(), username, password);
    const bob = `bob${Date.now()}`;
    const bobPass = 'bob-pass';
    await createUser(basic, bob, bobPass);

    await signInWithApi(page, serverUrl(), username, password);
    await gotoFlushed(page, '/all');
    const title = `Assigned task ${Date.now()}`;
    await addTask(page, title);

    const pane = await openDetail(page, title);
    await pane.getByRole('button', { name: /^Sharing/ }).click();
    // "Assigned to" roster chip (avatar letter + name) — assignment implies a
    // write share. hasText, not exact name: the avatar letter joins the label.
    await pane.locator('button').filter({ hasText: bob }).first().click();
    await syncNow(page);

    const ctx = await browser.newContext();
    await installE2eInit(ctx);
    const page2 = await ctx.newPage();
    await page2.goto('/');
    await waitForApp(page2);
    await dismissWelcomeIfPresent(page2);
    await signInWithApi(page2, serverUrl(), bob, bobPass);
    await gotoFlushed(page2, '/all');
    await expect(
      page2.getByTestId('task-row').filter({ hasText: title }).first(),
    ).toBeVisible({ timeout: 30_000 });

    await ctx.close();
  });
});
