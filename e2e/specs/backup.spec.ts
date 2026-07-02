import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect } from '../fixtures/client';
import { addTask } from '../helpers/scenario';
import { waitForApp, flushClientDb } from '../helpers/app';

test.describe('Tier 4 — export and import', () => {
  test('export then import round-trips a task', async ({ page }) => {
    const title = `Backup task ${Date.now()}`;
    await addTask(page, title);
    await flushClientDb(page);

    await page.goto('/settings');
    await expect(page.getByTestId('settings-backup')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export backup' }).click();
    const download = await downloadPromise;
    const dir = mkdtempSync(join(tmpdir(), 'carbon-e2e-'));
    const backupPath = join(dir, 'backup.json');
    await download.saveAs(backupPath);

    const raw = readFileSync(backupPath, 'utf8');
    const bundle = JSON.parse(raw) as { format: string; version: number; db: string };
    expect(bundle.format).toBe('carbon-backup');
    expect(bundle.version).toBe(1);
    expect(bundle.db.length).toBeGreaterThan(100);

    const backupInfo = await page.evaluate(async (json) => {
      return (
        window as unknown as {
          __carbonE2e: {
            inspectBackupJson: (j: string) => Promise<{ opTitles: string[]; opCount: number }>;
          };
        }
      ).__carbonE2e.inspectBackupJson(json);
    }, raw);
    expect(backupInfo.opCount).toBeGreaterThan(0);
    expect(backupInfo.opTitles.some((t) => t.includes('Backup task'))).toBe(true);

    await page.evaluate(async () => {
      await (window as unknown as { __carbonReset?: () => Promise<void> }).__carbonReset?.();
    });
    await page.goto('/all');
    await expect(page.getByTestId('task-row').filter({ hasText: title })).toHaveCount(0);

    await page.goto('/settings');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Import backup' }).click(),
    ]);

    const reload = page.waitForEvent('load');
    await fileChooser.setFiles(backupPath);

    const modalImport = page.getByRole('button', { name: 'Import', exact: true });
    if (await modalImport.isVisible({ timeout: 5000 }).catch(() => false)) {
      const modalReload = page.waitForEvent('load');
      await modalImport.click();
      await modalReload;
    } else {
      await reload;
    }

    await waitForApp(page);
    await flushClientDb(page);
    await page.goto('/all');
    await expect(page.getByTestId('task-row').filter({ hasText: title })).toBeVisible({
      timeout: 30_000,
    });
  });
});
