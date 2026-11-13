import {
  buildChildrenIndex,
  subtaskProgress,
  type ChildrenIndex,
  type CountScope,
  type Db,
} from '@carbon/core';
import { currentRevision } from './dbRevision';

/**
 * Parent→children index of every live item, cached by DB revision.
 *
 * `subtaskProgress(..., 'all')` needs the whole parent→children map, and building
 * it scans the entire items table. Every visible row asks for its progress on
 * every mutation/sync bump, so without sharing, one interaction costs
 * O(visible rows × workspace size). One index per revision makes it O(workspace)
 * once, plus a small subtree walk per row. Same revision-keyed pattern as
 * enrich/listQuery.
 */
let cache: { db: Db; rev: number; index: ChildrenIndex } | null = null;

export function childrenIndex(db: Db): ChildrenIndex {
  const rev = currentRevision();
  if (cache && cache.db === db && cache.rev === rev) return cache.index;
  const index = buildChildrenIndex(db);
  cache = { db, rev, index };
  return index;
}

/** `subtaskProgress` backed by the revision-cached index. For render paths only —
 *  imperative guards that run between a write and its `bump()` should call
 *  `subtaskProgress` directly so they never see a stale index. */
export function cachedSubtaskProgress(
  db: Db,
  id: string,
  scope: CountScope,
): { done: number; total: number } {
  return scope === 'all'
    ? subtaskProgress(db, id, scope, childrenIndex(db))
    : subtaskProgress(db, id, scope);
}
