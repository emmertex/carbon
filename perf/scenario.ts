import { expect, type Page } from '@playwright/test';

/**
 * Keyboard-only interaction primitives against the live Carbon UI, plus the perf
 * plumbing the harness needs (seed/reset, sample collection). Every primitive
 * waits for its effect to *settle* before returning so latency samples never
 * overlap.
 */

const GO_KEY: Record<string, string> = {
  today: 't',
  inbox: 'i',
  flagged: 'f',
  all: 'a',
  plan: 'p',
  forecast: 'o',
  review: 'r',
};

/** Wait until the app has booted with perf instrumentation + seed helpers. */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as any).__carbonPerf && !!(window as any).__carbonSeed,
    undefined,
    { timeout: 30_000 },
  );
}

export async function perfClear(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__carbonPerf.clear());
}

export async function setTaskCount(page: Page, n: number): Promise<void> {
  await page.evaluate((v) => (window as any).__carbonPerf.setTaskCount(v), n);
}

export async function reset(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as any).__carbonReset();
  });
}

/** Bulk-seed to grow the list. Returns the new live task count. */
export async function seed(page: Page, n: number): Promise<number> {
  return page.evaluate(async (v) => (window as any).__carbonSeed(v), n);
}

/** Count of mutation samples with a given label (used as a settle signal). */
async function mutationCount(page: Page, label: string): Promise<number> {
  return page.evaluate(
    (l) =>
      (window as any).__carbonPerf
        .flush()
        .filter((s: any) => s.c === 'mutation' && s.label === l).length,
    label,
  );
}

async function waitForMutation(page: Page, label: string, prev: number): Promise<void> {
  await page.waitForFunction(
    ([l, p]) =>
      (window as any).__carbonPerf
        .flush()
        .filter((s: any) => s.c === 'mutation' && s.label === l).length > (p as number),
    [label, prev] as [string, number],
    { timeout: 60_000 },
  );
}

/** Record an end-to-end interaction latency into the in-app buffer (tagged with
 *  the current task count automatically). */
async function recordInteraction(page: Page, label: string, durMs: number): Promise<void> {
  await page.evaluate(
    ([l, d]) => (window as any).__carbonPerf.record('interaction', l, d),
    [label, durMs] as [string, number],
  );
}

async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

/** Switch screen via the `g`-leader shortcut; settle on the URL change. */
export async function switchScreen(page: Page, screen: keyof typeof GO_KEY): Promise<void> {
  await blurActive(page);
  const t0 = Date.now();
  await page.keyboard.press('g');
  await page.keyboard.press(GO_KEY[screen]!);
  await page.waitForURL(`**/${screen}`, { timeout: 30_000 });
  await recordInteraction(page, 'switch', Date.now() - t0);
}

/** Focus the quick-add bar via `c`, type a title, commit with Enter; settle on
 *  the create mutation landing. */
export async function addTask(page: Page, title: string): Promise<void> {
  await blurActive(page);
  await page.keyboard.press('c');
  // The quick-add input should now hold focus.
  await page.waitForFunction(
    () => document.activeElement?.tagName === 'INPUT',
    undefined,
    { timeout: 10_000 },
  );
  await page.keyboard.type(title);
  const prev = await mutationCount(page, 'create');
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await waitForMutation(page, 'create', prev);
  await recordInteraction(page, 'add', Date.now() - t0);
}

/** Focus the list, walk down to a still-active row, toggle complete with Space;
 *  settle on the complete mutation landing. `depth` selects a fresh row each call
 *  so we complete distinct tasks rather than oscillating one. */
export async function completeTask(page: Page, depth: number): Promise<void> {
  await page.locator('[data-tasklist]').first().focus();
  for (let i = 0; i <= depth; i++) await page.keyboard.press('ArrowDown');
  const prev = await mutationCount(page, 'complete');
  const t0 = Date.now();
  await page.keyboard.press(' ');
  await waitForMutation(page, 'complete', prev);
  await recordInteraction(page, 'complete', Date.now() - t0);
}

/** A burst scroll (PageDown ×N) with a frame-time sampler running, then a
 *  jump-to-bottom (End) measuring time-to-settle. Records into the 'scroll'
 *  category. */
