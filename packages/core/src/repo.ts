import { v4 as uuidv4 } from 'uuid';
import type { Db, Row } from './db';
import type {
  Item,
  ItemPatch,
  ItemType,
  OrderMode,
  ItemDep,
  Tag,
  TagStatus,
  ItemTag,
  TimeLog,
  User,
  UserRole,
  Share,
  Assignee,
  Comment,
  Attachment,
  AttachmentParent,
  Plan,
  Permission,
} from './types';
import { recordOp, createPatch, nextTs, observeTs, causalNowIso } from './crdt';
import { nextDueDate } from './recurrence';
import {
  insertRecordOp,
  recordOpExists,
  type RecordOp,
} from './records';

// ----- users ----------------------------------------------------------------

const AVATAR_COLORS = [
  '#ef4444', '#f59e0b', '#10b981', '#06b6d4', '#6366f1', '#a855f7', '#ec4899', '#84cc16',
];

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

interface UserRow extends Row {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  is_bot: number;
  avatar_color: string | null;
  avatar_initial: string | null;
  plan_startup_min: number | null;
  plan_default_estimate_min: number | null;
  is_remote: number;
  home_server: string | null;
  created_at: string;
  updated_at: string;
  deleted: number;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    role: r.role as UserRole,
    is_bot: !!r.is_bot,
    avatar_color: r.avatar_color,
    avatar_initial: r.avatar_initial ?? null,
    plan_startup_min: r.plan_startup_min ?? null,
    plan_default_estimate_min: r.plan_default_estimate_min ?? null,
    is_remote: !!r.is_remote,
    home_server: r.home_server ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: !!r.deleted,
  };
}

export function listUsers(db: Db): User[] {
  return db
    .all<UserRow>('SELECT * FROM users WHERE deleted = 0 ORDER BY username')
    .map(rowToUser);
}

export function getUser(db: Db, id: string): User | undefined {
  const r = db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  return r ? rowToUser(r) : undefined;
}

export function getUserByUsername(db: Db, username: string): User | undefined {
  const r = db.get<UserRow>('SELECT * FROM users WHERE username = ? AND deleted = 0', [username]);
  return r ? rowToUser(r) : undefined;
}

export interface CreateUserInput {
  username: string;
  displayName?: string | null;
  role?: UserRole;
  isBot?: boolean;
}

export function createUser(db: Db, input: CreateUserInput): User {
  const now = new Date().toISOString();
  const username = input.username.trim();
  // Usernames are unique. If a row already exists (e.g. a previously soft-deleted
  // user/agent), revive it in place rather than inserting a duplicate (which would
  // violate the UNIQUE(username) constraint).
  const existing = db.get<UserRow>('SELECT * FROM users WHERE username = ?', [username]);
  const user: User = {
    id: existing?.id ?? uuidv4(),
    username,
    display_name: input.displayName ?? existing?.display_name ?? null,
    role: input.role ?? 'member',
    is_bot: input.isBot ?? false,
    avatar_color: existing?.avatar_color ?? colorFor(username),
    avatar_initial: existing?.avatar_initial ?? null,
    plan_startup_min: existing?.plan_startup_min ?? null,
    plan_default_estimate_min: existing?.plan_default_estimate_min ?? null,
    is_remote: !!existing?.is_remote,
    home_server: existing?.home_server ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    deleted: false,
  };
  upsertUser(db, user);
  return user;
}

export function updateUser(
  db: Db,
  id: string,
  patch: Partial<
    Pick<
      User,
      | 'display_name'
      | 'role'
      | 'avatar_color'
      | 'avatar_initial'
      | 'is_bot'
      | 'plan_startup_min'
      | 'plan_default_estimate_min'
    >
  >,
): void {
  const u = getUser(db, id);
  if (!u) return;
  upsertUser(db, { ...u, ...patch, updated_at: new Date().toISOString() });
}

export function softDeleteUser(db: Db, id: string): void {
  const u = getUser(db, id);
  if (!u) return;
  upsertUser(db, { ...u, deleted: true, updated_at: new Date().toISOString() });
}

/** Insert-or-replace a user row (used by admin ops and by sync ingest, LWW). */
export function upsertUser(db: Db, user: User): void {
  const existing = db.get<{ updated_at: string }>('SELECT updated_at FROM users WHERE id = ?', [
    user.id,
  ]);
  if (existing && existing.updated_at > user.updated_at) return; // older write loses
  // Guard UNIQUE(username): if a *different* id already holds this username (two
  // devices minted separate ids for the same name — e.g. re-adding a soft-deleted
  // user offline), a raw insert throws SQLITE_CONSTRAINT and wedges the entire sync
  // ingest. De-collide deterministically so sync converges; per-id LWW is unaffected.
  const clash = db.get<{ id: string }>('SELECT id FROM users WHERE username = ? AND id <> ?', [
    user.username,
    user.id,
  ]);
  const username = clash ? `${user.username}~${user.id.slice(0, 8)}` : user.username;
  db.run(
    `INSERT INTO users (id, username, display_name, role, is_bot, avatar_color, avatar_initial, plan_startup_min, plan_default_estimate_min, is_remote, home_server, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username, display_name = excluded.display_name, role = excluded.role,
       is_bot = excluded.is_bot, avatar_color = excluded.avatar_color,
       avatar_initial = excluded.avatar_initial,
       plan_startup_min = excluded.plan_startup_min,
       plan_default_estimate_min = excluded.plan_default_estimate_min,
       is_remote = excluded.is_remote, home_server = excluded.home_server,
       updated_at = excluded.updated_at, deleted = excluded.deleted`,
    // `?? null` throughout: rows arriving via sync may predate newer columns
    // (older server / legacy record-op), and a missing key binds `undefined`,
    // which both SQL drivers reject — wedging the entire sync ingest.
    [
      user.id,
      username,
      user.display_name ?? null,
      user.role ?? 'member',
      user.is_bot ? 1 : 0,
      user.avatar_color ?? null,
      user.avatar_initial ?? null,
      user.plan_startup_min ?? null,
      user.plan_default_estimate_min ?? null,
      user.is_remote ? 1 : 0,
      user.home_server ?? null,
      user.created_at,
      user.updated_at,
      user.deleted ? 1 : 0,
    ],
  );
}

// ----- device identity ------------------------------------------------------

export function ensureDeviceId(db: Db): string {
  const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    'device_id',
  ]);
  if (row?.value) return row.value;
  const id = uuidv4();
  db.run(
    `INSERT INTO meta (key, value) VALUES ('device_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [id],
  );
  return id;
}

// ----- row <-> Item mapping -------------------------------------------------

interface ItemRow extends Row {
  id: string;
  parent_id: string | null;
  type: string;
  owner_id: string | null;
  title: string;
  note: string | null;
  status: string;
  flagged: number;
  priority: number;
  defer_date: string | null;
  due_date: string | null;
  reminder_at: string | null;
  estimate_minutes: number | null;
  completed_at: string | null;
  review_interval: number | null;
  reviewed_at: string | null;
  recurrence: string | null;
  geo: string | null;
  color: string | null;
  folder_id: string | null;
  sort_order: number;
  order_mode: string | null;
  sys_kind: string | null;
  created_at: string;
  updated_at: string;
  deleted: number;
}

function rowToItem(r: ItemRow): Item {
  return {
    id: r.id,
    parent_id: r.parent_id,
    type: r.type as ItemType,
    owner_id: r.owner_id,
    title: r.title,
    note: r.note,
    status: r.status as Item['status'],
    flagged: !!r.flagged,
    priority: r.priority,
    defer_date: r.defer_date,
    due_date: r.due_date,
    reminder_at: r.reminder_at,
    estimate_minutes: r.estimate_minutes,
    completed_at: r.completed_at,
    review_interval: r.review_interval,
    reviewed_at: r.reviewed_at,
    recurrence: r.recurrence,
    geo: r.geo,
    color: r.color,
    folder_id: r.folder_id,
    sort_order: r.sort_order,
    order_mode: (r.order_mode as OrderMode) || 'parallel',
    sys_kind: r.sys_kind,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: !!r.deleted,
  };
}

const SELECT = 'SELECT * FROM items';

// ----- reads ----------------------------------------------------------------

export function getItem(db: Db, id: string): Item | undefined {
  const row = db.get<ItemRow>(`${SELECT} WHERE id = ?`, [id]);
  return row ? rowToItem(row) : undefined;
}

/**
 * Walk up the parent chain to the nearest ancestor with `type === 'project'`.
 * Returns undefined for inbox tasks (no project ancestor). A task's project is
 * always derived this way — `parent_id` may point at another task, not a project.
 */
export function projectAncestor(db: Db, itemId: string): Item | undefined {
  const seen = new Set<string>([itemId]);
  let pid = getItem(db, itemId)?.parent_id ?? null;
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const p = getItem(db, pid);
    if (!p) break;
    if (p.type === 'project') return p;
    pid = p.parent_id;
  }
  return undefined;
}

export function getChildren(db: Db, parentId: string | null): Item[] {
  const where = parentId === null ? 'parent_id IS NULL' : 'parent_id = ?';
  const params = parentId === null ? [] : [parentId];
  return db
    .all<ItemRow>(`${SELECT} WHERE ${where} AND deleted = 0 ORDER BY sort_order, created_at`, params)
    .map(rowToItem);
}

/** Every non-deleted item (callers filter/group in memory for perspectives). */
export function allItems(db: Db): Item[] {
  return db
    .all<ItemRow>(`${SELECT} WHERE deleted = 0 ORDER BY sort_order, created_at`)
    .map(rowToItem);
}

/** A cheap, superset-safe SQL prefilter for the list views. Each flag pushes a
 *  predicate into SQL so big workspaces don't materialise every row in JS; the
 *  caller's exact JS filters then refine the (much smaller) result. */
export interface ItemQuery {
  /** type = 'task' (exclude projects/folders). */
  tasksOnly?: boolean;
  /** status != 'done' (drop completed) — exempts notes, whose status is
   *  preserved-but-inert (see createItem/updateItem), so a note converted from a
   *  done task doesn't silently vanish from an active-only view. */
  activeOnly?: boolean;
  /** flagged = 1. */
  flaggedOnly?: boolean;
  /** parent_id IS NULL (top-level only — the Inbox shape). */
  rootOnly?: boolean;
  /** flagged OR has a due date — the only rows that can land in Today. */
  dueOrFlagged?: boolean;
}

export function queryItems(db: Db, q: ItemQuery): Item[] {
  const where = ['deleted = 0'];
  if (q.tasksOnly) where.push("type = 'task'");
  if (q.activeOnly) where.push("(status != 'done' OR type = 'note')");
  if (q.flaggedOnly) where.push('flagged = 1');
  if (q.rootOnly) where.push('parent_id IS NULL');
  if (q.dueOrFlagged) where.push('(flagged = 1 OR due_date IS NOT NULL)');
  return db
    .all<ItemRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY sort_order, created_at`)
    .map(rowToItem);
}

