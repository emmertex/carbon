import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_INIT_SCRIPT } from '../helpers/reset';

test('demo backup restores its items and embedded images in a fresh workspace', async ({ page }) => {
  test.skip(process.env.CARBON_VERIFY_DEMO !== '1', 'Explicit demo verification only');
  await page.addInitScript(E2E_INIT_SCRIPT);
  await page.route('**/api/health', route => route.fulfill({ json: { role: 'single', status: 'ok' } }));
  await page.goto('/local');
  await page.waitForFunction(() => (window as any).__carbonE2e?.ready);
  const raw = readFileSync('output/play-store/demo/carbon-demo-backup.json', 'utf8');
  const result = await page.evaluate(async (raw) => {
    const { inspectBackup, applyImport } = await import('/src/lib/backup.ts');
    const parsed = await inspectBackup(new File([raw], 'demo.json', { type: 'application/json' }));
    await applyImport(parsed, {});
    const { getDb } = await import('/src/lib/db.ts');
    const { parseServes, splitRecipe } = await import('/src/lib/recipe.ts');
    const db = getDb();
    const note = db.get("SELECT id, note FROM items WHERE title = 'A weekend by the coast'");
    const recipe = db.get("SELECT id, note FROM items WHERE title = 'Lemon & tomato orzo'");
    return { count: db.get('SELECT count(*) AS n FROM items WHERE deleted = 0').n,
      blobs: Object.keys(parsed.blobs).length, note: note.id, recipe: recipe.id,
      servings: parseServes(splitRecipe(recipe.note).body)?.value };
  }, raw);
  expect(result.count).toBe(45);
  expect(result.blobs).toBeGreaterThanOrEqual(2);
  expect(result.servings).toBe(4);
  for (const id of [result.note, result.recipe]) {
    await page.goto(`/note/${id}`);
    await expect(page.locator('main img').first()).toBeVisible();
    await page.waitForFunction(() => [...document.querySelectorAll('main img')].every((i: any) => i.complete && i.naturalWidth > 0));
  }
});
