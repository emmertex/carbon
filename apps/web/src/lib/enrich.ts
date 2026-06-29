import {
  projectAncestor,
  getItemTags,
  effectiveTagColor,
  heldTagIds,
  listAssigneesForItem,
  effectiveShares,
  getUser,
  isBlocked,
  type Db,
  type Item,
  type Tag,
  type User,
} from '@carbon/core';
import type { TaskRowData } from '@/components/TaskRow';

/** An item's tags with `color` resolved to the effective (inherited) colour. */
export function itemTagsResolved(db: Db, itemId: string): Tag[] {
  return getItemTags(db, itemId).map((t) => ({ ...t, color: effectiveTagColor(db, t.name) }));
}

/** Resolve an item's (non-deleted) assignees to user records. */
export function itemAssignees(db: Db, itemId: string): User[] {
  return listAssigneesForItem(db, itemId)
    .map((a) => getUser(db, a.user_id))
    .filter((u): u is User => !!u && !u.deleted);
}

/** Attach project + tag context to items for display. */
export function enrichItems(db: Db, items: Item[]): TaskRowData[] {
  const projectCache = new Map<string, Item | undefined>();
  const blockedCache = new Map<string, boolean>();
  const held = heldTagIds(db);
  return items.map((item) => {
    // A task's project is the nearest project ancestor — `parent_id` may be
    // another task (a subtask), so resolve up the tree rather than reading it
    // directly. Cache by the item's own id since the walk is item-specific.
    let project: Item | undefined;
    if (item.parent_id) {
      if (!projectCache.has(item.id)) {
        projectCache.set(item.id, projectAncestor(db, item.id));
      }
      project = projectCache.get(item.id);
    }
    const hasChildren = !!db.get('SELECT 1 AS x FROM items WHERE parent_id = ? AND deleted = 0', [
      item.id,
    ]);
    const hasComments = !!db.get('SELECT 1 AS x FROM comments WHERE item_id = ? AND deleted = 0', [
      item.id,
    ]);
    const tags = itemTagsResolved(db, item.id);
    return {
      item,
      projectId: project?.id ?? null,
      projectName: project?.title ?? null,
      projectColor: project?.color ?? null,
      tags,
      assignees: itemAssignees(db, item.id),
      hasChildren,
      hasComments,
      shared: effectiveShares(db, item.id).length > 0,
      blocked: item.status === 'active' && isBlocked(db, item.id, blockedCache),
      // On hold = carries an on-hold tag (or a descendant of one). Drives the faded row.
      onHold: held.size > 0 && tags.some((t) => held.has(t.id)),
    };
  });
}

/** Today's due date as an all-day due (local end-of-day sentinel). */
export function todayDueISO(): string {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}