export function getProjects(db: Db): Item[] {
  return db
    .all<ItemRow>(
      `${SELECT} WHERE type = 'project' AND deleted = 0 ORDER BY sort_order, created_at`,
    )
    .map(rowToItem);
}

/** Sidebar folders (visual-only grouping). Mirrors getProjects. */
export function getFolders(db: Db): Item[] {
  return db
    .all<ItemRow>(
      `${SELECT} WHERE type = 'folder' AND deleted = 0 ORDER BY sort_order, created_at`,
    )
    .map(rowToItem);
}

// ----- writes ---------------------------------------------------------------

function nextSortOrder(db: Db, parentId: string | null): number {
  const where = parentId === null ? 'parent_id IS NULL' : 'parent_id = ?';
  const params = parentId === null ? [] : [parentId];
  const row = db.get<{ m: number | null }>(
    `SELECT MAX(sort_order) AS m FROM items WHERE ${where}`,
    params,
  );
  return (row?.m ?? 0) + 1;
}

export interface CreateItemInput {
  type?: ItemType;
  title: string;
  parentId?: string | null;
  ownerId?: string | null;
  note?: string | null;
  flagged?: boolean;
  priority?: number;
  deferDate?: string | null;
  dueDate?: string | null;
  color?: string | null;
  folderId?: string | null;
  sortOrder?: number;
  orderMode?: OrderMode;
  /** System-notice marker (federation offer, billing issue, …); null = user task. */
  sysKind?: string | null;
}

export function createItem(db: Db, deviceId: string, input: CreateItemInput): Item {
  const now = new Date().toISOString();
  const id = uuidv4();
  const item: Item = {
    id,
    parent_id: input.parentId ?? null,
    type: input.type ?? 'task',
    owner_id: input.ownerId ?? null,
    title: input.title.trim(),
    note: input.note ?? null,
    status: 'active',
    flagged: input.flagged ?? false,
    priority: input.priority ?? 0,
    defer_date: input.deferDate ?? null,
    due_date: input.dueDate ?? null,
    reminder_at: null,
    estimate_minutes: null,
    completed_at: null,
    // Projects default to a 30-day review cadence; tasks aren't reviewed.
    review_interval: input.type === 'project' ? 30 : null,
    reviewed_at: null,
    recurrence: null,
    geo: null,
    color: input.color ?? null,
    folder_id: input.folderId ?? null,
    sort_order: input.sortOrder ?? nextSortOrder(db, input.parentId ?? null),
    order_mode: input.orderMode ?? 'parallel',
    sys_kind: input.sysKind ?? null,
    created_at: now,
    updated_at: now,
    deleted: false,
  };
  recordOp(db, deviceId, id, createPatch(item));
  // A freshly-added (incomplete) sub-task re-opens a parent that was marked done.
  // A note child is inert (not actionable), so it never reopens a completed parent.
  if (item.type !== 'note') reopenParentIfNeeded(db, deviceId, item.parent_id);
  return item;
}

/** Adding/moving an incomplete task under a completed parent re-opens that parent
 *  (so a "done" task can't hide unfinished children). Callers must skip this for
 *  inert (note) children, which never affect a parent's completion. */
function reopenParentIfNeeded(db: Db, deviceId: string, parentId: string | null): void {
  if (!parentId) return;
  const parent = getItem(db, parentId);
  if (parent && parent.type === 'task' && parent.status === 'done') {
    updateItem(db, deviceId, parentId, { status: 'active', completed_at: null });
  }
}

/** Apply an arbitrary patch as a single op. Returns the updated item. */
export function updateItem(
  db: Db,
  deviceId: string,
  id: string,
  patch: ItemPatch,
): Item | undefined {
  const before = getItem(db, id);
  recordOp(db, deviceId, id, patch);
  const updated = getItem(db, id);
  // Converting a note back into an active task must preserve the same invariant as
  // create/move: a done parent can't hide unfinished task children.
  if (
    before?.type === 'note' &&
    patch.type === 'task' &&
    updated?.status === 'active'
  ) {
    reopenParentIfNeeded(db, deviceId, updated.parent_id);
  }
  return updated;
}

/**
 * Toggle completion. Completing sets status=done + completed_at; if the item
 * recurs, also spawns the next occurrence as a fresh active item. Returns the
 * spawned item (if any).
 */
export function setCompleted(
  db: Db,
  deviceId: string,
  id: string,
  done: boolean,
): { item: Item | undefined; spawned: Item | undefined } {
  const current = getItem(db, id);
  if (!current) return { item: undefined, spawned: undefined };
  // A note has no completion state — its status is preserved-but-inert (see
  // createItem/moveItem/setCompletedCascade). Guard here too, at the function level,
  // so any caller (agent ops, sync replay, a future UI path) that reaches setCompleted
  // directly on a note can't flip its status or spawn a recurring note successor; the
  // cascade-level guard alone left this reachable outside the cascade.
  if (current.type === 'note') return { item: current, spawned: undefined };

  let spawned: Item | undefined;
  if (done && current.recurrence) {
    const at = new Date();
    const nextDue = nextDueDate(current, at);
    if (nextDue) {
      // If the original was deferred, keep the same gap before its due date so the
      // new occurrence becomes available the same number of days ahead of its due.
      // Measure the gap in whole calendar days and preserve the original defer's local
      // time-of-day, rather than subtracting absolute milliseconds — the latter drifts
      // by an hour across a DST boundary and would knock an all-day defer off its
      // 23:59 marker, misclassifying it as a timed defer (C4).
      let deferDate: string | null = null;
      if (current.due_date && current.defer_date) {
        const origDefer = new Date(current.defer_date);
        const gapDays = Math.round(
          (new Date(current.due_date).getTime() - origDefer.getTime()) / 86_400_000,
        );
        const d = new Date(nextDue);
        d.setDate(d.getDate() - gapDays);
        d.setHours(
          origDefer.getHours(),
          origDefer.getMinutes(),
          origDefer.getSeconds(),
          0,
        );
        deferDate = d.toISOString();
      }
      spawned = createItem(db, deviceId, {
        type: current.type,
        title: current.title,
        parentId: current.parent_id,
        ownerId: current.owner_id,
        note: current.note,
        flagged: current.flagged,
        priority: current.priority,
        dueDate: nextDue,
        deferDate,
      });
      // createItem() only accepts a subset of fields, so carry the rest of the
      // recurring task's settings onto the new occurrence here. Everything that
      // describes *how* the task is done (effort, location, tags) should persist.
      const carry: ItemPatch = {
        recurrence: current.recurrence,
        estimate_minutes: current.estimate_minutes,
        geo: current.geo,
      };
      // reminder_at is an absolute datetime tied to the *old* due date. If both
      // the old due and reminder are set, preserve the same offset relative to
      // the new due so "remind me N before/after due" keeps working; otherwise
      // drop it (a fixed reminder for a past occurrence shouldn't re-fire).
      if (current.reminder_at && current.due_date) {
        const delta =
          new Date(current.reminder_at).getTime() - new Date(current.due_date).getTime();
        carry.reminder_at = new Date(new Date(nextDue).getTime() + delta).toISOString();
      }
      // Re-read so the returned item reflects the carried-over fields.
      spawned = updateItem(db, deviceId, spawned.id, carry);
      // Copy tag links (item_tags rows) onto the new occurrence.
      for (const tag of getItemTags(db, current.id)) {
        setItemTagLink(db, deviceId, spawned!.id, tag.id, false);
      }
    }
  }

  const item = updateItem(db, deviceId, id, {
    status: done ? 'done' : 'active',
    completed_at: done ? new Date().toISOString() : null,
  });
  return { item, spawned };
}

export function deleteItem(db: Db, deviceId: string, id: string): void {
  // Soft-delete the item and its descendants so nothing is orphaned.
  const ids = collectDescendants(db, id);
  for (const childId of ids) {
    recordOp(db, deviceId, childId, { deleted: true });
  }
}

/** Age gate shared by the Settings → Data purge UI and the server's "completed
 *  items piling up" nudge — both only consider items completed more than this
 *  many days ago, so the nudge never points at an empty purge section. */
export const COMPLETED_PURGE_AGE_DAYS = 7;

/** This user's own completed tasks whose `completed_at` is older than `cutoffIso` —
 *  the candidate set for a "purge old completed items" action. Scoped to items the
 *  user owns (mirrors the owner half of `visibleItemIds`); shared completed items
 *  owned by someone else are out of scope. `ownerId: null` scopes to unowned items —
 *  the normal case for a single-user, no-account, offline-only workspace, where
 *  `owner_id` is never set (SQLite's `IS` makes NULL = NULL true, unlike `=`).
 *
 *  Purging tombstones a whole subtree (`deleteItem` cascades), so an item only
 *  qualifies if everything live underneath it also qualifies: a completed parent
 *  with an active, too-recent, or someone-else's descendant is held back until
 *  its whole subtree is purgeable. That keeps the count shown in the UI equal to
 *  what a purge actually tombstones. */
export function completedBefore(db: Db, ownerId: string | null, cutoffIso: string): Item[] {
  const matched = db
    .all<ItemRow>(
      `${SELECT} WHERE owner_id IS ? AND status = 'done' AND deleted = 0
       AND completed_at IS NOT NULL AND completed_at < ?
       ORDER BY completed_at`,
      [ownerId, cutoffIso],
    )
    .map(rowToItem);
  if (matched.length === 0) return matched;
  // Every live non-candidate disqualifies all its candidate ancestors. Once an
  // ancestor is already marked, the walk that marked it has climbed everything
  // above it too, so each chain is walked at most once overall.
  const matchedIds = new Set(matched.map((i) => i.id));
  const parentOf = new Map<string, string | null>();
  for (const r of db.all<{ id: string; parent_id: string | null }>(
    'SELECT id, parent_id FROM items WHERE deleted = 0',
  )) {
    parentOf.set(r.id, r.parent_id);
  }
  const blocked = new Set<string>();
  for (const id of parentOf.keys()) {
    if (matchedIds.has(id)) continue;
    const seen = new Set<string>(); // guard against any parent cycle
    let pid = parentOf.get(id) ?? null;
    while (pid && !seen.has(pid) && !blocked.has(pid)) {
      seen.add(pid);
      if (matchedIds.has(pid)) blocked.add(pid);
      pid = parentOf.get(pid) ?? null;
    }
  }
  return blocked.size ? matched.filter((i) => !blocked.has(i.id)) : matched;
}

