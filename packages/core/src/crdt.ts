import { v4 as uuidv4 } from 'uuid';
import type { Db, SqlValue } from './db';
import type { Item, ItemPatch, Op } from './types';
import { ITEM_PATCH_FIELDS } from './types';

const BOOLEAN_FIELDS = new Set<keyof ItemPatch>(['flagged', 'deleted']);

type Clock = { ts: number; dev: string };
type ClockMap = Record<string, Clock>;

// ----- causal clock ---------------------------------------------------------
// Op timestamps drive per-field LWW. Raw Date.now() is unsafe across devices: a
// peer whose wall clock runs fast stamps ops in the "future", so a genuinely later
// edit from a slower device loses and is silently dropped (e.g. a create op with
// note=null clobbering a note added afterwards). We keep a persistent per-instance
// clock that never goes backwards and always exceeds any timestamp we've observed,
// so an edit made after seeing another op always wins. (A monotonic Lamport/HLC
// hybrid; ties across devices still break on device_id.)

const CLOCK_KEY = 'op_clock';

function readClock(db: Db): number {
  const r = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [CLOCK_KEY]);
  return r ? Number(r.value) : 0;
}
function writeClock(db: Db, v: number): void {
  db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [CLOCK_KEY, String(v)],
  );
}

/** Timestamp for a new local op: max(wall clock, last issued + 1). Monotonic and
 *  ahead of everything this instance has seen, so later edits win LWW under skew. */
export function nextTs(db: Db): number {
  const ts = Math.max(Date.now(), readClock(db) + 1);
  writeClock(db, ts);
  return ts;
}

/** Advance the clock past a peer timestamp we just received. */
export function observeTs(db: Db, ts: number): void {
  if (Number.isFinite(ts) && ts > readClock(db)) writeClock(db, ts);
}

/**
 * An ISO `updated_at` stamp drawn from the causal clock (not raw wall clock).
 * Record-entity LWW (shares/assignees/comments) compares `updated_at` strings; using
 * the causal clock makes that comparison skew-aware in the same way the item op-log
 * already is — so an unshare made *after* observing a share wins, instead of losing to
 * a peer with a fast wall clock (tombstone resurrection). ISO 8601 sorts
 * lexicographically = chronologically, so string comparison stays correct.
 */
export function causalNowIso(db: Db): string {
  return new Date(nextTs(db)).toISOString();
}

function toStorage(field: keyof ItemPatch, value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (BOOLEAN_FIELDS.has(field)) return value ? 1 : 0;
  return value as SqlValue;
}

/** True if op (ts, dev) beats the stored clock for a field. Equal => not newer
 *  (keeps re-applying the same op idempotent). */
function wins(opTs: number, opDev: string, clock: Clock | undefined): boolean {
  if (!clock) return true;
  if (opTs !== clock.ts) return opTs > clock.ts;
  return opDev > clock.dev;
}

/**
 * Apply one op to the materialized `items` table using per-field last-write-wins.
 * Idempotent: applying the same op twice is a no-op. Safe to call for ops that
 * arrive before the item's first op (a default row is created on demand).
 */
export function applyOp(db: Db, op: Op): void {
  const existing = db.get<{ clocks: string }>(
    'SELECT clocks FROM items WHERE id = ?',
    [op.item_id],
  );
  const nowIso = new Date(op.ts).toISOString();

  if (!existing) {
    // Create a default shell; the op's fields then win against empty clocks.
    db.run(
      `INSERT INTO items (id, type, title, status, created_at, updated_at, clocks)
       VALUES (?, 'task', '', 'active', ?, ?, '{}')`,
      [op.item_id, nowIso, nowIso],
    );
  }

  const clocks: ClockMap = JSON.parse(
    existing?.clocks ?? '{}',
  ) as ClockMap;

  const setCols: string[] = [];
  const setVals: SqlValue[] = [];

  for (const field of ITEM_PATCH_FIELDS) {
    if (!(field in op.fields)) continue;
    if (!wins(op.ts, op.device_id, clocks[field])) continue;
    setCols.push(`"${field}" = ?`);
    setVals.push(toStorage(field, op.fields[field]));
    clocks[field] = { ts: op.ts, dev: op.device_id };
  }

  if (setCols.length === 0 && existing) return; // nothing newer to apply

  setCols.push('clocks = ?');
  setVals.push(JSON.stringify(clocks));
  setCols.push('updated_at = ?');
  setVals.push(nowIso);
  setVals.push(op.item_id);

  db.run(`UPDATE items SET ${setCols.join(', ')} WHERE id = ?`, setVals);
}

