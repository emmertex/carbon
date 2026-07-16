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
  if (BOOLEAN_FIELDS.has(field) || typeof value === 'boolean') return value ? 1 : 0;
  // Legacy/foreign ops can carry decoded JSON (geo/alerts/recurrence) instead of the
  // string the column stores — serialize rather than hand the driver an unbindable
  // object (sql.js/better-sqlite3 both throw, which would wedge ingest forever).
  if (typeof value === 'object') return JSON.stringify(value);
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

  const fields = op.fields ?? {}; // a malformed op may carry null/missing fields
  for (const field of ITEM_PATCH_FIELDS) {
    if (!(field in fields)) continue;
    if (!wins(op.ts, op.device_id, clocks[field])) continue;
    setCols.push(`"${field}" = ?`);
    setVals.push(toStorage(field, fields[field]));
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
    [op.id, op.item_id, op.ts, op.device_id, JSON.stringify(op.fields ?? {}), synced ? 1 : 0],
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

// SQLite's bound-parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER) varies by build,
// and a first sync or bulk operation can mark thousands of ops in one call —
// chunk the IN(...) like repo.ts's SUBTREE_BATCH. Idempotent, so a failure
// between chunks just leaves a suffix unsynced for the server-deduped retry.
const MARK_SYNCED_BATCH = 500;

export function markOpsSynced(db: Db, ids: string[]): void {
  for (let i = 0; i < ids.length; i += MARK_SYNCED_BATCH) {
    const chunk = ids.slice(i, i + MARK_SYNCED_BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    db.run(`UPDATE ops SET synced = 1 WHERE id IN (${placeholders})`, chunk);
  }
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
      // A single malformed op (legacy shape, foreign client) must not throw here:
      // the transaction would roll back the whole batch, and because the sync
      // cursor only advances on success, every future sync would re-fetch and
      // re-hit the same op — permanently wedging the device. Skip it and converge
      // on everything else.
      try {
        insertOp(db, op, markSynced);
        applyOp(db, op);
      } catch (e) {
        console.error(`[carbon] skipping unappliable op ${op.id} (item ${op.item_id}):`, e);
        continue;
      }
      fresh.push(op);
    }
    // Advance our clock past everything in the batch so the next local edit wins.
    observeTs(db, maxTs);
  });
  return fresh;
}

