/**
 * In-process performance benchmarks. Seeded at N=100, 300, 1000 tasks so regressions
 * (e.g. O(N²) queries) surface as hard failures rather than noise. Soft thresholds
 * print a summary table; the only hard assertion is that N=100 finishes within 500ms
 * per operation — a generous ceiling that would only fire on a real regression.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  createItem,
  allItems,
  inbox,
  today,
  flagged,
  isBlocked,
  ingestOps,
  type Op,
} from './index';
import { openMemoryDb } from './test-helpers';

const MILESTONES = [100, 300, 1000];
// N=100 hard cap: any single operation taking > 500ms is a blocking regression.
const HARD_CAP_MS = 500;

// ─── seeding helpers ─────────────────────────────────────────────────────────

function seedTasks(n: number) {
  const db = openMemoryDb();
  const dev = 'bench-device';
  const project = createItem(db, dev, { type: 'project', title: 'Bench Project' });
  for (let i = 0; i < n; i++) {
    const dueOffset = i % 3 === 0 ? -1 : i % 3 === 1 ? 0 : 7; // past / today / future
    const due = new Date();
    due.setDate(due.getDate() + dueOffset);
    due.setHours(12, 0, 0, 0);
    createItem(db, dev, {
      type: 'task',
      title: `Task ${i}`,
      parentId: project.id,
      flagged: i % 7 === 0,
      dueDate: i % 5 !== 0 ? due.toISOString() : null,
    });
  }
  return { db, dev };
}

function seedInboxTasks(n: number) {
  const db = openMemoryDb();
  const dev = 'bench-device';
  for (let i = 0; i < n; i++) {
    createItem(db, dev, { type: 'task', title: `Inbox ${i}` });
  }
  return { db, dev };
}

// ─── timing helper ───────────────────────────────────────────────────────────

interface BenchResult {
  n: number;
  label: string;
  ms: number;
}

/**
 * Best-of-`runs` timing. A single cold run gates CI on whatever the shared
 * runner's scheduler happened to do that instant; the minimum of a few runs is
 * stable while still catching real complexity regressions. `setup` re-creates
 * any state a repeat run would otherwise skip (fresh DB for ingest, fresh
 * cache for isBlocked) — it runs outside the timed window.
 */
