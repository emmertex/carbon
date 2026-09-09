import { test, expect } from '../fixtures/client';
import { addTask } from '../helpers/scenario';

test('phone details are full width, mount once, retain edits when resized, and support first tap', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/all');
  await addTask(page, 'Adaptive task');
  const row = page.getByTestId('task-row').filter({ hasText: 'Adaptive task' }).first();
  await row.click();
  await row.click();
  const pane = page.getByTestId('task-detail');
  await expect(pane).toHaveCount(1);
  await expect(pane).toBeVisible();
  const box = await pane.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(358);
  const overflow = await pane.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
  await pane.getByPlaceholder('Title', { exact: true }).fill('Retained after resize');
  await pane.getByPlaceholder('Title', { exact: true }).blur();
  await page.setViewportSize({ width: 900, height: 780 });
  await expect(pane).toHaveCount(1);
  await expect(pane.getByPlaceholder('Title', { exact: true })).toHaveValue('Retained after resize');
  await pane.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 360, height: 780 });
  await page.evaluate(() => (window as any).__carbonE2e.firstTapDetails(true));
  await page.getByTestId('task-row').filter({ hasText: 'Retained after resize' }).first().click();
  await expect(pane).toBeVisible();
});