/** Soft-delete every item `completedBefore` qualifies for this owner. Reuses
 *  `deleteItem` (same cascade semantics as a manual delete), so it stays fully
 *  CRDT-safe and syncs like any other tombstone — but only subtree tops are
 *  deleted explicitly: a candidate nested under another candidate is covered by
 *  its ancestor's cascade, and tombstoning it again would just record duplicate
 *  ops (which are permanent and sync everywhere). Returns the number of items
 *  purged, which by construction equals the `completedBefore` count. */
export function purgeCompleted(
  db: Db,
  deviceId: string,
  ownerId: string | null,
  cutoffIso: string,
): number {
  const items = completedBefore(db, ownerId, cutoffIso);
  if (items.length === 0) return 0;
  // A qualifying item's live subtree qualifies in full (see completedBefore), so
  // "my parent also qualifies" is exactly "some ancestor's cascade covers me".
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) {
    if (item.parent_id && ids.has(item.parent_id)) continue;
    deleteItem(db, deviceId, item.id);
  }
  return items.length;
}

export type CountScope = 'all' | 'direct';

interface ChildRow {
  id: string;
  type: string;
  status: string;
}

/** One scan of every live item, grouped by parent — the shared building block
 *  behind both `subtaskProgress` and `openCountsByContainer` so neither one
 *  issues a SQL query per BFS node (a single query, followed by an in-memory
 *  walk, regardless of subtree size or how many containers are queried). */
function childrenByParent(db: Db): Map<string, ChildRow[]> {
  const kids = new Map<string, ChildRow[]>();
  for (const r of db.all<{ id: string; parent_id: string | null; type: string; status: string }>(
    'SELECT id, parent_id, type, status FROM items WHERE deleted = 0',
  )) {
    if (!r.parent_id) continue;
    const row = { id: r.id, type: r.type, status: r.status };
    const arr = kids.get(r.parent_id);
    if (arr) arr.push(row);
    else kids.set(r.parent_id, [row]);
  }
  return kids;
}

/** BFS over an in-memory parent→children map (see `childrenByParent`), counting
 *  leaf-descendant tasks — shared by `subtaskProgress('all')` and
 *  `openCountsByContainer('all')` so the traversal logic lives in one place. */
function leafTaskProgress(
  kids: Map<string, ChildRow[]>,
  rootId: string,
): { done: number; total: number } {
  const taskKids = (id: string) => (kids.get(id) ?? []).filter((c) => c.type === 'task');
  let done = 0;
  let total = 0;
  const queue = [...(kids.get(rootId) ?? [])];
  while (queue.length) {
    const c = queue.shift()!;
    if (c.type !== 'task') continue;
    const tk = taskKids(c.id);
    if (tk.length === 0) {
      total++;
      if (c.status === 'done') done++;
    } else {
      queue.push(...tk);
    }
  }
  return { done, total };
}

/** Sub-task progress for the pie ring and remaining-work counts.
 *  - `direct`: immediate child tasks (done / total).
 *  - `all`: leaf descendant tasks — a task with no task-children counts once.
 *  Both ignore non-task children and deleted items. Uses a single query (see
 *  `childrenByParent`) rather than one `getChildren` query per BFS node. */
export function subtaskProgress(
  db: Db,
  id: string,
  scope: CountScope,
): { done: number; total: number } {
  if (scope === 'direct') {
    const kids = getChildren(db, id).filter((c) => c.type === 'task');
    return { done: kids.filter((c) => c.status === 'done').length, total: kids.length };
  }
  return leafTaskProgress(childrenByParent(db), id);
}

/**
 * Remaining-open task counts for many containers in a single pass — the batch form
 * of `subtaskProgress`'s `total - done`, used by the sidebar so it fires one scan
 * instead of a recursive walk per project. `scope` matches {@link subtaskProgress}:
 * 'direct' counts immediate child tasks, 'all' counts leaf-descendant tasks.
 */
export function openCountsByContainer(
  db: Db,
  containerIds: string[],
  scope: CountScope,
): Map<string, number> {
  const out = new Map<string, number>();
  if (containerIds.length === 0) return out;
  const kids = childrenByParent(db);
  const remaining = (id: string): number => {
    if (scope === 'direct') {
      return (kids.get(id) ?? []).filter((c) => c.type === 'task' && c.status !== 'done').length;
    }
    const { done, total } = leafTaskProgress(kids, id);
    return total - done;
  };
  for (const id of containerIds) out.set(id, remaining(id));
  return out;
}

/** The priority whose colour an item's completion circle should display: its own
 *  priority if set, otherwise inherited from the nearest ancestor *task* that has
 *  one, so a subtree shares the parent's priority colour until a task sets its own.
 *  Project colours are intentionally NOT inherited here (a project's colour stays on
 *  its folder icon). Returns 0 (None / grey) when nothing up the chain has a
 *  priority. */
export function inheritedPriority(db: Db, item: Item): number {
  if (item.priority > 0) return item.priority;
  let pid = item.parent_id;
  let guard = 0;
  while (pid && guard++ < 50) {
    const p = getItem(db, pid);
    if (!p || p.deleted) break;
    if (p.type === 'task' && p.priority > 0) return p.priority;
    pid = p.parent_id;
  }
  return 0;
}

/** Sum of estimate_minutes across every descendant task of a project (recursive).
 *  Used for the project's read-only, rolled-up estimate. */
export function projectEstimateMinutes(db: Db, id: string): number {
  let sum = 0;
  for (const d of collectDescendants(db, id)) {
    if (d === id) continue;
    const it = getItem(db, d);
    if (it && !it.deleted && it.type === 'task' && it.estimate_minutes) sum += it.estimate_minutes;
  }
  return sum;
}

/** Complete an item *and* every descendant task — the §7 "complete all sub-tasks"
 *  escape hatch for finishing a parent with unfinished children. */
export function setCompletedCascade(db: Db, deviceId: string, id: string): void {
  for (const d of collectDescendants(db, id)) {
    const it = getItem(db, d);
    if (it && it.type === 'task' && it.status !== 'done') {
      setCompleted(db, deviceId, d, true);
    }
  }
}

function collectDescendants(db: Db, rootId: string): string[] {
  const result: string[] = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift()!;
    const kids = db.all<{ id: string }>('SELECT id FROM items WHERE parent_id = ?', [
      parent,
    ]);
    for (const k of kids) {
      result.push(k.id);
      queue.push(k.id);
    }
  }
  return result;
}

export function moveItem(
  db: Db,
  deviceId: string,
  id: string,
  parentId: string | null,
  sortOrder?: number,
): void {
  const patch: ItemPatch = { parent_id: parentId };
  patch.sort_order = sortOrder ?? nextSortOrder(db, parentId);
  recordOp(db, deviceId, id, patch);
  const moved = getItem(db, id);
  // An inert note child never reopens a completed parent; only an incomplete task does.
  if (moved && moved.type !== 'note' && moved.status !== 'done')
    reopenParentIfNeeded(db, deviceId, parentId);
}

const orderedSiblings = (db: Db, parentId: string | null): Item[] =>
  getChildren(db, parentId)
    .filter((s) => !s.deleted)
    .sort((a, b) => a.sort_order - b.sort_order);

/** Move an item among its siblings: dir -1 = up, 1 = down. */
export function reorderSibling(db: Db, deviceId: string, id: string, dir: -1 | 1): void {
  const it = getItem(db, id);
  if (!it) return;
  const sibs = orderedSiblings(db, it.parent_id);
  const idx = sibs.findIndex((s) => s.id === id);
  const tgt = idx + dir;
  if (idx < 0 || tgt < 0 || tgt >= sibs.length) return;
  let order: number;
  if (dir < 0) {
    const before = tgt > 0 ? sibs[tgt - 1]!.sort_order : sibs[tgt]!.sort_order - 1;
    order = (before + sibs[tgt]!.sort_order) / 2;
  } else {
    const after = tgt < sibs.length - 1 ? sibs[tgt + 1]!.sort_order : sibs[tgt]!.sort_order + 1;
    order = (sibs[tgt]!.sort_order + after) / 2;
  }
  moveItem(db, deviceId, id, it.parent_id, order);
}

/** Indent: nest the item under its previous sibling (appended). */
export function indentItem(db: Db, deviceId: string, id: string): void {
  const it = getItem(db, id);
  if (!it) return;
  const sibs = orderedSiblings(db, it.parent_id);
  const idx = sibs.findIndex((s) => s.id === id);
  if (idx <= 0) return; // nothing to nest under
  moveItem(db, deviceId, id, sibs[idx - 1]!.id);
}

/** Outdent: move the item up to its grandparent, right after its old parent.
 *  Won't move out past `stopAt` (e.g. the tree root). */
export function outdentItem(db: Db, deviceId: string, id: string, stopAt: string | null): void {
  const it = getItem(db, id);
  if (!it || !it.parent_id || it.parent_id === stopAt) return;
  const parent = getItem(db, it.parent_id);
  if (!parent) return;
  const grand = parent.parent_id;
  const gsibs = orderedSiblings(db, grand);
  const pidx = gsibs.findIndex((s) => s.id === parent.id);
  const after =
    pidx >= 0 && pidx < gsibs.length - 1 ? gsibs[pidx + 1]!.sort_order : parent.sort_order + 1;
  moveItem(db, deviceId, id, grand, (parent.sort_order + after) / 2);
}

/** Create an empty sibling right after `afterId`. */
export function createSiblingAfter(
  db: Db,
  deviceId: string,
  afterId: string,
  ownerId: string | null,
): Item {
  const it = getItem(db, afterId);
  const parentId = it?.parent_id ?? null;
  const sibs = orderedSiblings(db, parentId);
  const idx = sibs.findIndex((s) => s.id === afterId);
  const cur = it?.sort_order ?? 0;
  const next = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1]!.sort_order : cur + 1;
  return createItem(db, deviceId, { title: '', parentId, ownerId, sortOrder: (cur + next) / 2 });
}

