import { test, expect } from '../fixtures/client';
import { addTask } from '../helpers/scenario';
import type { Page } from '@playwright/test';

async function rows(page: Page) {
  return page.evaluate(() => (window as any).__carbonE2e.inspect(
    "SELECT id, parent_id, title FROM items WHERE title IN ('Drag A', 'Drag B', 'Drag C') AND deleted = 0 ORDER BY sort_order",
  )) as Promise<{ id: string; parent_id: string; title: string }[]>;
}

async function drag(page: Page, fromId: string, toId: string, dx = 0) {
  const from = (await page.locator(`[data-row-id="${fromId}"]`).boundingBox())!;
  const to = (await page.locator(`[data-row-id="${toId}"]`).boundingBox())!;
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  // Start moving immediately: desktop dragging must not require a timed hold.
  await page.mouse.move(x + 6, from.y + from.height / 2);
  await expect(page.getByTestId('tree-drop-indicator')).toBeVisible();
  await page.mouse.move(x + dx, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId('tree-drop-indicator')).toHaveCount(0);
}

test('tree drag reorders both ways, nests, promotes, and survives reload', async ({ page }) => {
  await page.getByRole('button', { name: 'New folder or project' }).click();
  await page.getByRole('button', { name: 'New Parallel Project', exact: true }).click();
  const title = page.getByTestId('task-detail').getByPlaceholder('Title');
  await title.fill('Drag project');
  await title.press('Enter');
  for (const name of ['Drag A', 'Drag B', 'Drag C']) await addTask(page, name);
  const initial = await rows(page);
  const [a, b, c] = initial;
  const root = a!.parent_id;
  await drag(page, c!.id, a!.id);
  await expect.poll(async () => (await rows(page)).map(r => r.title)).toEqual(['Drag C', 'Drag A', 'Drag B']);
  await drag(page, c!.id, b!.id);
  await expect.poll(async () => (await rows(page)).map(r => r.title)).toEqual(['Drag A', 'Drag B', 'Drag C']);
  await drag(page, b!.id, b!.id, 16);
  await expect.poll(async () => (await rows(page)).find(r => r.id === b!.id)?.parent_id).toBe(a!.id);
  await drag(page, b!.id, b!.id, -16);
  await expect.poll(async () => (await rows(page)).find(r => r.id === b!.id)?.parent_id).toBe(root);
  await expect.poll(async () => (await rows(page)).map(r => r.title)).toEqual(['Drag A', 'Drag B', 'Drag C']);
  // Nest again, collapse the parent, then drop another child into it.
  await drag(page, b!.id, b!.id, 16);
  await page.locator(`[data-row-id="${a!.id}"]`).getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(page.locator(`[data-row-id="${b!.id}"]`)).toHaveCount(0);
  await drag(page, c!.id, c!.id, 16);
  await expect.poll(async () => (await rows(page)).find(r => r.id === c!.id)?.parent_id).toBe(a!.id);
  await expect(page.locator(`[data-row-id="${b!.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-row-id="${c!.id}"]`)).toBeVisible();
  await page.evaluate(() => (window as any).__carbonFlushPersist?.());
  await page.reload();
  await expect(page.locator(`[data-row-id="${c!.id}"]`)).toBeVisible();
  await expect.poll(async () => (await rows(page)).find(r => r.id === c!.id)?.parent_id).toBe(a!.id);
});
