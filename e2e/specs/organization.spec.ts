import { test, expect } from '../fixtures/client';
import { addTask, switchScreen } from '../helpers/scenario';
import { expectActiveView } from '../helpers/app';

test.describe('Tier 3 — organization', () => {
  test('creates a tagged task via quick-add tokens', async ({ page }) => {
    await page.goto('/all');
    await page.keyboard.press('c');
    const input = page.getByTestId('quick-add');
    await input.fill('Tagged item #e2e');
    await page.keyboard.press('Escape');
    await input.press('Enter');
    await expect(page.getByTestId('task-row').filter({ hasText: 'Tagged item' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByTestId('task-row').filter({ hasText: 'Tagged item' }),
    ).toContainText('e2e');
  });

  test('flagged view shows flagged quick-add tasks', async ({ page }) => {
    await switchScreen(page, 'flagged');
    await addTask(page, 'Important flagged item');
    await expect(
      page.getByTestId('task-row').filter({ hasText: 'Important flagged item' }),
    ).toBeVisible();
  });

  test('focus mode drills into a task container', async ({ page }) => {
    await page.goto('/inbox');
    await addTask(page, 'Parent project');
    const row = page.getByTestId('task-row').filter({ hasText: 'Parent project' }).first();
    await row.click();
    await page.locator('div.lg\\:flex').getByRole('button', { name: 'Focus' }).click();
    await expect(page.getByRole('heading', { name: 'Parent project' })).toBeVisible();
  });

  test('Review and Time views render', async ({ page }) => {
    await switchScreen(page, 'review');
    await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
    await page.goto('/time');
    await expect(page.getByRole('heading', { name: 'Time' })).toBeVisible();
  });

  test('inbox holds unscheduled capture', async ({ page }) => {
    await switchScreen(page, 'inbox');
    await addTask(page, 'Inbox capture');
    await expectActiveView(page, 'Inbox');
    await expect(page.getByTestId('task-row').filter({ hasText: 'Inbox capture' })).toBeVisible();
  });
});