function bench<T = undefined>(
  label: string,
  fn: (ctx: T) => void,
  opts: { runs?: number; setup?: () => T } = {},
): number {
  const runs = opts.runs ?? 1;
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const ctx = opts.setup?.() as T;
    const start = performance.now();
    fn(ctx);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

// ─── benchmark suites ────────────────────────────────────────────────────────

describe('perspective query benchmarks', () => {
  const results: BenchResult[] = [];

  for (const n of MILESTONES) {
    test(`inbox at N=${n}`, () => {
      const { db } = seedInboxTasks(n);
      const ms = bench('inbox', () => inbox(allItems(db)), { runs: n === 100 ? 3 : 1 });
      results.push({ n, label: 'inbox', ms });
      if (n === 100) assert.ok(ms < HARD_CAP_MS, `inbox at N=100 took ${ms.toFixed(1)}ms > ${HARD_CAP_MS}ms`);
    });

    test(`today at N=${n}`, () => {
      const { db } = seedTasks(n);
      const now = new Date();
      const ms = bench('today', () => today(allItems(db), now), { runs: n === 100 ? 3 : 1 });
      results.push({ n, label: 'today', ms });
      if (n === 100) assert.ok(ms < HARD_CAP_MS, `today at N=100 took ${ms.toFixed(1)}ms > ${HARD_CAP_MS}ms`);
    });

    test(`flagged at N=${n}`, () => {
      const { db } = seedTasks(n);
      const ms = bench('flagged', () => flagged(allItems(db)), { runs: n === 100 ? 3 : 1 });
      results.push({ n, label: 'flagged', ms });
      if (n === 100) assert.ok(ms < HARD_CAP_MS, `flagged at N=100 took ${ms.toFixed(1)}ms > ${HARD_CAP_MS}ms`);
    });
  }

  test('print summary table', () => {
    if (results.length === 0) return; // run in isolation
    // Emit a GitHub Step Summary–compatible table
    const rows: string[] = ['| Benchmark | N=100 | N=300 | N=1000 |', '|-----------|------:|------:|-------:|'];
    const labels = [...new Set(results.map((r) => r.label))];
    for (const label of labels) {
      const row = MILESTONES.map((n) => {
        const r = results.find((x) => x.label === label && x.n === n);
        return r ? `${r.ms.toFixed(1)}ms` : '—';
      });
      rows.push(`| ${label} | ${row.join(' | ')} |`);
    }
    console.log('\n## Perspective Benchmark Results\n');
    console.log(rows.join('\n'));
  });
});

describe('CRDT merge benchmarks', () => {
  for (const n of MILESTONES) {
    test(`ingest ${n} ops from 2 devices`, () => {
      const now = Date.now();
      const ops: Op[] = [];
      for (let i = 0; i < n; i++) {
        const itemId = `item-${i}`;
        ops.push({
          id: `op-a-${i}`,
          item_id: itemId,
          ts: now + i,
          device_id: 'device-a',
          fields: { type: 'task', title: `Task from A ${i}` },
        });
        ops.push({
          id: `op-b-${i}`,
          item_id: itemId,
          ts: now + i + 1,
          device_id: 'device-b',
          fields: { title: `Task from B ${i}` },
        });
      }
      // Fresh DB per run — re-ingesting into the same DB would time the
      // dedup path, not the merge.
      const ms = bench('crdt-merge', (db) => ingestOps(db, ops, false), {
        runs: n === 100 ? 3 : 1,
        setup: () => openMemoryDb(),
      });
      if (n === 100) assert.ok(ms < HARD_CAP_MS, `crdt-merge at N=100 took ${ms.toFixed(1)}ms`);
      console.log(`  crdt-merge N=${n}: ${ms.toFixed(1)}ms`);
    });
  }
});

describe('availability / blocked check benchmarks', () => {
  for (const n of MILESTONES) {
    test(`isBlocked on ${n} tasks (sequential project)`, () => {
      const db = openMemoryDb();
      const dev = 'bench';
      const project = createItem(db, dev, { type: 'project', title: 'Seq', orderMode: 'sequential' });
      for (let i = 0; i < n; i++) {
        createItem(db, dev, { type: 'task', title: `T${i}`, parentId: project.id });
      }
      const items = allItems(db).filter((i) => i.type === 'task');
      // Fresh cache per run — a warm cache would make repeat runs ~free.
      const ms = bench(
        'isBlocked',
        (cache) => {
          for (const item of items) isBlocked(db, item.id, cache);
        },
        { runs: n === 100 ? 3 : 1, setup: () => new Map<string, boolean>() },
      );
      if (n === 100) assert.ok(ms < HARD_CAP_MS, `isBlocked at N=100 took ${ms.toFixed(1)}ms`);
      console.log(`  isBlocked N=${n}: ${ms.toFixed(1)}ms`);
    });
  }
});

describe('memory footprint', () => {
  for (const n of MILESTONES) {
    test(`memory delta for ${n} tasks`, () => {
      const before = process.memoryUsage().heapUsed;
      const { db } = seedTasks(n);
      allItems(db); // materialise into JS objects
      const after = process.memoryUsage().heapUsed;
      const deltaMb = (after - before) / 1024 / 1024;
      console.log(`  heap delta N=${n}: ${deltaMb.toFixed(2)} MB`);
      // No hard cap — just observability. Values tracked over time for regression detection.
      assert.ok(deltaMb < 512, `heap delta for N=${n} exceeded 512 MB`);
    });
  }
});