// ----- compaction -----------------------------------------------------------
// Note bodies are stored as full-value `note` ops (one per editing burst). A 50 KB
// note edited hundreds of times bloats the append-only log while the items row stays
// one copy. Compaction prunes ops that can never affect any replica's converged
// state, so the log only carries live history.
//
// SAFETY ARGUMENT (why a pruned op can never change convergence):
//
//   We prune op L for item X iff ALL of:
//     (a) L's field set is EXACTLY {note} (no other fields — see below), AND
//     (b) there exists another op W for X whose fields include `note` and whose
//         (ts, device_id) strictly beats L's per LWW  (W is the retained winner), AND
//     (c) L is eligible per the bookkeeping predicate the caller supplies
//         (server: always; client: only synced=1 ops it has already pushed).
//
//   Per-field LWW (see `wins`/`applyOp`): once W is applied to a replica, the stored
//   clock for `note` is at W's (ts,dev) >= L's, so `wins(L)` is false forever after —
//   L cannot move `items.note` on ANY replica that has W. Deleting L is therefore
//   invisible to a replica that already has W.
//
//   A replica that does NOT yet have W: its pull cursor is a monotonic `ops.rowid`
//   high-water; it fetches `rowid > cursor`. Deleting rows never renumbers surviving
//   rowids, so `rowid > cursor` still returns the correct suffix (cursor monotonicity
//   preserved). Two cursor positions matter:
//
//   CRITICAL — rowid REUSE (not just renumbering): SQLite's `ops` table is a plain
//   rowid table (no AUTOINCREMENT). SQLite only ever reuses a rowid value when the row
//   holding the CURRENT MAX(rowid) is deleted — then the next INSERT reuses that freed
//   value instead of max+1. The retained winner W is chosen by LWW (ts, device_id),
//   which is NOT rowid order: rowid is server ARRIVAL order and diverges from ts under
//   cross-device clock skew, so a note-only LOSER can hold a higher rowid than W and be
//   the current MAX(rowid). Deleting that loser would free the top rowid; a later
//   INSERT of ANY op (any item) would reuse it, and every peer sitting at
//   cursor = that value would skip the reused op forever — permanent silent divergence.
//   GUARD: we never delete the row holding MAX(rowid) at compaction time (only prune
//   losers with rowid < current MAX(rowid)). With the physical top row always retained,
//   the next INSERT gets max+1 and no cursor can ever skip it. Costs at most one
//   un-pruned op per pass (it's pruned on the next pass once a newer op sits above it).
//   The key fact: W is never deleted (only losers are pruned), and rowid is purely
//   arrival order — it does NOT track ts, so rowid(W) can be *either side* of
//   rowid(L) under cross-device clock skew (see the rowid-reuse guard test, where a
//   loser sits at a higher rowid than the winner). That ordering doesn't matter:
//     - rowid(W) <= cursor: the replica already pulled and applied W (in whatever
//       order it arrived relative to L). Per-field LWW is commutative/idempotent, so
//       the materialized `note` is already W's value regardless of whether L's row
//       still physically exists.
//     - rowid(W) > cursor: the replica hasn't pulled W yet, but will — sync cursors
//       only move forward, W is never deleted, so a future pull is guaranteed to
//       fetch it and converge to W's value.
//   Either way the ONLY op that determines X.note is W, which we always retain. So a
//   pruned loser is dead weight on every replica, mid-pull or not — independent of
//   whether the replica had already pulled L.
//
//   WHY {note}-only (b): a multi-field op (e.g. a create carrying note + title +
//   status, or a note edit bundled with a flag change) may LOSE the `note` field to W
//   yet still WIN some other field on some replica. Deleting it would drop that other
//   field's only carrier. We refuse to prune (or rewrite) any op whose fields are not
//   exactly {note}. We chose the simplest provably-safe rule: prune ONLY ops whose
//   field set is precisely {note}. No note-field stripping / op rewriting is done.
//
//   WHY (c) — bookkeeping: on a CLIENT, an op with synced=0 has not reached the
//   server; deleting it would lose it entirely (the server, and thus all peers, would
//   never get it). So clients prune only synced=1 ops (already pushed/acked). The
//   SERVER is the convergence hub — every op it holds is durable there — so it may
//   prune any eligible loser; the winner it keeps is what every peer pulls. Federation
//   push cursors are also `ops.rowid` high-waters: deleting a not-yet-pushed loser is
//   safe for the same reason (the peer will receive W), and the MAX(rowid) guard below
//   protects federated peers from rowid reuse identically to regular clients.

/** True iff an op's field set is exactly {note} (the only ops we ever prune). */
function isNoteOnlyOp(fields: ItemPatch): boolean {
  const keys = Object.keys(fields);
  return keys.length === 1 && keys[0] === 'note';
}

export interface CompactOptions {
  /** Only prune ops already pushed to the server (synced=1). Clients MUST set this
   *  true; the server leaves it false (its ops are all durable at the hub). */
  syncedOnly?: boolean;
  /** Limit compaction to these item ids (e.g. freshly-pushed note items). */
  itemIds?: string[];
}

/**
 * Prune superseded note-only ops from the log. Returns the number of ops deleted.
 *
 * For each item, among ops whose fields are exactly {note} we keep the single LWW
 * winner (highest (ts, device_id)) and delete every older note-only op — but only if
 * that winner exists among the ops actually considered, so we never orphan a live
 * value. A multi-field op (even one carrying a newer note) is never deleted, and when
 * `syncedOnly` is set, unsynced ops are neither deleted NOR counted as the winner
 * (an unsynced op mustn't cause us to drop a synced one it might not durably replace).
 *
 * Safe by the argument above: a deleted op is a note-only LWW loser whose value can
 * never affect any replica's converged state, and deletion preserves rowid/cursor
 * monotonicity. The row holding the current MAX(rowid) is NEVER deleted, so SQLite can
 * never reuse a rowid a peer's pull cursor has already passed (see the header note).
 */
