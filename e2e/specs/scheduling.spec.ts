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
      .getByRole('button', { name: '+1 day', exact: true })
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
    await addTask(page, 'Review task A');
    await addTask(page, 'Review task B');
    await addTask(page, 'Review task C');
    await flushClientDb(page);
    // Review comes due (created_at + interval) — jump the client clock 2 days ahead.
    await page.clock.install({ time: Date.now() + 2 * 24 * 3600 * 1000 });
    await page.goto('/review');
    // The new guided review shows one project at a time with a checklist.
    // The project title appears in the header.
    await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
    await expect(page.getByText('3 open tasks', { exact: false })).toBeVisible();
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Back to Review List' }).click();
    await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
    await expect(page.getByText('Review Complete', { exact: true })).toBeHidden();
    await page.getByRole('main').getByRole('button', { name: 'New Project', exact: true }).click();
    await expect(page.getByRole('checkbox').first()).not.toBeChecked();
    await page.getByRole('button', { name: 'Deep Dive into Tasks' }).click();
    const taskHeading = page.getByRole('heading', { level: 3 });
    const firstTask = await taskHeading.innerText();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    const secondTask = await taskHeading.innerText();
    await page.getByRole('button', { name: 'Exit Deep Dive' }).click();
    await page.getByRole('button', { name: 'Deep Dive into Tasks' }).click();
    await expect(taskHeading).toHaveText(firstTask);
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(taskHeading).toHaveText(secondTask);
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(taskHeading).not.toHaveText(secondTask);
    await page.getByRole('button', { name: 'Drop', exact: true }).click();
    await expect(taskHeading).toHaveText(secondTask);
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(page.getByText('0 open tasks', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deep Dive into Tasks' })).toBeDisabled();
    // Complete the required checklist (5 checkboxes).
    const checkboxes = page.getByRole('checkbox');
    const count = await checkboxes.count();
    expect(count).toBe(5);
    for (let i = 0; i < count; i++) {
      await checkboxes.nth(i).check();
    }
    // Now the "Mark as Reviewed" button should be enabled.
    await page.getByRole('button', { name: 'Mark as Reviewed' }).click();
    // After reviewing all projects, the completion screen appears.
    await expect(page.getByText('Review Complete')).toBeVisible();
    await expect(page.getByText("You've reviewed all 1 projects due for review.")).toBeVisible();
    await gotoFlushed(page, '/review');
    await expect(page.getByText('Nothing to review right now.')).toBeVisible();
  });
});
