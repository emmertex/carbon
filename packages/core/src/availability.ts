// Availability / blocking model.
//
// A task is "blocked" (not yet available to act on) when any of:
//   - sequential gating: its parent container is order_mode 'sequential' and an
//     *earlier* sibling is still active (not done/dropped);
//   - explicit dependency: one of its predecessors (a pred->this edge) is active;
//   - ancestor cascade: its parent is itself blocked, so the whole subtree waits.
//
// `done` and `dropped` both count as "satisfied" (non-blocking). 'parallel' and
// 'single' containers never sequential-gate.

import {
  getItem,
  getChildren,
  getPredecessors,
  getItemTags,
  onHoldTagIds,
  expandTagIds,
} from './repo';
import type { Db } from './db';
import type { Item } from './types';

/**
 * Whether `itemId` is currently blocked. Pass a shared `cache` across a batch
 * (e.g. one render/filter pass) to avoid recomputing ancestors repeatedly.
 */
export function isBlocked(db: Db, itemId: string, cache: Map<string, boolean> = new Map()): boolean {
  const cached = cache.get(itemId);
  if (cached !== undefined) return cached;
  // Tentatively mark false to break any accidental recursion before we resolve.
  cache.set(itemId, false);

  const result = compute(db, itemId, cache);
  cache.set(itemId, result);
  return result;
}

/**
 * Per-batch memo of each sequential parent's first *active* child, keyed off the
 * batch's `cache` map so it shares its lifetime. An active child is
 * sequential-blocked iff it isn't that first active child — computing it once
 * per parent turns a batch isBlocked pass from O(N²) (one getChildren scan per
 * sibling) into O(N).
 */
const seqFirstActive = new WeakMap<Map<string, boolean>, Map<string, string | null>>();

function firstActiveChildId(db: Db, parentId: string, cache: Map<string, boolean>): string | null {
  let memo = seqFirstActive.get(cache);
  if (!memo) {
    memo = new Map();
    seqFirstActive.set(cache, memo);
  }
  let first = memo.get(parentId);
  if (first === undefined) {
    first = getChildren(db, parentId).find((c) => c.status === 'active')?.id ?? null;
    memo.set(parentId, first);
  }
  return first;
}

function compute(db: Db, itemId: string, cache: Map<string, boolean>): boolean {
  const item = getItem(db, itemId);
  if (!item || item.status !== 'active') return false;

  if (item.parent_id) {
    const parent = getItem(db, item.parent_id);
    if (parent) {
      // Ancestor cascade: a blocked container blocks everything beneath it.
      if (isBlocked(db, parent.id, cache)) return true;
      // Sequential gating: any earlier sibling still active blocks this one.
      // `item` is active (guard above), so an earlier active sibling exists
      // exactly when the parent's first active child is someone else.
      if (parent.order_mode === 'sequential') {
        const first = firstActiveChildId(db, parent.id, cache);
        if (first !== null && first !== item.id) return true;
      }
    }
  }

  // Explicit predecessors.
  if (getPredecessors(db, itemId).some((p) => p.status === 'active')) return true;

  return false;
}

/**
 * Whether `item` is currently deferred — hidden from "available" lists. True when
 * its `defer_date` is in the future, or it carries an on-hold tag. Mirrors the
 * "deferred" rule the Today perspective and "Hide deferred" toggle apply.
 *
 * Pass a `heldTags` set (the expanded on-hold tag ids) across a batch to avoid
 * recomputing it per item.
 */
export function isDeferred(
  db: Db,
  item: Item,
  now: number = Date.now(),
  heldTags?: Set<string>,
): boolean {
  if (item.defer_date && new Date(item.defer_date).getTime() > now) return true;
  const held = heldTags ?? expandTagIds(db, [...onHoldTagIds(db)]);
  if (held.size === 0) return false;
  return getItemTags(db, item.id).some((t) => held.has(t.id));
}

/**
 * Ordered leaf actions under `parentId` that are available to work on right now:
 * active, not blocked, and not deferred. A "leaf" is a task with no active task
 * children. Depth-first in `sort_order`, so the first element is the next action.
 *
 * Because availability defers to {@link isBlocked} — which already encodes
 * sequential gating, dependency edges, and ancestor cascade — nested containers
 * gate themselves: a sequential sub-project inside a parallel parent only exposes
 * its own next action. Callers take all leaves (parallel/single) or just the
 * first (sequential).
 */
export function availableLeaves(db: Db, parentId: string): Item[] {
  const now = Date.now();
  const heldTags = expandTagIds(db, [...onHoldTagIds(db)]);
  const blockedCache = new Map<string, boolean>();
  const out: Item[] = [];

  const walk = (id: string): void => {
    for (const child of getChildren(db, id)) {
      if (child.type !== 'task' || child.status !== 'active') continue;
      const taskKids = getChildren(db, child.id).filter(
        (k) => k.type === 'task' && k.status === 'active',
      );
      if (taskKids.length === 0) {
        // Leaf action — include when available.
        if (!isBlocked(db, child.id, blockedCache) && !isDeferred(db, child, now, heldTags)) {
          out.push(child);
        }
      } else {
        walk(child.id);
      }
    }
  };

  walk(parentId);
  return out;
}
