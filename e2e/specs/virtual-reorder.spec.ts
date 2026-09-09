import { test, expect } from '../fixtures/client';
import { waitForApp } from '../helpers/app';

test('250 rows remain virtualized and support dragging plus precise distant moves', async ({ page }) => {
  await page.goto('/all');
  await waitForApp(page);
  const ids = await page.evaluate(async () => (window as any).__carbonE2e.seedReorderTasks(250)) as string[];
  await expect(page.getByTestId('task-row').first()).toBeVisible();
  expect(await page.getByTestId('task-row').count()).toBeLessThan(100);
  const sortable = page.locator(`[data-sortable-id="${ids[0]}"]`);
  await sortable.focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('drag-preview')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('drag-preview')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__carbonE2e.inspect('SELECT title FROM items ORDER BY sort_order LIMIT 1')[0].title)).toBe('Reorder 0');
  const first = page.getByTestId('task-row').filter({ hasText: /^Reorder 0/ }).first();
  const second = page.getByTestId('task-row').filter({ hasText: /^Reorder 1$/ }).first();
  const a = await first.boundingBox(); const b = await second.boundingBox();
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(280);
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => page.evaluate(([one, two]) => {
    const rows = (window as any).__carbonE2e.inspect(`SELECT id FROM items WHERE id IN ('${one}', '${two}') ORDER BY sort_order`);
    return rows.map((r: any) => r.id);
  }, [ids[0], ids[1]])).toEqual([ids[1], ids[0]]);
  await first.click();
  await page.getByLabel('Move selected task to position').fill('250');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__carbonE2e.inspect('SELECT title FROM items ORDER BY sort_order DESC LIMIT 1')[0].title)).toBe('Reorder 0');
});
