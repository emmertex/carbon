import { type Page } from '@playwright/test';
import {
  addTask,
  completeTask,
  switchScreen,
  openLargestContainer,
  scrollSweep,
  reset,
  seed,
  setTaskCount,
  perfClear,
  collectSummary,
  collectScrollStats,
  collectMemory,
  waitForApp,
  type PerfBucket,
  type ScrollStats,
  type MemStats,
} from './scenario';

export interface MilestoneResult {
  milestone: number;
  liveCount: number;
  cycles: number;
  buckets: PerfBucket[];
  scroll: ScrollStats;
  memory: MemStats;
}

async function lightScroll(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('PageDown');
}

/**
 * Grow the list to `milestone` via bulk seed, then run `cycles` of real
 * keyboard churn at that size and a scroll sweep, collecting timing.
 *
 * Each cycle honours "~2 UI actions per task" and "add 2 : complete 1":
 *   switch→today, switch→all, addTask, lightScroll, addTask, completeTask
 *   = 2 adds + 1 complete (3 task-touches), 6 UI actions ⇒ 2 actions/task.
 */
export async function runMilestone(
  page: Page,
  milestone: number,
  cycles: number,
): Promise<MilestoneResult> {
  // Make sure the app (and its perf globals) are present — guards against a
  // stray HMR reload between milestones.
  await waitForApp(page);

  // Clean baseline, then fast-forward to the milestone size.
  await reset(page);
  const liveCount = await seed(page, milestone);
  await setTaskCount(page, liveCount);

  // Land on the big list and wait for the initial (large) render to commit.
  await switchScreen(page, 'all');
  await page.waitForSelector('[data-tasklist]', { timeout: 60_000 });

  // Measure only the incremental ops at this size — drop the one-off mount render.
  await perfClear(page);

  let completed = 0;
  for (let c = 0; c < cycles; c++) {
    await switchScreen(page, 'today');
    await switchScreen(page, 'all');
    await addTask(page, `Perf ${milestone}-${c}-a`);
    await lightScroll(page);
    await addTask(page, `Perf ${milestone}-${c}-b`);
    await completeTask(page, completed++);
    if ((c + 1) % 5 === 0) {
      // eslint-disable-next-line no-console
      console.log(`    [${milestone}] cycle ${c + 1}/${cycles}`);
    }
  }

  // View tour: exercise the heavier non-list views a few times so their query
  // cost (forecast.data / container.data) is captured at this size — the list
  // views never touch the full-enrich path these use.
  for (let i = 0; i < 3; i++) {
    await switchScreen(page, 'forecast');
    await switchScreen(page, 'all');
    await openLargestContainer(page);
    await switchScreen(page, 'all');
  }

  // Dedicated scroll-jank + time-to-settle measurement at this size.
  await scrollSweep(page);

  // Let the final debounced persist (250ms) land so it's represented.
  await page.waitForTimeout(500);

  const buckets = await collectSummary(page);
  const scroll = await collectScrollStats(page);
  const memory = await collectMemory(page);
  return { milestone, liveCount, cycles, buckets, scroll, memory };
}
