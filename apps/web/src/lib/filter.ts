import {
  getItem,
  getItemTags,
  getChildren,
  expandTagIds,
  onHoldTagIds,
  isBlocked,
  type Db,
  type Item,
} from '@carbon/core';
import type { Filters } from './views';
import { pendingHideIds } from './completion';

/** True if any ancestor of the item is a project. */
function hasProjectAncestor(db: Db, item: Item): boolean {
  let pid = item.parent_id;
  while (pid) {
    const p = getItem(db, pid);
    if (!p) return false;
    if (p.type === 'project') return true;
    pid = p.parent_id;
  }
  return false;
}

/** All descendant item ids under the given projects (for the Project filter). */
function projectDescendants(db: Db, projectIds: string[]): Set<string> {
  const set = new Set<string>();
  const queue = [...projectIds];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const c of getChildren(db, parent)) {
      if (!set.has(c.id)) {
        set.add(c.id);
        queue.push(c.id);
      }
    }
  }
  return set;
}

/** On-hold tags (and their descendants), expanded. A task carrying one is treated
 *  exactly like a deferred task — hidden by Today and by the "Hide deferred" toggle. */
export function heldTagIds(db: Db): Set<string> {
  return expandTagIds(db, [...onHoldTagIds(db)]);
}

/** Drop tasks carrying an on-hold tag — the intrinsic Today rule, mirroring how
 *  Today drops future-deferred tasks. */
export function excludeOnHold(db: Db, items: Item[]): Item[] {
  const held = heldTagIds(db);
  if (!held.size) return items;
  return items.filter((i) => !getItemTags(db, i.id).some((t) => held.has(t.id)));
}

/** Apply the full filter set. Db-aware (resolves tags / project membership). */
export function applyFilters(db: Db, items: Item[], f: Filters): Item[] {
  // Each tag set is expanded to include descendants, so selecting a parent tag
  // matches tasks carrying it or any tag nested beneath it.
  const anySet = f.tagAny.length ? expandTagIds(db, f.tagAny) : null;
  const noneSet = f.tagNone.length ? expandTagIds(db, f.tagNone) : null;
  // ALL is per-selected-tag: each chosen tag (or one of its descendants) must be present.
  const allSets = f.tagAll.length ? f.tagAll.map((id) => expandTagIds(db, [id])) : null;
  const needTags = anySet || noneSet || allSets || f.noTags;
  // When hiding deferred, an on-hold tag also makes a task "deferred".
  const heldSet = f.hideDeferred ? heldTagIds(db) : null;
  const projSet = f.projectIds.length ? projectDescendants(db, f.projectIds) : null;
  const now = Date.now();
  const held = pendingHideIds();
  // Shared across the pass so ancestor availability isn't recomputed per row.
  const blockedCache = f.hideBlocked ? new Map<string, boolean>() : null;

  return items.filter((i) => {
    let tagIds: string[] | null = null;
    const tagIdsOf = () => (tagIds ??= getItemTags(db, i.id).map((t) => t.id));

    if (!f.showCompleted && i.status !== 'active') {
      // Keep just-completed tasks visible during the global grace window so the
      // list doesn't shift while you're ticking several in a row.
      if (!held.has(i.id)) return false;
    }
    if (f.flaggedOnly && !i.flagged) return false;
    if (f.priorities.length && !f.priorities.includes(i.priority)) return false;

    const due = i.due_date ? i.due_date.slice(0, 10) : null;
    if (f.noDueDate && due) return false;
    if (f.dueAfter && (!due || due < f.dueAfter)) return false;
    if (f.dueBefore && (!due || due > f.dueBefore)) return false;

    if (f.hideDeferred) {
      const deferredFuture = i.defer_date && new Date(i.defer_date).getTime() > now;
      const onHold = heldSet && heldSet.size > 0 && tagIdsOf().some((id) => heldSet.has(id));
      if (deferredFuture || onHold) return false;
    }
    if (blockedCache && isBlocked(db, i.id, blockedCache)) return false;
    if (projSet && !projSet.has(i.id)) return false;
    if (f.noProject && hasProjectAncestor(db, i)) return false;

    if (needTags) {
      const ids = tagIdsOf();
      if (f.noTags && ids.length > 0) return false;
      if (anySet && !ids.some((id) => anySet.has(id))) return false;
      if (noneSet && ids.some((id) => noneSet.has(id))) return false;
      if (allSets && !allSets.every((set) => ids.some((id) => set.has(id)))) return false;
    }
    return true;
  });
}
