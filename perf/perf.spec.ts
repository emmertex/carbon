import { test } from '@playwright/test';
import { waitForApp } from './scenario';
import { runMilestone, type MilestoneResult } from './workload';
import { report, writeReport } from './report';

/**
 * Keyboard-driven performance benchmark.
 *
 * Grows the in-browser task list to each milestone (default 1,000 then 10,000)
 * via a bulk seed, then drives real keyboard interactions (switch screens, add,
 * complete, scroll) at that size while collecting in-app timing, and writes a
 * ranked report to perf/results/.
 *
 *   PERF_MILESTONES=1000,10000   list sizes to benchmark
 *   PERF_CYCLES=15               churn cycles per milestone (2 adds + 1 complete each)
 */
const MILESTONES = (process.env.PERF_MILESTONES ?? '1000,10000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => n > 0);
const CYCLES = parseInt(process.env.PERF_CYCLES ?? '15', 10);

test('carbon large-list performance benchmark', async ({ page }) => {
  // Enable perf instrumentation before any app code runs.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('carbon.perf', '1');
    } catch {
      /* ignore */
    }
  });

  await page.goto('/');
  await waitForApp(page);

  const started = Date.now();
  const results: MilestoneResult[] = [];
  for (const m of MILESTONES) {
    // eslint-disable-next-line no-console
    console.log(`\n--- Milestone: ${m} tasks (${CYCLES} cycles) ---`);
    results.push(await runMilestone(page, m, CYCLES));
  }
  const durationMs = Date.now() - started;

  const { md, json } = report(results, { cyclesPerMilestone: CYCLES, durationMs });
  const { mdPath, jsonPath } = writeReport(md, json);
  // eslint-disable-next-line no-console
  console.log(`\nReport written:\n  ${mdPath}\n  ${jsonPath}`);
});
