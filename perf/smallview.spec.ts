import { test } from '@playwright/test';
import {
  waitForApp,
  reset,
  seed,
  setTaskCount,
  perfClear,
  addTask,
  completeTask,
  collectSummary,
  collectMemory,
} from './scenario';

/**
 * "Big workspace, small view" probe.
 *
 * Answers: if the DB holds 10k tasks but the current screen only shows a handful
 * (e.g. Flagged), is the app still fast — or does the full-table rescan on every
 * mutation make it slow regardless of what's on screen?
 *
 * Seeds 10k plain tasks (none flagged), opens Flagged (≈0 rows), then adds/completes
 * a few flagged tasks so only ~10 render — and measures the per-mutation query,
 * render, and memory at that point.
 */
const DB_SIZE = parseInt(process.env.PERF_DB_SIZE ?? '10000', 10);
const VISIBLE_OPS = parseInt(process.env.PERF_VISIBLE_OPS ?? '10', 10);

test('big workspace, small view', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('carbon.perf', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await waitForApp(page);

  await reset(page);
  const live = await seed(page, DB_SIZE);
  await setTaskCount(page, live);

  // Flagged shows none of the (unflagged) seed — a small view over a big DB.
  await page.keyboard.press('g');
  await page.keyboard.press('f');
  await page.waitForURL('**/flagged');
  await page.waitForTimeout(500);
  await perfClear(page);

  // Add a handful of flagged tasks (they appear here) and complete a few.
  for (let i = 0; i < VISIBLE_OPS; i++) {
    await addTask(page, `Flagged probe ${i}`);
    if (i % 3 === 2) await completeTask(page, 0);
  }

  const buckets = await collectSummary(page);
  const memory = await collectMemory(page);

  const pick = (label: string) => buckets.find((b) => `${b.category}:${b.label}` === label);
  const q = pick('query:listview.roots');
  const r = pick('render:list');
  const fmt = (b?: { p50: number; p95: number; count: number }) =>
    b ? `p50 ${b.p50.toFixed(1)}ms  p95 ${b.p95.toFixed(1)}ms  (n=${b.count})` : '(no samples)';

  /* eslint-disable no-console */
  console.log(`\n=== Big workspace (${live} tasks), small view (~${VISIBLE_OPS} rows shown) ===`);
  console.log(`  query:listview.roots  ${fmt(q)}`);
  console.log(`  render:list           ${fmt(r)}`);
  console.log(
    `  memory: JS heap ${memory.jsHeapMB.toFixed(1)} MB | DOM nodes ${memory.domNodes} | rows ${memory.listRows}`,
  );
  console.log(
    '\n  Contrast: the same 10k DB rendered in full on /all was ~14,500ms query, ~7,300ms render, ~1,234 MB.',
  );
  /* eslint-enable no-console */
});
