import { randomUUID, randomBytes } from 'node:crypto';
import { type Db, createItem, setCompleted, type Item } from '@carbon/core';

// ----- system notices ("Carbon task" primitive) -----------------------------
//
// A reusable way for the server to speak to a user: it drops a task into the
// user's Inbox marked `sys_kind=<kind>` (so the web renders a "from Carbon"
// card) and records the actionable truth in a server-only `system_notices` row.
// Every subsystem that needs to notify a user (federation offers, billing
// issues, invoices, future platform messages) calls `createSystemNotice` rather
// than injecting an item directly — this is the shared spine, not a one-off.
//
// The item is the client-visible surface (it syncs via the op-log); this table
// is server-authoritative (never CRDT-synced) and is the generic dispatch point
// for acting on a notice.

export type NoticeState = 'pending' | 'accepted' | 'declined' | 'expired';

export interface SystemNotice {
  id: string;
  user_id: string;
  item_id: string;
  kind: string;
  state: NoticeState;
  /** JSON blob carrying the kind-specific payload (e.g. `{ actions }`). */
  payload_json: string | null;
  /** Random secret bound to this notice; a handler may require it out-of-band. */
  action_token: string;
  created_at: string;
  resolved_at: string | null;
}

interface NoticeRow {
  id: string;
  user_id: string;
  item_id: string;
  kind: string;
  state: string;
  payload_json: string | null;
  action_token: string;
  created_at: string;
  resolved_at: string | null;
}

function rowToNotice(r: NoticeRow): SystemNotice {
  return {
    id: r.id,
    user_id: r.user_id,
    item_id: r.item_id,
    kind: r.kind,
    state: r.state as NoticeState,
    payload_json: r.payload_json,
    action_token: r.action_token,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
  };
}

/** Server-only per-tenant table (not part of the synced core schema). */
export function ensureNoticeTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_notices (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      item_id      TEXT NOT NULL,
      kind         TEXT NOT NULL,
      state        TEXT NOT NULL,        -- pending | accepted | declined | expired
      payload_json TEXT,
      action_token TEXT,
      created_at   TEXT NOT NULL,
      resolved_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_system_notices_user ON system_notices(user_id);
    CREATE INDEX IF NOT EXISTS idx_system_notices_item ON system_notices(item_id);
  `);
}

// ----- kind dispatch registry (the reusable part) ---------------------------
//
// Adding a new notice kind = register a handler here (or from the subsystem that
// owns the kind, via `registerNoticeHandler`). No per-kind inbox-injection code.
// A handler decides how a user's action resolves a notice; returning a NoticeState
// (or nothing, to fall back to the default mapping) is enough for simple kinds.

/** The user-driven action on a notice. */
export type NoticeAction = 'accept' | 'decline' | 'dismiss' | string;

export interface NoticeHandlerResult {
  /** Terminal state to record; omit to use the default action→state mapping. */
  state?: NoticeState;
}

export type NoticeHandler = (
  db: Db,
  notice: SystemNotice,
  action: NoticeAction,
) => NoticeHandlerResult | void | Promise<NoticeHandlerResult | void>;

const HANDLERS = new Map<string, NoticeHandler>();

/** Register a handler for a notice `kind`. Later phases (e.g. `federation_offer`
 *  in Phase 2, `billing_issue`/`invoice`) plug in here without editing this file's
 *  core. */
export function registerNoticeHandler(kind: string, handler: NoticeHandler): void {
  HANDLERS.set(kind, handler);
}

/** Default action→state mapping used when no handler overrides it: `accept`
 *  accepts; everything else (decline/dismiss) declines. This is the generic
 *  "dismiss" capability every kind gets for free in Phase 0. */
function defaultState(action: NoticeAction): NoticeState {
  return action === 'accept' ? 'accepted' : 'declined';
}

// ----- CRUD + lifecycle -----------------------------------------------------

export interface CreateNoticeInput {
  kind: string;
  title: string;
  body?: string | null;
  /** Kind-specific action descriptors, serialized into `payload_json`. */
  actions?: unknown;
}

/**
 * Create a system notice for `userId`: an Inbox task (server-injected via the
 * same `createItem` path used elsewhere, marked `sys_kind=kind`) plus a pending
 * `system_notices` row. Returns both.
 */
export function createSystemNotice(
  db: Db,
  deviceId: string,
  userId: string,
  input: CreateNoticeInput,
): { item: Item; notice: SystemNotice } {
  // Inbox = type='task' && parent_id===null && active (see core perspectives).
  const item = createItem(db, deviceId, {
    type: 'task',
    parentId: null,
    ownerId: userId,
    title: input.title,
    note: input.body ?? null,
    sysKind: input.kind,
  });

  const now = new Date().toISOString();
  const notice: SystemNotice = {
    id: randomUUID(),
    user_id: userId,
    item_id: item.id,
    kind: input.kind,
    state: 'pending',
    payload_json:
      input.actions !== undefined ? JSON.stringify({ actions: input.actions }) : null,
    action_token: randomBytes(24).toString('hex'),
    created_at: now,
    resolved_at: null,
  };
  db.run(
    `INSERT INTO system_notices
       (id, user_id, item_id, kind, state, payload_json, action_token, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      notice.id,
      notice.user_id,
      notice.item_id,
      notice.kind,
      notice.state,
      notice.payload_json,
      notice.action_token,
      notice.created_at,
      notice.resolved_at,
    ],
  );
  return { item, notice };
}

