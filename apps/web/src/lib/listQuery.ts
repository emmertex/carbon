import { queryItems, type Db, type Item } from '@carbon/core';
import { baseFilter, applySort, type Base, type ViewPrefs } from './views';
import { excludeOnHold } from './filter';
import { filterByPrefs } from './filter-expr';
import { currentRevision } from './dbRevision';

/**
 * Small revision-keyed cache of computed root lists. Rebuilding the ordered array
 * is a top per-mutation/switch cost, and the same (base, prefs) is queried
 * repeatedly at one revision — the view on mount/remount, plus the sidebar's
 * per-perspective count. Keying on `dbRevision` means an entry is only reused
 * while the data is unchanged; a mutation bumps the revision and misses. Bounded
 * so it can't grow unbounded across revisions.
 */
const rootsCache = new Map<string, Item[]>();
const ROOTS_CACHE_MAX = 24;

/**
 * The `id -> parent_id` map used for the ancestor-dedup pass below, cached by
 * revision alone (unlike `rootsCache`, it doesn't depend on `base`/`prefs` or the
 * minute bucket — it's pure `deleted=0` structure). Without this, switching
 * between views (Today -> Flagged -> a project) within the same revision paid
 * a full non-deleted-items scan on every switch even though nothing had changed.
 */
let parentOfCache: { rev: number; map: Map<string, string | null> } | null = null;

function ancestorMap(db: Db, rev: number): Map<string, string | null> {
  if (parentOfCache && parentOfCache.rev === rev) return parentOfCache.map;
  const map = new Map<string, string | null>();
  for (const r of db.all<{ id: string; parent_id: string | null }>(
    'SELECT id, parent_id FROM items WHERE deleted = 0',
  )) {
    map.set(r.id, r.parent_id);
  }
  parentOfCache = { rev, map };
  return map;
}

/**
 * The ordered list of top-level rows for a list view — but *without* enrichment.
 *
 * This is the cheap half of what `ListView` used to do inline: a SQL prefilter
 * (so a big workspace never materialises every row in JS), then the exact JS
 * base/filter/sort + roots-dedup. It deliberately stops before `planEntry`, so
 * per-row enrichment (tags, assignees, progress, blocked, leaf actions) happens
 * lazily — only for the rows actually rendered (see VirtualTaskList).
 *
 * The SQL prefilter is a superset of what the JS predicates keep, so semantics
 * are identical to the old full-scan path; it just hands the JS far fewer rows.
 */
export function queryRoots(db: Db, base: Base, prefs: ViewPrefs): Item[] {
  // Key on the revision *and* a coarse minute bucket: some predicates are
  // time-based (today cutoff, defer/due, completion grace), so an entry must
  // also expire with the clock, not just on the next mutation. A minute keeps
  // rapid switches hitting while bounding staleness.
  const rev = currentRevision();
  const minute = Math.floor(Date.now() / 60_000);
  const key = `${base} ${rev} ${minute} ${JSON.stringify(prefs)}`;
  const cached = rootsCache.get(key);
  if (cached) {
    // Bump recency (Map preserves insertion order, so re-insert = most-recent).
    rootsCache.delete(key);
    rootsCache.set(key, cached);
    return cached;
  }

  // In advanced mode the expression may reference completed tasks, so don't let the
  // SQL prefilter drop them; the expression itself decides.
  const advanced = prefs.mode === 'advanced' && !!prefs.expr;
  const candidates = queryItems(db, {
    tasksOnly: false,
    activeOnly: !advanced && !prefs.filters.showCompleted,
    flaggedOnly: base === 'flagged',
    rootOnly: base === 'inbox',
    dueOrFlagged: base === 'today',
  });

  const based = baseFilter(base, candidates);
  const visible = base === 'today' ? excludeOnHold(db, based) : based;
  const sorted = applySort(filterByPrefs(db, visible, prefs), prefs.sort);

  // Drop any match that already descends from another match — it would otherwise
  // show twice (once at top level, once nested under its ancestor's subtree).
  //
  // Resolve ancestry in memory: one 2-column scan builds a parent map, rather than
  // firing a getItem() per ancestor per row (that walk was a top scaling cost — it
  // grew with both list size and nesting depth on every mutation/switch).
  const matchedIds = new Set(sorted.map((i) => i.id));
  const parentOf = ancestorMap(db, rev);
  const roots = sorted.filter((i) => {
    let pid = i.parent_id;
    const seen = new Set<string>(); // guard against any parent cycle
    while (pid && !seen.has(pid)) {
      if (matchedIds.has(pid)) return false;
      seen.add(pid);
      pid = parentOf.get(pid) ?? null;
    }
    return true;
  });

  rootsCache.set(key, roots);
  if (rootsCache.size > ROOTS_CACHE_MAX) {
    const oldest = rootsCache.keys().next().value; // eldest insertion = least-recent
    if (oldest !== undefined) rootsCache.delete(oldest);
  }
  return roots;
}
