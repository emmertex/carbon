import {
  projectAncestor,
  getItemTags,
  getItemTagsBatch,
  itemsWithChildren,
  itemsWithComments,
  listAssigneesForItems,
  listTags,
  listUsers,
  normalizeTagName,
  tagParentPath,
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
import { currentRevision } from '@/lib/dbRevision';
import type { TaskRowData } from '@/components/TaskRow';

/**
 * Workspace-level enrichment inputs that depend only on the DB revision, not on
 * which items are being enriched: the on-hold tag set and the tag colour resolver
 * (which otherwise re-marshals the whole tags table on every call). A single
 * mutation renders many enrichItems calls — every visible row's `planEntry` calls
 * it twice, Forecast once per day group — so caching these by revision turns N
 * `listTags` marshals per render into one.
 */
interface EnrichWorkspace {
  held: Set<string>;
  colorOf: (name: string) => string | null;
}
let wsCache: { rev: number; ws: EnrichWorkspace } | null = null;

function enrichWorkspace(db: Db): EnrichWorkspace {
  const rev = currentRevision();
  if (wsCache && wsCache.rev === rev) return wsCache.ws;
  const held = heldTagIds(db);
  // name→own-colour for every tag; resolve inherited colour by walking the path.
  const colorByPath = new Map<string, string | null>();
  for (const t of listTags(db)) colorByPath.set(normalizeTagName(t.name), t.color);
  const colorOf = (name: string): string | null => {
    let path = normalizeTagName(name);
    const seen = new Set<string>();
    while (path && !seen.has(path)) {
      seen.add(path);
      const c = colorByPath.get(path);
      if (c) return c;
      const parent = tagParentPath(path);
      if (parent === path) break;
      path = parent;
    }
    return null;
  };
  const ws: EnrichWorkspace = { held, colorOf };
  wsCache = { rev, ws };
  return ws;
}

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

/** Attach project + tag context to items for display. Batches the per-row lookups
 *  (tags, children, comments, assignees) into one query each, and skips the
 *  comment / assignee / share fan-out entirely when those tables have no live rows
 *  (the common single-user case) — so cost scales with the number of *distinct*
 *  reads, not with the row count. */
export function enrichItems(db: Db, items: Item[]): TaskRowData[] {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const { held, colorOf } = enrichWorkspace(db);
  const blockedCache = new Map<string, boolean>();
  const projectCache = new Map<string, Item | undefined>();

  // One query each for the whole set (empty set/map ⇒ nothing to fetch).
  const childrenSet = itemsWithChildren(db, ids);
  const commentsSet = itemsWithComments(db, ids);
  const tagsByItem = getItemTagsBatch(db, ids);
  const assigneesByItem = listAssigneesForItems(db, ids);
  // Shares are almost always absent (single-user); only walk ancestors per row
  // when at least one live share exists.
  const anyShares = !!db.get('SELECT 1 AS x FROM shares WHERE deleted = 0 LIMIT 1');
  // Remote (federation shadow) owners are rare; only build/keep a roster map when a
  // shadow user actually exists — the same cheap-guard pattern as `anyShares`.
  const anyRemote = !!db.get('SELECT 1 AS x FROM users WHERE is_remote = 1 AND deleted = 0 LIMIT 1');
  const userById =
    assigneesByItem.size || anyRemote
      ? new Map(listUsers(db).map((u) => [u.id, u] as const))
      : null;

  return items.map((item) => {
    // A task's project is the nearest project ancestor — `parent_id` may be
    // another task (a subtask), so resolve up the tree. Cache by the item's own
    // id since the walk is item-specific.
    let project: Item | undefined;
    if (item.parent_id) {
      if (!projectCache.has(item.id)) projectCache.set(item.id, projectAncestor(db, item.id));
      project = projectCache.get(item.id);
    }
    const tags = (tagsByItem.get(item.id) ?? []).map((t) => ({ ...t, color: colorOf(t.name) }));
    const assignees = userById
      ? (assigneesByItem.get(item.id) ?? [])
          .map((a) => userById.get(a.user_id))
          .filter((u): u is User => !!u && !u.deleted)
      : [];
    // A "from @host" badge for items owned by a remote peer's (shadow) user.
    const owner = anyRemote && item.owner_id ? userById?.get(item.owner_id) : undefined;
    const remoteOwner = owner?.is_remote ? owner.home_server : undefined;
    return {
      item,
      projectId: project?.id ?? null,
      projectName: project?.title ?? null,
      projectColor: project?.color ?? null,
      tags,
      assignees,
      hasChildren: childrenSet.has(item.id),
      hasComments: commentsSet.has(item.id),
      shared: anyShares ? effectiveShares(db, item.id).length > 0 : false,
      blocked: item.status === 'active' && isBlocked(db, item.id, blockedCache),
      // On hold = carries an on-hold tag (or a descendant of one). Drives the faded row.
      onHold: held.size > 0 && tags.some((t) => held.has(t.id)),
      remoteOwner,
    };
  });
}

/** Today's due date as an all-day due (local end-of-day sentinel). */
export function todayDueISO(): string {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}
