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
/** Simulate a slower device by throttling the CPU (CDP). 1 = off (desktop speed);
 *  4–6× approximates a mid-range phone, matching how the app feels on Android. */
const CPU_THROTTLE = parseFloat(process.env.PERF_CPU_THROTTLE ?? '1');

test('carbon large-list performance benchmark', async ({ page }) => {
  // With representative (nested) data the completed row is often a parent with
  // open sub-tasks, which raises a "complete all sub-tasks?" confirm. Auto-accept
  // so the completion proceeds (and cascades) instead of Playwright's default
  // dismiss, which would stall the `complete` mutation the harness waits on.
  page.on('dialog', (d) => void d.accept().catch(() => {}));

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

  if (CPU_THROTTLE > 1) {
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    // eslint-disable-next-line no-console
    console.log(`CPU throttled ${CPU_THROTTLE}× to approximate a mobile device.`);
  }

  // Warm up JIT / WASM / IndexedDB / lazy Vite modules at a small size and discard
  // the result. Without this the *first* measured milestone eats all the one-time
  // cost (cold persist:idb alone was ~3 s), making small milestones look slower
  // than large ones and hiding the real scaling curve.
  // eslint-disable-next-line no-console
  console.log('\n--- Warmup (discarded) ---');
  await runMilestone(page, 150, 3);

  const started = Date.now();
  const results: MilestoneResult[] = [];
  for (const m of MILESTONES) {
    // eslint-disable-next-line no-console
    console.log(`\n--- Milestone: ${m} tasks (${CYCLES} cycles) ---`);
    results.push(await runMilestone(page, m, CYCLES));
  }
  const durationMs = Date.now() - started;

  const { md, json } = report(results, {
    cyclesPerMilestone: CYCLES,
    durationMs,
    cpuThrottle: CPU_THROTTLE,
  });
  const { mdPath, jsonPath } = writeReport(md, json);
  // eslint-disable-next-line no-console
  console.log(`\nReport written:\n  ${mdPath}\n  ${jsonPath}`);
});