export async function scrollSweep(page: Page, presses = 20): Promise<void> {
  await blurActive(page);
  await page.evaluate(() => (window as any).__carbonPerf.startFrameSampler());
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(40);
  }
  await page.evaluate(() => (window as any).__carbonPerf.stopFrameSampler());

  // Time-to-settle after a jump to the bottom.
  await page.evaluate(() => document.querySelector('main')?.scrollTo({ top: 0 }));
  const settle = await page.evaluate(async () => {
    const main = document.querySelector('main');
    if (!main) return 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      let last = -1;
      let stable = 0;
      const tick = () => {
        const top = main.scrollTop;
        if (top === last) {
          if (++stable >= 2) return resolve();
        } else {
          stable = 0;
          last = top;
        }
        requestAnimationFrame(tick);
      };
      main.scrollTo({ top: main.scrollHeight });
      requestAnimationFrame(tick);
    });
    return performance.now() - start;
  });
  await page.evaluate((d) => (window as any).__carbonPerf.record('scroll', 'settle', d), settle);
}

export interface PerfBucket {
  category: string;
  label: string;
  n: number;
  count: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export async function collectSummary(page: Page): Promise<PerfBucket[]> {
  return page.evaluate(() => (window as any).__carbonPerf.summary());
}

export interface MemStats {
  /** JS heap actually in use after a forced GC (MB). */
  jsHeapMB: number;
  /** Total DOM nodes (CDP counter). */
  domNodes: number;
  /** Rendered task rows (`[data-row-id]`) — the unvirtualized row count. */
  listRows: number;
}

/** Snapshot JS heap + DOM size via CDP, after forcing a GC for an accurate heap. */
export async function collectMemory(page: Page): Promise<MemStats> {
  const client = await page.context().newCDPSession(page);
  let cdpHeap = 0;
  let cdpNodes = 0;
  try {
    // Both metrics require their domains enabled before getMetrics returns values.
    await client.send('Performance.enable');
    await client.send('HeapProfiler.enable');
    await client.send('HeapProfiler.collectGarbage'); // force GC for an accurate heap
    const { metrics } = await client.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value] as const));
    cdpHeap = m.JSHeapUsedSize ?? 0;
    cdpNodes = m.Nodes ?? 0;
  } catch {
    /* CDP metrics are best-effort; fall back to in-page values below */
  }
  const ev = await page.evaluate(() => ({
    heap: (performance as any).memory?.usedJSHeapSize ?? 0,
    domNodes: document.getElementsByTagName('*').length,
    listRows: document.querySelectorAll('[data-row-id]').length,
  }));
  await client.detach().catch(() => {});
  return {
    jsHeapMB: (cdpHeap || ev.heap) / (1024 * 1024),
    domNodes: cdpNodes || ev.domNodes,
    listRows: ev.listRows,
  };
}

export interface ScrollStats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  /** Frames slower than one 60fps budget (16.7ms) and a hard-jank threshold (50ms). */
  jank17: number;
  jank50: number;
  /** Time-to-settle after a jump to the bottom (End), ms. */
  settle: number;
}

/** Compute scroll frame-time stats from the raw buffer (jank counts need the raw
 *  samples, not the summarised percentiles). */
export async function collectScrollStats(page: Page): Promise<ScrollStats> {
  return page.evaluate(() => {
    const all = (window as any).__carbonPerf.flush();
    const frames = all
      .filter((s: any) => s.c === 'scroll' && s.label === 'frame')
      .map((s: any) => s.dur)
      .sort((a: number, b: number) => a - b);
    const settleSamples = all.filter((s: any) => s.c === 'scroll' && s.label === 'settle');
    const p = (q: number) =>
      frames.length ? frames[Math.min(frames.length - 1, Math.floor((q / 100) * frames.length))] : 0;
    return {
      frames: frames.length,
      p50: p(50),
      p95: p(95),
      max: frames.length ? frames[frames.length - 1] : 0,
      jank17: frames.filter((f: number) => f > 16.7).length,
      jank50: frames.filter((f: number) => f > 50).length,
      settle: settleSamples.length ? settleSamples[settleSamples.length - 1].dur : 0,
    };
  });
}
