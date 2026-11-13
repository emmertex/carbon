import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { localQuery, replicaAvailable, replicaQuery } from '@/lib/replica';
import type {
  SidebarQueryArgs,
  SidebarQueryName,
  SidebarQueryResult,
} from '@/lib/sidebarQueries';
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

/**
 * Like {@link useQuery}, but recomputes against a *deferred* copy of the DB
 * revision. On a mutation the urgent re-render reuses the previous (memoized)
 * result — so the interaction commits immediately — and this query re-runs in a
 * low-priority background render that React can interrupt.
 *
 * Use it for expensive, non-interactive read-outs that don't need to update in the
 * same frame as the action (sidebar counts, badges, progress rings). It keeps that
 * aggregation off the tap's critical path; the numbers catch up a beat later.
 */
export function useDeferredQuery<T>(
  fn: (db: Db) => T,
  deps: unknown[] = [],
  perfLabel?: string,
): T | null {
  const rev = useStore((s) => s.dbRevision);
  const ready = useStore((s) => s.ready);
  const deferredRev = useDeferredValue(rev);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!ready) return null;
    const db = getDb();
    return perfLabel ? perf.time('query', perfLabel, () => fn(db)) : fn(db);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, deferredRev, ...deps]);
}

/**
 * A sidebar read-out (lib/sidebarQueries.ts) computed in the read-replica worker,
 * so its cost never blocks input (docs/internal/worker-db-plan.md, phase 2).
 *
 * The first value is computed synchronously on the main thread (no empty sidebar
 * on first paint). After that, every DB revision (or `deps` change) posts the
 * query to the replica and keeps showing the previous value until the answer
 * arrives; answers for superseded requests are dropped. If the replica is
 * unavailable the query runs on the main thread instead, as before.
 */
export function useReplicaQuery<N extends SidebarQueryName>(
  name: N,
  args: SidebarQueryArgs<N>,
  deps: unknown[] = [],
): SidebarQueryResult<N> | null {
  const rev = useStore((s) => s.dbRevision);
  const ready = useStore((s) => s.ready);
  const [state, setState] = useState<{ value: SidebarQueryResult<N> } | null>(null);
  const latest = useRef(0);
  // First paint: compute inline, exactly like useQuery did.
  const initial = useMemo(
    () => (ready && !state ? { value: localQuery(name, args) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready],
  );
  useEffect(() => {
    if (!ready) return;
    const ticket = ++latest.current;
    let cancelled = false;
    const local = () => {
      if (cancelled || ticket !== latest.current) return;
      setState({ value: perf.time('query', `local:${name}`, () => localQuery(name, args)) });
    };
    if (!replicaAvailable()) {
      local();
      return () => {
        cancelled = true;
      };
    }
    replicaQuery(name, args).then(
      ({ value }) => {
        if (!cancelled && ticket === latest.current) setState({ value });
      },
      local,
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rev, ...deps]);
  return (state ?? initial)?.value ?? null;
}
