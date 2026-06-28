import type { Db } from '@carbon/core';
import { getDb, getDeviceId, schedulePersist } from './db';
import { useStore } from './store';
import { scheduleSync } from './sync';
import { perf } from './perf';

/**
 * Run a synchronous mutation against the DB, then persist (debounced), notify
 * React (bump revision), and schedule a background sync. This is the single
 * write path — no `await initDB()` scattered across call sites.
 *
 * `label` is purely for perf instrumentation (e.g. 'create', 'complete') so the
 * benchmark can tell mutation kinds apart; it has no runtime effect when perf is
 * disabled.
 */
export function mutate<T>(fn: (db: Db, deviceId: string) => T, label = 'mutate'): T {
  const db = getDb();
  const dev = getDeviceId();
  const result = perf.time('mutation', label, () => fn(db, dev));
  schedulePersist();
  perf.time('mutation', 'notify', () => useStore.getState().bump());
  scheduleSync();
  return result;
}