/** Persist an op into the log (synced=0) and apply it locally. */
export function recordOp(
  db: Db,
  deviceId: string,
  itemId: string,
  fields: ItemPatch,
): Op {
  const op: Op = {
    id: uuidv4(),
    item_id: itemId,
    ts: nextTs(db),
    device_id: deviceId,
    fields,
  };
  insertOp(db, op, false);
  applyOp(db, op);
  return op;
}

/** Insert an op row without applying it (used when ingesting remote ops, which
 *  are applied separately). `synced` marks server-originated/acknowledged ops. */
export function insertOp(db: Db, op: Op, synced: boolean): void {
  db.run(
    `INSERT INTO ops (id, item_id, ts, device_id, fields, synced)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [op.id, op.item_id, op.ts, op.device_id, JSON.stringify(op.fields), synced ? 1 : 0],
  );
}

interface OpRow {
  id: string;
  item_id: string;
  ts: number;
  device_id: string;
  fields: string;
}

function rowToOp(row: OpRow): Op {
  return {
    id: row.id,
    item_id: row.item_id,
    ts: Number(row.ts),
    device_id: row.device_id,
    fields: JSON.parse(row.fields) as ItemPatch,
  };
}

/** Ops not yet pushed to the server (client side). */
export function getUnsyncedOps(db: Db): Op[] {
  return db
    .all<OpRow>('SELECT id, item_id, ts, device_id, fields FROM ops WHERE synced = 0 ORDER BY ts')
    .map(rowToOp);
}

export function markOpsSynced(db: Db, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.run(`UPDATE ops SET synced = 1 WHERE id IN (${placeholders})`, ids);
}

/** All ops with ts strictly greater than `sinceTs` (server side: serve to peers). */
export function getOpsSince(db: Db, sinceTs: number): Op[] {
  return db
    .all<OpRow>(
      'SELECT id, item_id, ts, device_id, fields FROM ops WHERE ts > ? ORDER BY ts',
      [sinceTs],
    )
    .map(rowToOp);
}

/**
 * Ingest a batch of remote ops: store any new ones and apply them. Returns the
 * ops that were genuinely new (not already in the log).
 */
export function ingestOps(db: Db, ops: Op[], markSynced: boolean): Op[] {
  const fresh: Op[] = [];
  db.transaction(() => {
    let maxTs = 0;
    for (const op of ops) {
      if (op.ts > maxTs) maxTs = op.ts;
      const seen = db.get('SELECT 1 AS x FROM ops WHERE id = ?', [op.id]);
      if (seen) continue;
      insertOp(db, op, markSynced);
      applyOp(db, op);
      fresh.push(op);
    }
    // Advance our clock past everything in the batch so the next local edit wins.
    observeTs(db, maxTs);
  });
  return fresh;
}

/** The full create-patch for a new item (all the fields a creation op carries). */
export function createPatch(item: Item): ItemPatch {
  return {
    parent_id: item.parent_id,
    type: item.type,
    owner_id: item.owner_id,
    title: item.title,
    note: item.note,
    status: item.status,
    flagged: item.flagged,
    priority: item.priority,
    defer_date: item.defer_date,
    due_date: item.due_date,
    reminder_at: item.reminder_at,
    estimate_minutes: item.estimate_minutes,
    completed_at: item.completed_at,
    review_interval: item.review_interval,
    reviewed_at: item.reviewed_at,
    recurrence: item.recurrence,
    geo: item.geo,
    color: item.color,
    folder_id: item.folder_id,
    sort_order: item.sort_order,
    order_mode: item.order_mode,
    deleted: item.deleted,
  };
}
