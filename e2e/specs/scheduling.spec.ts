import { test, expect } from '../fixtures/client';
import { addTask, detailField, gotoFlushed, openDetail } from '../helpers/scenario';
import { flushClientDb } from '../helpers/app';

test.describe('Tier 6 — scheduling', () => {
  test('task made due today appears on Today with a due label', async ({ page }) => {
    await page.goto('/all');
    const title = `Due today ${Date.now()}`;
    await addTask(page, title);
    const pane = await openDetail(page, title);
    await detailField(pane, 'Due').getByRole('button', { name: 'Today', exact: true }).click();
    await gotoFlushed(page, '/today');
    const row = page.getByTestId('task-row').filter({ hasText: title }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Today');
  });

  test('deferred task hides from Today but stays in All', async ({ page }) => {
    await page.goto('/all');
    const title = `Deferred ${Date.now()}`;
    await addTask(page, title);
    const pane = await openDetail(page, title);
    await detailField(pane, 'Due').getByRole('button', { name: 'Today', exact: true }).click();
    // Defer controls hide behind a reveal unless GTD tools are enabled.
    const reveal = pane.getByRole('button', { name: 'More… (defer date)' });
    if (await reveal.isVisible().catch(() => false)) await reveal.click();
    await detailField(pane, 'Defer until')
      .getByRole('button', { name: 'Tomorrow', exact: true })
      .click();
    await gotoFlushed(page, '/today');
    await expect(page.getByTestId('task-row').filter({ hasText: title })).toHaveCount(0);
    await gotoFlushed(page, '/all');
    await expect(page.getByTestId('task-row').filter({ hasText: title })).toBeVisible();
  });

  test('completing a daily recurring task spawns the next occurrence', async ({ page }) => {
    await page.goto('/all');
    const title = `Standup ${Date.now()}`;
    await addTask(page, title);
    const pane = await openDetail(page, title);
    await detailField(pane, 'Due').getByRole('button', { name: 'Today', exact: true }).click();
    await detailField(pane, 'Repeat').locator('select').first().selectOption('daily');
    const row = page.getByTestId('task-row').filter({ hasText: title }).first();
    await row.getByRole('button', { name: 'Mark complete' }).click();
    // The done row leaves the default view; the respawned occurrence replaces it,
    // due tomorrow.
    const next = page.getByTestId('task-row').filter({ hasText: title }).first();
    await expect(next).toHaveAttribute('data-status', 'active', { timeout: 15_000 });
    await expect(next).toContainText('Tomorrow');
  });

  test('project with a review interval surfaces in Review and clears', async ({ page }) => {
    await page.getByRole('button', { name: 'New folder or project' }).click();
    await page.getByRole('button', { name: 'New Parallel Project' }).click();
    await page.waitForURL('**/project/**');
    const pane = page.getByTestId('task-detail');
    await expect(pane).toBeVisible();
    await pane.getByPlaceholder('30').fill('1');
    await flushClientDb(page);
    // Review comes due (created_at + interval) — jump the client clock 2 days ahead.
    await page.clock.install({ time: Date.now() + 2 * 24 * 3600 * 1000 });
    await page.goto('/review');
    // Scope to main: the sidebar lists the project under the same link name.
    const entry = page.getByRole('main').getByRole('link', { name: 'New Project' });
    await expect(entry).toBeVisible();
    await page.getByRole('button', { name: 'Reviewed' }).click();
    await expect(entry).toBeHidden();
    await expect(page.getByText('Nothing to review right now.')).toBeVisible();
  });
});