export function compactNoteOps(db: Db, opts: CompactOptions = {}): number {
  const syncedOnly = opts.syncedOnly ?? false;
  const itemIds = opts.itemIds ? [...new Set(opts.itemIds)] : null;
  if (itemIds && itemIds.length === 0) return 0;
  // The current top rowid must never be freed (SQLite would reuse it on the next
  // insert, and a peer at that cursor would skip the reused op). Losers at this rowid
  // are left for a later pass, once a newer op sits physically above them.
  const maxRowid =
    db.get<{ m: number | null }>('SELECT MAX(rowid) AS m FROM ops')?.m ?? 0;
  interface Row {
    rowid: number;
    id: string;
    item_id: string;
    ts: number;
    device_id: string;
    fields: string;
    synced: number;
  }
  const rows = itemIds
    ? db.all<Row>(
        `SELECT rowid, id, item_id, ts, device_id, fields, synced
         FROM ops
         WHERE item_id IN (${itemIds.map(() => '?').join(',')})
         ORDER BY item_id, ts`,
        itemIds,
      )
    : db.all<Row>(
        'SELECT rowid, id, item_id, ts, device_id, fields, synced FROM ops ORDER BY item_id, ts',
      );

  // Per item, keep the single LWW-winning note-only op and mark every other note-only
  // op for deletion. Multi-field ops are ignored entirely: never deleted, and never
  // treated as a winner here (we only ever remove note-only losers; the newest
  // note-only op per item is always retained as a conservative representative).
  // Winner selection is by LWW only — the max-rowid guard affects *physical deletion*,
  // never which op is retained as the logical winner, so it can't change convergence.
  const winners = new Map<string, { ts: number; dev: string; id: string; rowid: number }>();
  const candidates: { id: string; rowid: number }[] = [];
  for (const r of rows) {
    const fields = JSON.parse(r.fields) as ItemPatch;
    if (!isNoteOnlyOp(fields)) continue;
    // Under syncedOnly, an unsynced op is untouchable: don't delete it, and don't let
    // it stand as the winner that would license deleting a synced peer (it isn't
    // durable at the hub yet).
    if (syncedOnly && r.synced !== 1) continue;

    const cur = winners.get(r.item_id);
    if (!cur) {
      winners.set(r.item_id, { ts: r.ts, dev: r.device_id, id: r.id, rowid: r.rowid });
    } else if (wins(r.ts, r.device_id, { ts: cur.ts, dev: cur.dev })) {
      // r supersedes the incumbent → incumbent is a prunable loser.
      candidates.push({ id: cur.id, rowid: cur.rowid });
      winners.set(r.item_id, { ts: r.ts, dev: r.device_id, id: r.id, rowid: r.rowid });
    } else {
      // r loses to the retained winner → prunable.
      candidates.push({ id: r.id, rowid: r.rowid });
    }
  }

  // Never physically delete the row holding the current MAX(rowid): freeing it would
  // let SQLite reuse that rowid on the next insert, and a peer at that pull cursor
  // would skip the reused op forever (rowid reuse — see the header note). Such a loser
  // is simply retained this pass; it's pruned on a later pass once a newer op sits
  // physically above it. This never affects convergence (the retained winner is
  // unchanged) — only which dead rows are reclaimed now vs later.
  const toDelete = candidates.filter((c) => c.rowid < maxRowid).map((c) => c.id);

  if (toDelete.length === 0) return 0;
  const BATCH = 500;
  db.transaction(() => {
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const chunk = toDelete.slice(i, i + BATCH);
      const ph = chunk.map(() => '?').join(',');
      db.run(`DELETE FROM ops WHERE id IN (${ph})`, chunk);
    }
  });
  return toDelete.length;
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
    sys_kind: item.sys_kind,
    metadata: item.metadata,
    deleted: item.deleted,
  };
}