export function reorderItem(db: Db, deviceId: string, id: string, sortOrder: number): void {
  recordOp(db, deviceId, id, { sort_order: sortOrder });
}

/** Move a project into a sidebar folder (or out, folderId = null) and set its new
 *  position in one op. Deliberately does NOT go through moveItem/parent_id — folder
 *  membership is visual-only and must never invoke task-nesting semantics. */
export function moveProjectToFolder(
  db: Db,
  deviceId: string,
  id: string,
  folderId: string | null,
  sortOrder: number,
): void {
  recordOp(db, deviceId, id, { folder_id: folderId, sort_order: sortOrder });
}

/** Delete a sidebar folder. Its member projects are NOT deleted — they're moved
 *  back to the top level (folder_id = null) so nothing is lost, then the folder
 *  itself is tombstoned. */
export function deleteFolder(db: Db, deviceId: string, id: string): void {
  const members = db.all<{ id: string }>(
    `SELECT id FROM items WHERE folder_id = ? AND deleted = 0`,
    [id],
  );
  for (const m of members) {
    recordOp(db, deviceId, m.id, { folder_id: null, sort_order: nextSortOrder(db, null) });
  }
  recordOp(db, deviceId, id, { deleted: true });
}

export function markReviewed(db: Db, deviceId: string, id: string): void {
  recordOp(db, deviceId, id, { reviewed_at: new Date().toISOString() });
}

/** Assign ownership of all currently-unowned items to a user (run once on first
 *  login so locally-captured items become the user's and sync correctly). */
export function claimUnowned(db: Db, deviceId: string, userId: string): number {
  const rows = db.all<{ id: string }>('SELECT id FROM items WHERE owner_id IS NULL');
  for (const r of rows) recordOp(db, deviceId, r.id, { owner_id: userId });
  return rows.length;
}

// ----- tags (synced as record-ops: entities 'tag' and 'item_tag') -----------

interface TagRow extends Row {
  id: string;
  name: string;
  color: string | null;
  status: string | null;
  sort_order: number;
  geo: string | null;
  created_at: string;
  updated_at: string;
  deleted: number;
}

interface ItemTagRow extends Row {
  item_id: string;
  tag_id: string;
  updated_at: string;
  deleted: number;
}

function rowToTag(t: TagRow): Tag {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    status: (t.status as TagStatus) || 'active',
    sort_order: t.sort_order ?? 0,
    geo: t.geo ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    deleted: !!t.deleted,
  };
}

// ----- hierarchical tag paths ("Shopping:Coles:FreshGoods") ------------------

/** Split a tag path into its trimmed, non-empty segments. */
export function tagSegments(name: string): string[] {
  return name
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Canonical path form: trimmed segments rejoined, empties dropped. */
export function normalizeTagName(name: string): string {
  return tagSegments(name).join(':');
}

/** Parent path of a tag path ("" for a top-level tag). */
export function tagParentPath(name: string): string {
  const segs = tagSegments(name);
  return segs.slice(0, -1).join(':');
}

/** The leaf (last) segment of a tag path. */
export function tagLeaf(name: string): string {
  const segs = tagSegments(name);
  return segs[segs.length - 1] ?? '';
}

/** Deterministic, content-addressed tag id so the same path converges across devices. */
export function tagId(name: string): string {
  return 't:' + normalizeTagName(name).toLowerCase();
}

const itemTagRowId = (itemId: string, tag: string): string => `it:${itemId}:${tag}`;

export function listTags(db: Db): Tag[] {
  return db
    .all<TagRow>('SELECT * FROM tags WHERE deleted = 0 ORDER BY sort_order, name')
    .map(rowToTag);
}

/** Next sort_order after the last sibling sharing the given parent path. */
function nextTagSortOrder(db: Db, parentPath: string): number {
  const rows = db.all<{ name: string; sort_order: number }>(
    'SELECT name, sort_order FROM tags WHERE deleted = 0',
  );
  let max = 0;
  for (const r of rows) if (tagParentPath(r.name) === parentPath) max = Math.max(max, r.sort_order ?? 0);
  return max + 1;
}

/** Emit a tag record-op from a fully-formed Tag (stamps a fresh updated_at from the
 *  causal clock, skew-safe like shareItem/setItemDepLink — see upsertTag's LWW merge). */
function emitTag(db: Db, deviceId: string, tag: Omit<Tag, 'updated_at'>): Tag {
  const full: Tag = { ...tag, updated_at: causalNowIso(db) };
  recordRecordOp(db, deviceId, 'tag', full.id, full);
  return full;
}

/** Materialize any missing ancestor rows of a tag path (idempotent). */
function ensureAncestors(db: Db, deviceId: string, name: string): void {
  const segs = tagSegments(name);
  for (let i = 1; i < segs.length; i++) {
    const path = segs.slice(0, i).join(':');
    const id = tagId(path);
    const row = db.get<TagRow>('SELECT id FROM tags WHERE id = ? AND deleted = 0', [id]);
    if (!row) {
      emitTag(db, deviceId, {
        id,
        name: path,
        color: null,
        status: 'active',
        sort_order: nextTagSortOrder(db, tagParentPath(path)),
        geo: null,
        created_at: new Date().toISOString(),
        deleted: false,
      });
    }
  }
}

export function createTag(db: Db, deviceId: string, rawName: string, color: string | null = null): Tag {
  const name = normalizeTagName(rawName);
  const id = tagId(name);
  ensureAncestors(db, deviceId, name);
  const existing = db.get<TagRow>('SELECT * FROM tags WHERE id = ?', [id]);
  if (existing && !existing.deleted) return rowToTag(existing);
  return emitTag(db, deviceId, {
    id,
    name,
    color: color ?? existing?.color ?? null,
    status: (existing?.status as TagStatus) || 'active',
    sort_order: existing?.sort_order ?? nextTagSortOrder(db, tagParentPath(name)),
    geo: existing?.geo ?? null,
    created_at: existing?.created_at ?? new Date().toISOString(),
    deleted: false,
  });
}

export function updateTag(
  db: Db,
  deviceId: string,
  id: string,
  patch: { color?: string | null; status?: TagStatus; geo?: string | null; sort_order?: number },
): void {
  const existing = db.get<TagRow>('SELECT * FROM tags WHERE id = ?', [id]);
  if (!existing) return;
  emitTag(db, deviceId, {
    ...rowToTag(existing),
    color: patch.color !== undefined ? patch.color : existing.color,
    status: patch.status ?? ((existing.status as TagStatus) || 'active'),
    geo: patch.geo !== undefined ? patch.geo : existing.geo ?? null,
    sort_order: patch.sort_order ?? existing.sort_order ?? 0,
    deleted: false,
  });
}

/** Set a tag's position among its siblings (web computes the fractional midpoint,
 *  mirroring reorderItem). */
export function reorderTag(db: Db, deviceId: string, id: string, sortOrder: number): void {
  updateTag(db, deviceId, id, { sort_order: sortOrder });
}

/**
 * Rename or reparent a tag (and its whole subtree) to a new full path. Because tag
 * ids are content-addressed by path, this re-keys every affected row: it creates the
 * new id, re-points all item links, and tombstones the old id. If the target path
 * already exists the subtrees merge (links union). No-op if the path is unchanged.
 */
export function moveTag(db: Db, deviceId: string, id: string, newRawName: string): void {
  const src = db.get<TagRow>('SELECT * FROM tags WHERE id = ? AND deleted = 0', [id]);
  if (!src) return;
  const newName = normalizeTagName(newRawName);
  if (!newName) return;
  const oldName = src.name;
  if (tagId(newName) === id && newName === oldName) return;

  ensureAncestors(db, deviceId, newName);

  // Subtree = the node plus every descendant (by path prefix), parents first.
  const subtree = db
    .all<TagRow>('SELECT * FROM tags WHERE deleted = 0 ORDER BY name', [])
    .filter((t) => t.id === id || t.id.startsWith(id + ':'));

  for (const node of subtree) {
    const targetName = newName + node.name.slice(oldName.length);
    const targetId = tagId(targetName);
    if (targetId === node.id) continue; // path unchanged for this node

    const existingTarget = db.get<TagRow>('SELECT * FROM tags WHERE id = ?', [targetId]);
    const liveTarget = existingTarget && !existingTarget.deleted ? existingTarget : null;
    // The dragged node itself lands at the end of its new sibling list; deeper
    // descendants keep their relative order.
    const sort_order =
      liveTarget?.sort_order ??
      (node.id === id ? nextTagSortOrder(db, tagParentPath(targetName)) : node.sort_order ?? 0);
    emitTag(db, deviceId, {
      id: targetId,
      name: targetName,
      // Prefer a live target's own colour/status/geo; otherwise carry the node's.
      color: liveTarget ? liveTarget.color : node.color,
      status: ((liveTarget ? liveTarget.status : node.status) as TagStatus) || 'active',
      sort_order,
      geo: liveTarget ? liveTarget.geo ?? null : node.geo ?? null,
      created_at: existingTarget?.created_at ?? node.created_at,
      deleted: false,
    });

    // Re-point this node's item links onto the target id, tombstoning the old.
    for (const r of db.all<{ item_id: string }>(
      'SELECT item_id FROM item_tags WHERE tag_id = ? AND deleted = 0',
      [node.id],
    )) {
      setItemTagLink(db, deviceId, r.item_id, targetId, false);
      setItemTagLink(db, deviceId, r.item_id, node.id, true);
    }

    // Tombstone the old tag row.
    emitTag(db, deviceId, { ...rowToTag(node), deleted: true });
  }
}

// ----- tag hierarchy queries -------------------------------------------------

/** Ids of all live descendants of a tag (excludes the tag itself). */
export function descendantTagIds(db: Db, id: string): string[] {
  const prefix = id + ':';
  return db
    .all<{ id: string }>('SELECT id FROM tags WHERE deleted = 0')
    .map((r) => r.id)
    .filter((x) => x.startsWith(prefix));
}

/** Expand a set of tag ids to include all their descendants. */
export function expandTagIds(db: Db, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    for (const d of descendantTagIds(db, id)) out.add(d);
  }
  return out;
}

/** Effective colour of a tag: its own, else the nearest ancestor with a colour. */
export function effectiveTagColor(db: Db, name: string): string | null {
  let path = normalizeTagName(name);
  while (path) {
    const row = db.get<{ color: string | null }>(
      'SELECT color FROM tags WHERE id = ? AND deleted = 0',
      [tagId(path)],
    );
    if (row && row.color) return row.color;
    const parent = tagParentPath(path);
    if (parent === path) break;
    path = parent;
  }
  return null;
}

