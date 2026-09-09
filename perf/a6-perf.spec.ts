import { test } from '@playwright/test';
import { waitForApp } from './scenario';
import {
  addTask,
  completeTask,
  switchScreen,
  scrollSweep,
  perfClear,
  setTaskCount,
  collectSummary,
  collectMemory,
  seedLargeWorkspace,
  reset,
} from './scenario';
import { writeReport } from './report';

/**
 * A6: Large workspace performance benchmark.
 *
 * Seeds the normal target (10k active + 90k historical) and measures:
 * - Time-to-first-edit (add a task)
 * - Edit settle (complete a task)
 * - View switch
 * - DOM node count
 * - JS heap
 */
const ACTIVE = 10_000;
const HISTORICAL = 90_000;

test('A6 large workspace performance (10k active + 90k historical)', async ({ page }) => {
  page.on('dialog', (d) => void d.accept().catch(() => {}));

  await page.addInitScript(() => {
    try {
      localStorage.setItem('carbon.perf', '1');
    } catch {
      /* ignore */
    }
  });

  await page.goto('/');
  await waitForApp(page);

  // Seed the large workspace
  console.log('Seeding large workspace (10k active + 90k historical)...');
  const start = Date.now();
  const counts = await seedLargeWorkspace(page, ACTIVE, HISTORICAL);
  const seedTime = Date.now() - start;
  console.log(`Seeded: ${counts.active} active, ${counts.historical} historical in ${seedTime}ms`);

  // Wait for the initial render to settle
  await page.waitForSelector('[data-tasklist]', { timeout: 120_000 });
  await page.waitForTimeout(1000);

  // Measure baseline metrics
  const baselineMem = await collectMemory(page);
  console.log('Baseline memory:', baselineMem);

  // Clear perf samples before the benchmark actions
  await perfClear(page);

  // Benchmark: add a task
  console.log('Benchmark: add task');
  const addStart = Date.now();
  await addTask(page, 'A6 benchmark task');
  const addTime = Date.now() - addStart;
  console.log(`Add task: ${addTime}ms`);

  // Benchmark: complete a task
  console.log('Benchmark: complete task');
  const completeStart = Date.now();
  await completeTask(page, 0);
  const completeTime = Date.now() - completeStart;
  console.log(`Complete task: ${completeTime}ms`);

  // Benchmark: view switch
  console.log('Benchmark: view switch');
  const switchStart = Date.now();
  await switchScreen(page, 'today');
  const switchTime = Date.now() - switchStart;
  console.log(`View switch: ${switchTime}ms`);

  // Switch back
  await switchScreen(page, 'all');

  // Benchmark: scroll
  console.log('Benchmark: scroll sweep');
  const scrollStart = Date.now();
  await scrollSweep(page, 10);
  const scrollTime = Date.now() - scrollStart;
  console.log(`Scroll sweep: ${scrollTime}ms`);

  // Final metrics
  const finalMem = await collectMemory(page);
  console.log('Final memory:', finalMem);

  // Collect all perf samples
  const buckets = await collectSummary(page);

  // Write results to a report file
  const results = {
    timestamp: new Date().toISOString(),
    scenario: '10k active + 90k historical',
    seed: {
      active: counts.active,
      historical: counts.historical,
      seedTimeMs: seedTime,
    },
    interactions: {
      addTaskMs: addTime,
      completeTaskMs: completeTime,
      viewSwitchMs: switchTime,
      scrollSweepMs: scrollTime,
    },
    memory: {
      baseline: baselineMem,
      final: finalMem,
    },
    buckets: buckets,
  };

  const json = JSON.stringify(results, null, 2);
  const md = `# A6 Performance Report

Date: ${new Date().toISOString()}
Scenario: 10k active + 90k historical

## Seed
- Active: ${counts.active}
- Historical: ${counts.historical}
- Seed time: ${seedTime}ms

## Interaction Latencies
- Add task: ${addTime}ms (target: < 200ms visible, < 1s settle)
- Complete task: ${completeTime}ms (target: < 200ms visible, < 1s settle)
- View switch: ${switchTime}ms (target: < 1s)
- Scroll sweep (10 pages): ${scrollTime}ms

## Memory
- Baseline heap: ${baselineMem.jsHeapMB.toFixed(1)} MB
- Final heap: ${finalMem.jsHeapMB.toFixed(1)} MB
- Baseline DOM nodes: ${baselineMem.domNodes}
- Final DOM nodes: ${finalMem.domNodes}
- List rows rendered: ${finalMem.listRows}

## Perf Buckets
${buckets.map(b => `- ${b.category}.${b.label} (n=${b.n}): mean=${b.mean.toFixed(1)}ms, p50=${b.p50.toFixed(1)}ms, p95=${b.p95.toFixed(1)}ms, max=${b.max.toFixed(1)}ms`).join('\n')}
`;

  const { mdPath, jsonPath } = writeReport(md, json);
  console.log(`\nReport written: ${mdPath} / ${jsonPath}`);
});