export function getNotice(db: Db, id: string): SystemNotice | undefined {
  const row = db.get<NoticeRow>('SELECT * FROM system_notices WHERE id = ?', [id]);
  return row ? rowToNotice(row) : undefined;
}

/** This user's open (pending) notices, newest first. */
export function listOpenNotices(db: Db, userId: string): SystemNotice[] {
  return db
    .all<NoticeRow>(
      `SELECT * FROM system_notices WHERE user_id = ? AND state = 'pending'
       ORDER BY created_at DESC`,
      [userId],
    )
    .map(rowToNotice);
}

/**
 * Resolve a notice to a terminal state and tombstone its Inbox task. We mark the
 * item done (via the repo helper) rather than deleting it, so it leaves the Inbox
 * but stays in history. Idempotent for an already-resolved notice.
 */
export function resolveNotice(
  db: Db,
  deviceId: string,
  id: string,
  state: NoticeState,
): SystemNotice | undefined {
  const notice = getNotice(db, id);
  if (!notice) return undefined;
  const now = new Date().toISOString();
  db.run('UPDATE system_notices SET state = ?, resolved_at = ? WHERE id = ?', [
    state,
    now,
    id,
  ]);
  // Leaves the Inbox (type='task' && active) but stays in history.
  setCompleted(db, deviceId, notice.item_id, true);
  return getNotice(db, id);
}

/**
 * Apply a user action to a notice: dispatch to the kind's handler (if any),
 * otherwise fall back to the default action→state mapping, then resolve. The
 * caller must already have verified `notice.user_id` matches the session user.
 */
export async function actOnNotice(
  db: Db,
  deviceId: string,
  notice: SystemNotice,
  action: NoticeAction,
): Promise<SystemNotice | undefined> {
  const handler = HANDLERS.get(notice.kind);
  const result = handler ? await handler(db, notice, action) : undefined;
  const state = result?.state ?? defaultState(action);
  return resolveNotice(db, deviceId, notice.id, state);
}

// NOTE (Phase 2 seam): the `federation_offer` handler — which activates or
// tombstones the pending federation link on accept/decline — is registered here
// via `registerNoticeHandler('federation_offer', …)` when federation lands. It
// plugs in without touching the core above. Same for `billing_issue`/`invoice`.