/** Ids of all live on-hold tags. */
export function onHoldTagIds(db: Db): Set<string> {
  return new Set(
    db
      .all<{ id: string }>("SELECT id FROM tags WHERE deleted = 0 AND status = 'on-hold'")
      .map((r) => r.id),
  );
}

/** The expanded on-hold tag set (on-hold tags plus all their descendants). */
export function heldTagIds(db: Db): Set<string> {
  return expandTagIds(db, [...onHoldTagIds(db)]);
}

/** True if `itemId` carries any tag in `held` (defaults to the live held set).
 *  Used to suppress reminders for tasks tagged on-hold. */
export function itemHasHeldTag(db: Db, itemId: string, held?: Set<string>): boolean {
  const set = held ?? heldTagIds(db);
  if (set.size === 0) return false;
  return getItemTags(db, itemId).some((t) => set.has(t.id));
}

export function deleteTag(db: Db, deviceId: string, id: string): void {
  const existing = db.get<TagRow>('SELECT * FROM tags WHERE id = ?', [id]);
  if (existing) {
    recordRecordOp(db, deviceId, 'tag', id, {
      ...rowToTag(existing),
      deleted: true,
      updated_at: causalNowIso(db),
    });
  }
  // Tombstone its links so the removal syncs too.
  for (const r of db.all<{ item_id: string }>(
    'SELECT item_id FROM item_tags WHERE tag_id = ? AND deleted = 0',
    [id],
  )) {
    setItemTagLink(db, deviceId, r.item_id, id, true);
  }
}

export function getItemsByTag(db: Db, tag: string): Item[] {
  return db
    .all<ItemRow>(
      `SELECT items.* FROM items
       JOIN item_tags ON item_tags.item_id = items.id
       WHERE item_tags.tag_id = ? AND item_tags.deleted = 0 AND items.deleted = 0
       ORDER BY items.sort_order, items.created_at`,
      [tag],
    )
    .map(rowToItem);
}

