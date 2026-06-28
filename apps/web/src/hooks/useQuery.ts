import { useMemo } from 'react';
import type { Db } from '@carbon/core';
import { getDb } from '@/lib/db';
import { useStore } from '@/lib/store';
import { perf } from '@/lib/perf';

/**
 * Run a read against the DB and re-run it whenever the DB changes (the store's
 * `dbRevision` bumps after every mutation/sync). Replaces the old window-event
 * refresh bus.
 *
 * Pass an optional `perfLabel` to time this query under the perf 'query' bucket
 * (used by the benchmark for the expensive top-level list query). Unlabeled
 * queries — the per-row enrichment fan-out — stay silent so they don't flood the
 * sample buffer; their cost shows up in the `render:list` Profiler sample.
 */
export function useQuery<T>(
  fn: (db: Db) => T,
  deps: unknown[] = [],
  perfLabel?: string,
): T | null {
  const rev = useStore((s) => s.dbRevision);
  const ready = useStore((s) => s.ready);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!ready) return null;
    const db = getDb();
    return perfLabel ? perf.time('query', perfLabel, () => fn(db)) : fn(db);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rev, ...deps]);
}
