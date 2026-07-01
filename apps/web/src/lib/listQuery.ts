import { queryItems, getItem, type Db, type Item } from '@carbon/core';
import { baseFilter, applySort, type Base, type ViewPrefs } from './views';
import { excludeOnHold } from './filter';
import { filterByPrefs } from './filter-expr';

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
  // In advanced mode the expression may reference completed tasks, so don't let the
  // SQL prefilter drop them; the expression itself decides.
  const advanced = prefs.mode === 'advanced' && !!prefs.expr;
  const candidates = queryItems(db, {
    tasksOnly: true,
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
  const matchedIds = new Set(sorted.map((i) => i.id));
  return sorted.filter((i) => {
    let pid = i.parent_id;
    while (pid) {
      if (matchedIds.has(pid)) return false;
      pid = getItem(db, pid)?.parent_id ?? null;
    }
    return true;
  });
}
