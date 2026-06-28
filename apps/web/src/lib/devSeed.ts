/**
 * Dev-only bulk-seed helpers for the performance benchmark.
 *
 * Typing 10,000 tasks through the UI takes tens of minutes, so the benchmark
 * "fast-forwards" the list to a milestone size with a single batched insert and
 * then performs its *measured* add/complete/scroll/switch actions as real
 * keystrokes at that size. These helpers only change the list size cheaply — they
 * are never part of what the benchmark measures.
 *
 * Registered from main.tsx in dev builds only, after the DB is initialised.
 */
import { createItem } from '@carbon/core';
import { getDb, getDeviceId, flushPersist } from './db';
import { useStore, getCurrentUserId } from './store';
import { perf } from './perf';

function liveCount(): number {
  const row = getDb().get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM items WHERE deleted = 0',
  );
  return row?.c ?? 0;
}

/**
 * Insert `n` plain top-level tasks in one transaction (one persist + one React
 * bump for the whole batch). Returns the new live task count.
 */
async function seed(n: number): Promise<number> {
  const db = getDb();
  const dev = getDeviceId();
  const ownerId = getCurrentUserId();
  // Pin sort_order explicitly so createItem skips its per-row MAX(sort_order)
  // lookup — that lookup alone would make seeding O(n²) on a growing table.
  const base =
    (db.get<{ m: number | null }>(
      'SELECT MAX(sort_order) AS m FROM items WHERE parent_id IS NULL',
    )?.m ?? 0) + 1;

  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      createItem(db, dev, {
        title: `Seed task ${base + i}`,
        ownerId,
        sortOrder: base + i,
      });
    }
  });

  useStore.getState().bump();
  await flushPersist();
  const total = liveCount();
  perf.setTaskCount(total);
  return total;
}

/** Hard-wipe all task data so the next milestone starts from a clean, genuinely
 *  small table (raw DELETE, not the CRDT soft-delete — this is a dev reset). */
async function reset(): Promise<void> {
  const db = getDb();
  db.transaction(() => {
    db.run('DELETE FROM items');
    db.run('DELETE FROM ops');
  });
  useStore.getState().bump();
  await flushPersist();
  perf.setTaskCount(liveCount());
}

export function registerDevSeed(): void {
  if (typeof window === 'undefined') return;
  window.__carbonSeed = seed;
  window.__carbonReset = reset;
  window.__carbonFlushPersist = flushPersist;
  perf.setTaskCount(liveCount());
}
