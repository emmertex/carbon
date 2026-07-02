import { test, expect } from '../fixtures/client';
import { addTask, switchScreen, completeFirstTask } from '../helpers/scenario';
import { expectActiveView } from '../helpers/app';

test.describe('Tier 1 — local core', () => {
  test('boots and shows Today view', async ({ page }) => {
    await expectActiveView(page, 'Today');
    await expect(page.getByTestId('quick-add')).toBeVisible();
  });

  test('quick-add creates a task on Today', async ({ page }) => {
    await addTask(page, 'Buy milk');
    await expect(page.getByTestId('task-row').filter({ hasText: 'Buy milk' })).toBeVisible();
  });

  test('completes a task from the list', async ({ page }) => {
    await page.goto('/all');
    await addTask(page, 'Complete me');
    await completeFirstTask(page, 'Complete me');
  });

  test('navigates across core views via g-leader shortcuts', async ({ page }) => {
    await switchScreen(page, 'inbox');
    await expectActiveView(page, 'Inbox');
    await switchScreen(page, 'flagged');
    await expectActiveView(page, 'Flagged');
    await switchScreen(page, 'all');
    await expectActiveView(page, 'All Tasks');
    await switchScreen(page, 'today');
    await expectActiveView(page, 'Today');
  });

  test('undo restores a completed task', async ({ page }) => {
    await page.goto('/all');
    await addTask(page, 'Undo target');
    await completeFirstTask(page, 'Undo target');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await expect(
      page.getByTestId('task-row').filter({ hasText: 'Undo target' }).first(),
    ).toHaveAttribute('data-status', 'active', { timeout: 15_000 });
  });

  test('Plan and Forecast views render', async ({ page }) => {
    await page.goto('/plan');
    await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
    await page.goto('/forecast');
    await expect(page.getByRole('heading', { name: 'Forecast' })).toBeVisible();
  });

  test('appearance settings toggle dark mode chip', async ({ page }) => {
    await page.goto('/settings');
    await page
      .locator('section#appearance')
      .getByRole('button', { name: 'Dark', exact: true })
      .first()
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