/** Count of non-deleted items carrying each tag, keyed by tag id. */
export function tagCounts(db: Db): Record<string, number> {
  const rows = db.all<{ tag_id: string; n: number }>(
    `SELECT item_tags.tag_id AS tag_id, COUNT(*) AS n FROM item_tags
     JOIN items ON items.id = item_tags.item_id
     WHERE items.deleted = 0 AND item_tags.deleted = 0 GROUP BY item_tags.tag_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.tag_id] = Number(r.n);
  return out;
}

export function getItemTags(db: Db, itemId: string): Tag[] {
  return db
    .all<TagRow>(
      `SELECT t.* FROM tags t JOIN item_tags it ON it.tag_id = t.id
       WHERE it.item_id = ? AND it.deleted = 0 AND t.deleted = 0 ORDER BY t.name`,
      [itemId],
    )
    .map(rowToTag);
}

/** Add or tombstone a single item↔tag link as a synced record-op. */
export function setItemTagLink(
  db: Db,
  deviceId: string,
  itemId: string,
  tag: string,
  deleted: boolean,
): void {
  const row: ItemTag = { item_id: itemId, tag_id: tag, updated_at: causalNowIso(db), deleted };
  recordRecordOp(db, deviceId, 'item_tag', itemTagRowId(itemId, tag), row);
}

export function setItemTags(db: Db, deviceId: string, itemId: string, tagIds: string[]): void {
  const current = db
    .all<{ tag_id: string }>('SELECT tag_id FROM item_tags WHERE item_id = ? AND deleted = 0', [
      itemId,
    ])
    .map((r) => r.tag_id);
  const next = new Set(tagIds);
  for (const tid of current) if (!next.has(tid)) setItemTagLink(db, deviceId, itemId, tid, true);
  for (const tid of tagIds) if (!current.includes(tid)) setItemTagLink(db, deviceId, itemId, tid, false);
}

export function upsertTag(db: Db, tag: Tag): void {
  const existing = db.get<{ updated_at: string }>('SELECT updated_at FROM tags WHERE id = ?', [
    tag.id,
  ]);
  if (existing && existing.updated_at > tag.updated_at) return;
  db.run(
    `INSERT INTO tags (id, name, color, status, sort_order, geo, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, color = excluded.color, status = excluded.status,
       sort_order = excluded.sort_order, geo = excluded.geo,
       updated_at = excluded.updated_at, deleted = excluded.deleted`,
    [
      tag.id,
      tag.name,
      tag.color ?? null,
      tag.status || 'active',
      tag.sort_order ?? 0,
      tag.geo ?? null,
      tag.created_at,
      tag.updated_at,
      tag.deleted ? 1 : 0,
    ],
  );
}

export function upsertItemTag(db: Db, row: ItemTag): void {
  const existing = db.get<{ updated_at: string }>(
    'SELECT updated_at FROM item_tags WHERE item_id = ? AND tag_id = ?',
    [row.item_id, row.tag_id],
  );
  if (existing && existing.updated_at > row.updated_at) return;
  db.run(
    `INSERT INTO item_tags (item_id, tag_id, updated_at, deleted)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id, tag_id) DO UPDATE SET
       updated_at = excluded.updated_at, deleted = excluded.deleted`,
    [row.item_id, row.tag_id, row.updated_at, row.deleted ? 1 : 0],
  );
}

// ----- item dependencies (task-to-task blocking) ----------------------------
//
// A directed edge pred_id -> succ_id means "pred blocks succ": succ is not
// available until pred is done/dropped. Synced row-level like item_tags, and
// (like item_tags) stamped with the causal clock so LWW merge is skew-safe.

const depRowId = (predId: string, succId: string): string => `dep:${predId}:${succId}`;

/** Add or tombstone a single dependency edge (pred blocks succ) as a synced op. */
export function setItemDepLink(
  db: Db,
  deviceId: string,
  predId: string,
  succId: string,
  deleted: boolean,
): void {
  const row: ItemDep = { pred_id: predId, succ_id: succId, updated_at: causalNowIso(db), deleted };
  recordRecordOp(db, deviceId, 'item_dep', depRowId(predId, succId), row);
}

export function upsertItemDep(db: Db, row: ItemDep): void {
  const existing = db.get<{ updated_at: string }>(
    'SELECT updated_at FROM item_deps WHERE pred_id = ? AND succ_id = ?',
    [row.pred_id, row.succ_id],
  );
  if (existing && existing.updated_at > row.updated_at) return;
  db.run(
    `INSERT INTO item_deps (pred_id, succ_id, updated_at, deleted)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pred_id, succ_id) DO UPDATE SET
       updated_at = excluded.updated_at, deleted = excluded.deleted`,
    [row.pred_id, row.succ_id, row.updated_at, row.deleted ? 1 : 0],
  );
}

/** Tasks that block `itemId` (its predecessors / "blocked by"). */
export function getPredecessors(db: Db, itemId: string): Item[] {
  return db
    .all<ItemRow>(
      `SELECT items.* FROM items
       JOIN item_deps ON item_deps.pred_id = items.id
       WHERE item_deps.succ_id = ? AND item_deps.deleted = 0 AND items.deleted = 0
       ORDER BY items.sort_order, items.created_at`,
      [itemId],
    )
    .map(rowToItem);
}

/** Tasks that `itemId` blocks (its successors / "blocks"). */
export function getSuccessors(db: Db, itemId: string): Item[] {
  return db
    .all<ItemRow>(
      `SELECT items.* FROM items
       JOIN item_deps ON item_deps.succ_id = items.id
       WHERE item_deps.pred_id = ? AND item_deps.deleted = 0 AND items.deleted = 0
       ORDER BY items.sort_order, items.created_at`,
      [itemId],
    )
    .map(rowToItem);
}

/** Direct successor ids of an item (live edges only). */
function successorIds(db: Db, itemId: string): string[] {
  return db
    .all<{ succ_id: string }>(
      'SELECT succ_id FROM item_deps WHERE pred_id = ? AND deleted = 0',
      [itemId],
    )
    .map((r) => r.succ_id);
}

/**
 * Would adding the edge predId -> succId create a cycle? True if succId can
 * already reach predId by following existing successor edges (so pred already
 * depends, transitively, on succ). A self-edge is always a cycle.
 */
export function depWouldCycle(db: Db, predId: string, succId: string): boolean {
  if (predId === succId) return true;
  const seen = new Set<string>();
  const stack = [succId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === predId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of successorIds(db, cur)) stack.push(next);
  }
  return false;
}

/** True if `a` is an ancestor or descendant of `b` (same vertical lineage). */
export function isLineage(db: Db, a: string, b: string): boolean {
  if (a === b) return true;
  const climbs = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    let pid = getItem(db, from)?.parent_id ?? null;
    while (pid && !seen.has(pid)) {
      if (pid === to) return true;
      seen.add(pid);
      pid = getItem(db, pid)?.parent_id ?? null;
    }
    return false;
  };
  return climbs(a, b) || climbs(b, a);
}

/** One-time emit of record-ops for pre-existing local tags & links so they sync. */
export function backfillTagRecordOps(db: Db, deviceId: string): number {
  let n = 0;
  for (const t of db.all<TagRow>('SELECT * FROM tags')) {
    recordRecordOp(db, deviceId, 'tag', t.id, rowToTag(t));
    n++;
  }
  for (const it of db.all<ItemTagRow>(
    'SELECT item_id, tag_id, updated_at, deleted FROM item_tags',
  )) {
    recordRecordOp(db, deviceId, 'item_tag', itemTagRowId(it.item_id, it.tag_id), {
      item_id: it.item_id,
      tag_id: it.tag_id,
      updated_at: it.updated_at,
      deleted: !!it.deleted,
    });
    n++;
  }
  return n;
}

// ----- time logs ------------------------------------------------------------

interface TimeLogRow extends Row {
  id: string;
  item_id: string;
  user_id: string | null;
  start_time: string;
  end_time: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  kind: string;
  session_id: string | null;
  deleted: number;
}

export function rowToTimeLog(r: TimeLogRow): TimeLog {
  return {
    id: r.id,
    item_id: r.item_id,
    user_id: r.user_id,
    start_time: r.start_time,
    end_time: r.end_time,
    note: r.note,
    created_at: r.created_at,
    updated_at: r.updated_at,
    kind: (r.kind as TimeLog['kind']) ?? 'task',
    session_id: r.session_id ?? null,
    deleted: !!r.deleted,
  };
}

/** Raw op-applier: materializes a TimeLog row with the standard LWW guard (matching
 *  upsertShare/upsertTag/upsertItemTag/upsertItemDep) — a stale replay whose
 *  `updated_at` isn't newer than what's stored is dropped rather than clobbering it. */
export function upsertTimeLog(db: Db, log: TimeLog): void {
  const existing = db.get<{ updated_at: string }>(
    'SELECT updated_at FROM time_logs WHERE id = ?',
    [log.id],
  );
  if (existing && existing.updated_at > log.updated_at) return;
  db.run(
    `INSERT INTO time_logs (id, item_id, user_id, start_time, end_time, note, created_at, updated_at, kind, session_id, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       start_time = excluded.start_time, end_time = excluded.end_time, note = excluded.note,
       updated_at = excluded.updated_at, kind = excluded.kind, session_id = excluded.session_id,
       deleted = excluded.deleted`,
    [
      log.id,
      log.item_id,
      log.user_id ?? null,
      log.start_time,
      log.end_time ?? null,
      log.note ?? null,
      log.created_at,
      log.updated_at,
      log.kind ?? 'task',
      log.session_id ?? null,
      log.deleted ? 1 : 0,
    ],
  );
}

export function deleteTimeLog(db: Db, deviceId: string, id: string): void {
  const r = db.get<TimeLogRow>('SELECT * FROM time_logs WHERE id = ?', [id]);
  if (!r) return;
  recordRecordOp(db, deviceId, 'timelog', id, {
    ...rowToTimeLog(r),
    deleted: true,
    updated_at: causalNowIso(db),
  });
}

/**
 * Create or edit a time log AND record it as a sync op. `upsertTimeLog` alone is the
 * raw op-applier — it materializes the row but records nothing, so edits made through
 * it never push and revert on the next inbound timelog op. Always use this from the UI.
 * Stamps a fresh `updated_at` from the causal clock, ignoring whatever the caller had
 * on `log` (mirrors shareItem/unshareItem/emitTag) so the LWW guard reflects this edit.
 */
export function saveTimeLog(db: Db, deviceId: string, log: TimeLog): TimeLog {
  const stamped: TimeLog = { ...log, updated_at: causalNowIso(db) };
  recordRecordOp(db, deviceId, 'timelog', stamped.id, stamped);
  return stamped;
}

export function getTimeLogs(db: Db, itemId: string): TimeLog[] {
  return db
    .all<TimeLogRow>(
      'SELECT * FROM time_logs WHERE item_id = ? AND deleted = 0 ORDER BY start_time DESC',
      [itemId],
    )
    .map(rowToTimeLog);
}

export function startTimer(
  db: Db,
  deviceId: string,
  itemId: string,
  userId: string | null,
): TimeLog {
  const now = new Date().toISOString();
  const log: TimeLog = {
    id: uuidv4(),
    item_id: itemId,
    user_id: userId,
    start_time: now,
    end_time: null,
    note: null,
    created_at: now,
    updated_at: causalNowIso(db),
    kind: 'task',
    session_id: null,
    deleted: false,
  };
  recordRecordOp(db, deviceId, 'timelog', log.id, log);
  return log;
}

export function stopTimer(db: Db, deviceId: string, logId: string): void {
  const r = db.get<TimeLogRow>('SELECT * FROM time_logs WHERE id = ?', [logId]);
  if (!r || r.end_time) return;
  const stopped: TimeLog = {
    ...rowToTimeLog(r),
    end_time: new Date().toISOString(),
    updated_at: causalNowIso(db),
  };
  recordRecordOp(db, deviceId, 'timelog', stopped.id, stopped);
}

/** The running (unfinished) timer, optionally for a specific user. */
export function getRunningTimer(db: Db, userId?: string | null): TimeLog | undefined {
  const row = userId
    ? db.get<TimeLogRow>(
        'SELECT * FROM time_logs WHERE end_time IS NULL AND user_id = ? ORDER BY start_time DESC LIMIT 1',
        [userId],
      )
    : db.get<TimeLogRow>(
        'SELECT * FROM time_logs WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1',
      );
  return row ? rowToTimeLog(row) : undefined;
}

// ----- shares & assignees (sync as records) ---------------------------------

const shareId = (itemId: string, userId: string) => `s:${itemId}:${userId}`;
const assigneeId = (itemId: string, userId: string) => `a:${itemId}:${userId}`;

interface ShareRow extends Row {
  id: string;
  item_id: string;
  user_id: string;
  permission: string;
  created_at: string;
  updated_at: string;
  deleted: number;
}
const rowToShare = (r: ShareRow): Share => ({
  id: r.id,
  item_id: r.item_id,
  user_id: r.user_id,
  permission: r.permission as Permission,
  created_at: r.created_at,
  updated_at: r.updated_at,
  deleted: !!r.deleted,
});

export function upsertShare(db: Db, s: Share): void {
  const existing = db.get<{ updated_at: string }>('SELECT updated_at FROM shares WHERE id = ?', [
    s.id,
  ]);
  if (existing && existing.updated_at > s.updated_at) return;
  db.run(
    `INSERT INTO shares (id, item_id, user_id, permission, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET permission = excluded.permission,
       updated_at = excluded.updated_at, deleted = excluded.deleted`,
    [s.id, s.item_id, s.user_id, s.permission ?? 'read', s.created_at, s.updated_at, s.deleted ? 1 : 0],
  );
}

export function listSharesForItem(db: Db, itemId: string): Share[] {
  return db
    .all<ShareRow>('SELECT * FROM shares WHERE item_id = ? AND deleted = 0', [itemId])
    .map(rowToShare);
}

export function shareItem(
  db: Db,
  deviceId: string,
  itemId: string,
  userId: string,
  permission: Permission,
): Share {
  const now = causalNowIso(db);
  const existing = db.get<ShareRow>('SELECT * FROM shares WHERE id = ?', [shareId(itemId, userId)]);
  const share: Share = {
    id: shareId(itemId, userId),
    item_id: itemId,
    user_id: userId,
    permission,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    deleted: false,
  };
  recordRecordOp(db, deviceId, 'share', share.id, share);
  return share;
}

export function unshareItem(db: Db, deviceId: string, itemId: string, userId: string): void {
  const existing = db.get<ShareRow>('SELECT * FROM shares WHERE id = ?', [shareId(itemId, userId)]);
  if (!existing) return;
  const tombstone: Share = { ...rowToShare(existing), deleted: true, updated_at: causalNowIso(db) };
  recordRecordOp(db, deviceId, 'share', tombstone.id, tombstone);
}

export interface EffectiveShare {
  user_id: string;
  permission: Permission;
  /** True when the share comes from an ancestor (not directly on this item). */
  inherited: boolean;
  /** The item the share is defined on. */
  source_id: string;
}

/** Shares in effect for an item: its own shares plus those inherited from
 *  ancestors. A direct share on the item overrides an inherited one. */
export function effectiveShares(db: Db, itemId: string): EffectiveShare[] {
  const map = new Map<string, EffectiveShare>();
  const seen = new Set<string>();
  let currentId: string | null = itemId;
  let depth = 0;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    for (const s of listSharesForItem(db, currentId)) {
      if (!map.has(s.user_id)) {
        map.set(s.user_id, {
          user_id: s.user_id,
          permission: s.permission,
          inherited: depth > 0,
          source_id: currentId,
        });
      }
    }
    currentId = getItem(db, currentId)?.parent_id ?? null;
    depth++;
  }
  return [...map.values()];
}

export function hasWriteAccess(db: Db, itemId: string, userId: string): boolean {
  if (getItem(db, itemId)?.owner_id === userId) return true;
  return effectiveShares(db, itemId).find((e) => e.user_id === userId)?.permission === 'write';
}

/** True if the user owns the item or has any effective share on it (read or write). */
export function hasReadAccess(db: Db, itemId: string, userId: string): boolean {
  if (getItem(db, itemId)?.owner_id === userId) return true;
  return effectiveShares(db, itemId).some((e) => e.user_id === userId);
}

interface AssigneeRow extends Row {
  id: string;
  item_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  deleted: number;
}
const rowToAssignee = (r: AssigneeRow): Assignee => ({
  id: r.id,
  item_id: r.item_id,
  user_id: r.user_id,
  created_at: r.created_at,
  updated_at: r.updated_at,
  deleted: !!r.deleted,
});

export function upsertAssignee(db: Db, a: Assignee): void {
  const existing = db.get<{ updated_at: string }>('SELECT updated_at FROM assignees WHERE id = ?', [
    a.id,
  ]);
  if (existing && existing.updated_at > a.updated_at) return;
  db.run(
    `INSERT INTO assignees (id, item_id, user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted`,
    [a.id, a.item_id, a.user_id, a.created_at, a.updated_at, a.deleted ? 1 : 0],
  );
}

export function listAssigneesForItem(db: Db, itemId: string): Assignee[] {
  return db
    .all<AssigneeRow>('SELECT * FROM assignees WHERE item_id = ? AND deleted = 0', [itemId])
    .map(rowToAssignee);
}

// ----- batch reads (enrichment fan-out) -------------------------------------
// One query for a whole set of items instead of one per item, so list / forecast
// / container rendering doesn't fan out into O(rows) round-trips. The comment /
// assignee variants also skip their query entirely when the table has no live
// rows (the common single-user case), turning N per-item lookups into one.

const inClause = (ids: string[]) => ids.map(() => '?').join(', ');

/** Ids in `itemIds` that have at least one non-deleted child. */
export function itemsWithChildren(db: Db, itemIds: string[]): Set<string> {
  const out = new Set<string>();
  if (itemIds.length === 0) return out;
  for (const r of db.all<{ parent_id: string }>(
    `SELECT DISTINCT parent_id FROM items WHERE deleted = 0 AND parent_id IN (${inClause(itemIds)})`,
    itemIds,
  )) {
    if (r.parent_id) out.add(r.parent_id);
  }
  return out;
}

/** Ids in `itemIds` that have at least one non-deleted comment. Empty set (no
 *  per-item query) when the comments table has no live rows. */
export function itemsWithComments(db: Db, itemIds: string[]): Set<string> {
  const out = new Set<string>();
  if (itemIds.length === 0 || !db.get('SELECT 1 AS x FROM comments WHERE deleted = 0 LIMIT 1')) {
    return out;
  }
  for (const r of db.all<{ item_id: string }>(
    `SELECT DISTINCT item_id FROM comments WHERE deleted = 0 AND item_id IN (${inClause(itemIds)})`,
    itemIds,
  )) {
    out.add(r.item_id);
  }
  return out;
}

/** Live tags for each of `itemIds`, keyed by item id (a missing key means the item
 *  has no tags). Mirrors {@link getItemTags} per item, in one query. */
export function getItemTagsBatch(db: Db, itemIds: string[]): Map<string, Tag[]> {
  const out = new Map<string, Tag[]>();
  if (itemIds.length === 0) return out;
  const rows = db.all<TagRow & { __item: string }>(
    `SELECT t.*, it.item_id AS __item FROM tags t
       JOIN item_tags it ON it.tag_id = t.id
      WHERE it.item_id IN (${inClause(itemIds)}) AND it.deleted = 0 AND t.deleted = 0
      ORDER BY t.name`,
    itemIds,
  );
  for (const r of rows) {
    const arr = out.get(r.__item);
    if (arr) arr.push(rowToTag(r));
    else out.set(r.__item, [rowToTag(r)]);
  }
  return out;
}

/** Live assignees for each of `itemIds`, keyed by item id. Empty map (no query)
 *  when no assignees exist. */
export function listAssigneesForItems(db: Db, itemIds: string[]): Map<string, Assignee[]> {
  const out = new Map<string, Assignee[]>();
  if (itemIds.length === 0 || !db.get('SELECT 1 AS x FROM assignees WHERE deleted = 0 LIMIT 1')) {
    return out;
  }
  for (const r of db.all<AssigneeRow>(
    `SELECT * FROM assignees WHERE deleted = 0 AND item_id IN (${inClause(itemIds)})`,
    itemIds,
  )) {
    const arr = out.get(r.item_id);
    if (arr) arr.push(rowToAssignee(r));
    else out.set(r.item_id, [rowToAssignee(r)]);
  }
  return out;
}

export function assignItem(db: Db, deviceId: string, itemId: string, userId: string): Assignee {
  const now = causalNowIso(db);
  const existing = db.get<AssigneeRow>('SELECT * FROM assignees WHERE id = ?', [
    assigneeId(itemId, userId),
  ]);
  const a: Assignee = {
    id: assigneeId(itemId, userId),
    item_id: itemId,
    user_id: userId,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    deleted: false,
  };
  recordRecordOp(db, deviceId, 'assignee', a.id, a);
  return a;
}

export function unassignItem(db: Db, deviceId: string, itemId: string, userId: string): void {
  const existing = db.get<AssigneeRow>('SELECT * FROM assignees WHERE id = ?', [
    assigneeId(itemId, userId),
  ]);
  if (!existing) return;
  const tombstone: Assignee = { ...rowToAssignee(existing), deleted: true, updated_at: causalNowIso(db) };
  recordRecordOp(db, deviceId, 'assignee', tombstone.id, tombstone);
}

// ----- comments (sync as records) -------------------------------------------

interface CommentRow extends Row {
  id: string;
  item_id: string;
  author_id: string | null;
  body: string;
  mentions: string | null;
  created_at: string;
  updated_at: string;
  deleted: number;
}
const rowToComment = (r: CommentRow): Comment => ({
  id: r.id,
  item_id: r.item_id,
  author_id: r.author_id,
  body: r.body,
  mentions: r.mentions ? (JSON.parse(r.mentions) as string[]) : [],
  created_at: r.created_at,
  updated_at: r.updated_at,
  deleted: !!r.deleted,
});

export function upsertComment(db: Db, c: Comment): void {
  const existing = db.get<{ updated_at: string }>('SELECT updated_at FROM comments WHERE id = ?', [
    c.id,
  ]);
  if (existing && existing.updated_at > c.updated_at) return;
  db.run(
    `INSERT INTO comments (id, item_id, author_id, body, mentions, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET body = excluded.body, mentions = excluded.mentions,
       updated_at = excluded.updated_at, deleted = excluded.deleted`,
    [
      c.id,
      c.item_id,
      c.author_id ?? null,
      c.body ?? '',
      JSON.stringify(c.mentions ?? []),
      c.created_at,
      c.updated_at,
      c.deleted ? 1 : 0,
    ],
  );
}

export function listComments(db: Db, itemId: string): Comment[] {
  return db
    .all<CommentRow>('SELECT * FROM comments WHERE item_id = ? AND deleted = 0 ORDER BY created_at', [
      itemId,
    ])
    .map(rowToComment);
}

export function addComment(
  db: Db,
  deviceId: string,
  input: { itemId: string; authorId: string | null; body: string; mentions?: string[] },
): Comment {
  const comment: Comment = {
    id: uuidv4(),
    item_id: input.itemId,
    author_id: input.authorId,
    body: input.body,
    mentions: input.mentions ?? [],
    created_at: new Date().toISOString(), // real time: drives display + ordering
    updated_at: causalNowIso(db), // causal: drives LWW merge (see Y2)
    deleted: false,
  };
  recordRecordOp(db, deviceId, 'comment', comment.id, comment);
  return comment;
}

export function deleteComment(db: Db, deviceId: string, id: string): void {
  const r = db.get<CommentRow>('SELECT * FROM comments WHERE id = ?', [id]);
  if (!r) return;
  const tombstone: Comment = {
    ...rowToComment(r),
    deleted: true,
    updated_at: causalNowIso(db),
  };
  recordRecordOp(db, deviceId, 'comment', tombstone.id, tombstone);
}

// ----- attachments (metadata syncs as records; blobs move out-of-band) ------

interface AttachmentRow extends Row {
  id: string;
  parent_type: string;
  parent_id: string;
  item_id: string;
  filename: string;
  mime_type: string | null;
  size: number;
  hash: string;
  created_by: string | null;
  created_at: string;
  deleted: number;
}
const rowToAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  parent_type: r.parent_type as AttachmentParent,
  parent_id: r.parent_id,
  item_id: r.item_id,
  filename: r.filename,
  mime_type: r.mime_type,
  size: r.size,
  hash: r.hash,
  created_by: r.created_by,
  created_at: r.created_at,
  deleted: !!r.deleted,
});

export function upsertAttachment(db: Db, a: Attachment): void {
  db.run(
    // Attachments are content-addressed and immutable apart from the `deleted` flag,
    // which is monotonic: once deleted it stays deleted. Without this, replaying a
    // stale create op (e.g. reapplyAllRecordOps in rowid order) after a newer
    // tombstone would resurrect a deleted attachment (M5).
    `INSERT INTO attachments (id, parent_type, parent_id, item_id, filename, mime_type, size, hash, created_by, created_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       deleted = CASE WHEN attachments.deleted = 1 THEN 1 ELSE excluded.deleted END`,
    // `?? null` for the nullable columns: attachment record-ops that predate the
    // item_id denormalization (schema v4) carry no item_id key, and a missing key
    // binds `undefined` — which sql.js rejects, wedging a fresh device's first
    // full sync on the first legacy attachment it pulls.
    [
      a.id,
      a.parent_type,
      a.parent_id,
      a.item_id ?? null,
      a.filename,
      a.mime_type ?? null,
      a.size ?? 0,
      a.hash,
      a.created_by ?? null,
      a.created_at,
      a.deleted ? 1 : 0,
    ],
  );
}

export function listAttachmentsFor(
  db: Db,
  parentType: AttachmentParent,
  parentId: string,
): Attachment[] {
  return db
    .all<AttachmentRow>(
      'SELECT * FROM attachments WHERE parent_type = ? AND parent_id = ? AND deleted = 0 ORDER BY created_at',
      [parentType, parentId],
    )
    .map(rowToAttachment);
}

export interface AddAttachmentInput {
  parentType: AttachmentParent;
  parentId: string;
  itemId: string;
  filename: string;
  mimeType: string | null;
  size: number;
  hash: string;
  createdBy: string | null;
}

export function addAttachment(db: Db, deviceId: string, input: AddAttachmentInput): Attachment {
  const a: Attachment = {
    id: uuidv4(),
    parent_type: input.parentType,
    parent_id: input.parentId,
    item_id: input.itemId,
    filename: input.filename,
    mime_type: input.mimeType,
    size: input.size,
    hash: input.hash,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    deleted: false,
  };
  recordRecordOp(db, deviceId, 'attachment', a.id, a);
  return a;
}

export function deleteAttachment(db: Db, deviceId: string, id: string): void {
  const r = db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', [id]);
  if (!r) return;
  recordRecordOp(db, deviceId, 'attachment', r.id, { ...rowToAttachment(r), deleted: true });
}

// ----- plan (Stage 2 — per-user curated focus list) -------------------------

interface PlanRow extends Row {
  id: string;
  user_id: string | null;
  item_id: string;
  added_at: string;
  deleted: number;
}

const rowToPlan = (r: PlanRow): Plan => ({
  id: r.id,
  user_id: r.user_id,
  item_id: r.item_id,
  added_at: r.added_at,
  deleted: !!r.deleted,
});

/** Deterministic id so the same (user, item) pair converges across devices. */
export const planId = (userId: string | null, itemId: string): string =>
  `p:${userId ?? 'local'}:${itemId}`;

export function upsertPlan(db: Db, plan: Plan): void {
  db.run(
    `INSERT INTO plan (id, user_id, item_id, added_at, deleted)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id, item_id = excluded.item_id,
       added_at = excluded.added_at, deleted = excluded.deleted`,
    [plan.id, plan.user_id ?? null, plan.item_id, plan.added_at, plan.deleted ? 1 : 0],
  );
}

export function addToPlan(db: Db, deviceId: string, userId: string | null, itemId: string): Plan {
  const existing = db.get<PlanRow>('SELECT * FROM plan WHERE id = ?', [planId(userId, itemId)]);
  const plan: Plan = {
    id: planId(userId, itemId),
    user_id: userId,
    item_id: itemId,
    added_at: existing && !existing.deleted ? existing.added_at : new Date().toISOString(),
    deleted: false,
  };
  recordRecordOp(db, deviceId, 'plan', plan.id, plan);
  return plan;
}

export function removeFromPlan(db: Db, deviceId: string, userId: string | null, itemId: string): void {
  const r = db.get<PlanRow>('SELECT * FROM plan WHERE id = ?', [planId(userId, itemId)]);
  if (!r || r.deleted) return;
  recordRecordOp(db, deviceId, 'plan', r.id, { ...rowToPlan(r), deleted: true });
}

export function isInPlan(db: Db, userId: string | null, itemId: string): boolean {
  const r = db.get<PlanRow>('SELECT deleted FROM plan WHERE id = ?', [planId(userId, itemId)]);
  return !!r && !r.deleted;
}

/** A user's plan entries (non-deleted), oldest first. */
export function listPlan(db: Db, userId: string | null): Plan[] {
  const rows = db.all<PlanRow>(
    `SELECT * FROM plan WHERE deleted = 0 AND ${userId === null ? 'user_id IS NULL' : 'user_id = ?'} ORDER BY added_at`,
    userId === null ? [] : [userId],
  );
  return rows.map(rowToPlan);
}

// ----- estimate-vs-actual stats ---------------------------------------------

/** Total tracked task-segment time for an item (ms), optionally one user's. */
export function taskActualMs(db: Db, itemId: string, userId?: string | null): number {
  const rows = db.all<{ start_time: string; end_time: string | null }>(
    `SELECT start_time, end_time FROM time_logs
     WHERE kind = 'task' AND deleted = 0 AND item_id = ?
     ${userId != null ? 'AND user_id = ?' : ''}`,
    userId != null ? [itemId, userId] : [itemId],
  );
  let ms = 0;
  for (const r of rows) {
    const end = r.end_time ? new Date(r.end_time).getTime() : Date.now();
    ms += Math.max(0, end - new Date(r.start_time).getTime());
  }
  return ms;
}

// ----- record-op log: record + apply + ingest -------------------------------

export function applyRecordOp(db: Db, op: RecordOp): void {
  switch (op.entity) {
    case 'share':
      return upsertShare(db, op.data as Share);
    case 'assignee':
      return upsertAssignee(db, op.data as Assignee);
    case 'comment':
      return upsertComment(db, op.data as Comment);
    case 'attachment':
      return upsertAttachment(db, op.data as Attachment);
    case 'timelog':
      return upsertTimeLog(db, op.data as TimeLog);
    case 'tag':
      return upsertTag(db, op.data as Tag);
    case 'item_tag':
      return upsertItemTag(db, op.data as ItemTag);
    case 'item_dep':
      return upsertItemDep(db, op.data as ItemDep);
    case 'user':
      return upsertUser(db, op.data as User);
    case 'plan':
      return upsertPlan(db, op.data as Plan);
  }
}

export function recordRecordOp(
  db: Db,
  deviceId: string,
  entity: string,
  rowId: string,
  data: unknown,
): RecordOp {
  const op: RecordOp = {
    id: uuidv4(),
    entity,
    row_id: rowId,
    ts: nextTs(db),
    device_id: deviceId,
    data,
  };
  insertRecordOp(db, op, false);
  applyRecordOp(db, op);
  return op;
}

/**
 * Re-apply every record-op already in the local log. Idempotent (per-row LWW), used
 * once after an upgrade to materialize ops that an older client stored but couldn't
 * apply because its applyRecordOp lacked that entity (e.g. tags/links added later).
 */
export function reapplyAllRecordOps(db: Db): void {
  const rows = db.all<{
    id: string;
    entity: string;
    row_id: string;
    ts: number;
    device_id: string;
    data: string;
  }>('SELECT id, entity, row_id, ts, device_id, data FROM record_ops ORDER BY rowid');
  for (const r of rows) {
    // A legacy-shaped op already in the local log must not abort startup (this
    // runs from initDb) — skip it, like ingestRecordOps does.
    try {
      applyRecordOp(db, {
        id: r.id,
        entity: r.entity,
        row_id: r.row_id,
        ts: Number(r.ts),
        device_id: r.device_id,
        data: JSON.parse(r.data),
      });
    } catch (e) {
      console.error(`[carbon] skipping unappliable ${r.entity} record-op ${r.id} on reapply:`, e);
    }
  }
}

export function ingestRecordOps(db: Db, ops: RecordOp[], markSynced: boolean): RecordOp[] {
  const fresh: RecordOp[] = [];
  db.transaction(() => {
    let maxTs = 0;
    for (const op of ops) {
      if (op.ts > maxTs) maxTs = op.ts;
      if (recordOpExists(db, op.id)) continue;
      // Mirror ingestOps: one malformed record-op (e.g. a legacy shape missing a
      // field the upsert binds) must not throw and roll back the batch — the sync
      // cursor never advances past it, so the device re-hits it every sync forever.
      try {
        insertRecordOp(db, op, markSynced);
        applyRecordOp(db, op);
      } catch (e) {
        console.error(`[carbon] skipping unappliable ${op.entity} record-op ${op.id}:`, e);
        continue;
      }
      fresh.push(op);
    }
    observeTs(db, maxTs);
  });
  return fresh;
}

/** Item ids a user may see: items they own, plus shared items and all their
 *  descendants. Used by the server to scope sync. */
/**
 * Tasks the user is directly shared on whose parent isn't visible to them — i.e.
 * shared sub-tasks that have no home in the user's own tree. These become the
 * entry points for a "Shared with me" surface. Shared projects are excluded (they
 * already appear in the projects list). The top-most shared item in a chain wins:
 * a shared child whose shared parent is also visible is not listed separately.
 */
/** Batch-fetch items by id (chunked `IN (...)`, matching `subtreeIds`'s pattern)
 *  instead of one `getItem` query per id — used by `sharedRoots` so it doesn't
 *  do up to two per-row lookups. */
function getItemsByIds(db: Db, ids: string[]): Map<string, Item> {
  const out = new Map<string, Item>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += SUBTREE_BATCH) {
    const chunk = unique.slice(i, i + SUBTREE_BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    for (const row of db.all<ItemRow>(`${SELECT} WHERE id IN (${placeholders})`, chunk)) {
      out.set(row.id, rowToItem(row));
    }
  }
  return out;
}

export function sharedRoots(db: Db, userId: string): Item[] {
  const rows = db.all<{ item_id: string }>(
    'SELECT DISTINCT item_id FROM shares WHERE user_id = ? AND deleted = 0',
    [userId],
  );
  const items = getItemsByIds(
    db,
    rows.map((r) => r.item_id),
  );
  const candidates: Item[] = [];
  for (const { item_id } of rows) {
    const it = items.get(item_id);
    if (!it || it.deleted) continue;
    if (it.owner_id === userId) continue; // mine — shown normally
    if (it.type !== 'task') continue; // shared projects appear in the projects list
    candidates.push(it);
  }
  // Batch-check parent existence (deleted or not — mirrors the old per-row
  // `getItem` presence check) instead of one lookup per candidate.
  const parentIds = candidates
    .map((it) => it.parent_id)
    .filter((id): id is string => id !== null && !items.has(id));
  const parents = getItemsByIds(db, parentIds);
  const parentExists = (id: string) => items.has(id) || parents.has(id);
  return candidates.filter((it) => !(it.parent_id && parentExists(it.parent_id)));
}

/**
 * Item ids the user has been granted (share or assignment auto-share) but whose
 * content is missing locally — e.g. access was granted after the device had already
 * synced past those items' ops. The client sends these so the server can backfill
 * the subtree regardless of sync cursor. Self-healing: empties once content arrives.
 */
export function missingSharedItemIds(db: Db, userId: string): string[] {
  const ids = db
    .all<{ item_id: string }>('SELECT DISTINCT item_id FROM shares WHERE user_id = ? AND deleted = 0', [
      userId,
    ])
    .map((r) => r.item_id);
  return ids.filter((id) => !db.get('SELECT 1 AS x FROM items WHERE id = ?', [id]));
}

/**
 * Of the given item ids, those that exist locally but are missing their creation op
 * (only a structural shell row exists). Happens when a previously-invisible item is
 * moved into a subtree we can see: we receive the parent-change op (which creates a
 * default shell) but its content ops are below our sync cursor. The client backfills
 * these; self-terminating — once the create op (carrying `type`) arrives, it's no
 * longer flagged, so it can't loop. A create op is the only op that sets `type`.
 */
export function itemsMissingCreate(db: Db, ids: string[]): string[] {
  return [...new Set(ids)].filter((id) => {
    if (!db.get('SELECT 1 AS x FROM items WHERE id = ?', [id])) return false;
    // A create op is the only op that carries the `type` field. Parse the ops rather
    // than substring-matching the JSON text, which could false-positive on a field
    // value that happens to contain `"type":` and then suppress a needed backfill (M6).
    const opRows = db.all<{ fields: string }>('SELECT fields FROM ops WHERE item_id = ?', [id]);
    const hasCreate = opRows.some((o) => {
      try {
        return 'type' in (JSON.parse(o.fields) as Record<string, unknown>);
      } catch {
        return false;
      }
    });
    return !hasCreate;
  });
}

/**
 * The set of item ids reachable by walking `parent_id` down from `roots`
 * (the roots themselves plus every descendant). A pure structural BFS over the
 * `items` tree — no ownership/share/deleted filtering (callers seed `roots` with
 * whatever they've already authorized). Shared by `visibleItemIds`, the `/sync`
 * backfill, and (later) per-link federation scope resolution.
 */
// SQLite's bound-parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER) varies by build;
// this keeps a single IN(...) well under any of them regardless of frontier size.
const SUBTREE_BATCH = 500;

export function subtreeIds(db: Db, roots: string[]): Set<string> {
  const set = new Set<string>();
  roots.forEach((id) => set.add(id));
  // Process one tree level at a time via a batched `IN (...)`, instead of one
  // query per descendant — collapses query count from O(descendants) to
  // O(depth × descendants/SUBTREE_BATCH), the dominant cost on deep/wide trees
  // (federation's subtree walks were the main caller feeling this).
  let frontier = roots;
  while (frontier.length) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += SUBTREE_BATCH) {
      const chunk = frontier.slice(i, i + SUBTREE_BATCH);
      const placeholders = chunk.map(() => '?').join(',');
      for (const k of db.all<{ id: string }>(
        `SELECT id FROM items WHERE parent_id IN (${placeholders})`,
        chunk,
      )) {
        if (!set.has(k.id)) {
          set.add(k.id);
          next.push(k.id);
        }
      }
    }
    frontier = next;
  }
  return set;
}

export function visibleItemIds(db: Db, userId: string): Set<string> {
  const set = new Set<string>();
  for (const r of db.all<{ id: string }>('SELECT id FROM items WHERE owner_id = ?', [userId])) {
    set.add(r.id);
  }
  const roots = db
    .all<{ item_id: string }>('SELECT item_id FROM shares WHERE user_id = ? AND deleted = 0', [
      userId,
    ])
    .map((r) => r.item_id);
  for (const id of subtreeIds(db, roots)) set.add(id);
  return set;
}
