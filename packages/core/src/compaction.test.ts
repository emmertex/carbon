import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { insertOp, applyOp, compactNoteOps } from './crdt';
import { getItem } from './repo';
import type { Op } from './types';

let seq = 0;
const op = (over: Partial<Op> & { item_id: string }): Op => ({
  id: `op-${++seq}`,
  ts: 1000,
  device_id: 'dev-a',
  fields: {},
  ...over,
});

/** Ids currently in the log, in rowid order (insertion order). */
function opIds(db: ReturnType<typeof openMemoryDb>): string[] {
  return db
    .all<{ id: string }>('SELECT id FROM ops ORDER BY rowid')
    .map((r) => r.id);
}

/** Replay every op remaining in the log into a *fresh* DB, in rowid order, and
 *  return the converged note for an item. This is the ground truth: what a peer
 *  that pulls the (post-compaction) log from scratch would materialize. */
function convergedNote(db: ReturnType<typeof openMemoryDb>, itemId: string): string | null {
  const fresh = openMemoryDb();
  const rows = db.all<{
    id: string;
    item_id: string;
    ts: number;
    device_id: string;
    fields: string;
    synced: number;
  }>('SELECT id, item_id, ts, device_id, fields, synced FROM ops ORDER BY rowid');
  for (const r of rows) {
    const o: Op = {
      id: r.id,
      item_id: r.item_id,
      ts: Number(r.ts),
      device_id: r.device_id,
      fields: JSON.parse(r.fields),
    };
    insertOp(fresh, o, true);
    applyOp(fresh, o);
  }
  return getItem(fresh, itemId)?.note ?? null;
}

/** Insert an op into the log AND apply it, mirroring server/client ingest. */
function ingest(db: ReturnType<typeof openMemoryDb>, o: Op, synced = true): void {
  insertOp(db, o, synced);
  applyOp(db, o);
}

test('superseded note-only ops are pruned; newest retained; converged note unchanged', () => {
  const db = openMemoryDb();
  const id = 'item-1';
  // A create op (multi-field) then a series of note-only edits, ascending ts.
  ingest(db, op({ item_id: id, ts: 100, fields: { type: 'note', title: 'T', note: 'v0' } }));
  const e1 = op({ item_id: id, ts: 200, fields: { note: 'v1' } });
  const e2 = op({ item_id: id, ts: 300, fields: { note: 'v2' } });
  const e3 = op({ item_id: id, ts: 400, fields: { note: 'v3' } });
  ingest(db, e1);
  ingest(db, e2);
  ingest(db, e3);

  assert.equal(getItem(db, id)?.note, 'v3');
  const before = convergedNote(db, id);

  const removed = compactNoteOps(db);
  // e1 and e2 are note-only losers to e3; the create op is multi-field (kept).
  assert.equal(removed, 2);
  const ids = opIds(db);
  assert.ok(!ids.includes(e1.id), 'e1 pruned');
  assert.ok(!ids.includes(e2.id), 'e2 pruned');
  assert.ok(ids.includes(e3.id), 'newest note op retained');

  // Materialized value and from-scratch convergence both unchanged.
  assert.equal(getItem(db, id)?.note, 'v3');
  assert.equal(convergedNote(db, id), 'v3');
  assert.equal(convergedNote(db, id), before);
});

test('a note op bundled with other fields is NEVER pruned', () => {
  const db = openMemoryDb();
  const id = 'item-2';
  ingest(db, op({ item_id: id, ts: 100, fields: { type: 'note', title: 'T', note: 'a' } }));
  // A multi-field op that ALSO carries note — older than the winner but multi-field.
  const multi = op({ item_id: id, ts: 200, fields: { note: 'b', flagged: true } });
  const newest = op({ item_id: id, ts: 300, fields: { note: 'c' } });
  ingest(db, multi);
  ingest(db, newest);

  const removed = compactNoteOps(db);
  assert.equal(removed, 0, 'nothing prunable: no note-only loser');
  assert.ok(opIds(db).includes(multi.id), 'multi-field op retained even though it loses note');
  // Its non-note field must survive: flagged=true still materializes.
  assert.equal(getItem(db, id)?.flagged, true);
  assert.equal(getItem(db, id)?.note, 'c');
});

test('a note-only op newer than a multi-field note op is pruned only against note-only peers', () => {
  const db = openMemoryDb();
  const id = 'item-2b';
  const multi = op({ item_id: id, ts: 200, fields: { note: 'b', title: 'X' } });
  const n1 = op({ item_id: id, ts: 300, fields: { note: 'c' } });
  const n2 = op({ item_id: id, ts: 400, fields: { note: 'd' } });
  ingest(db, multi);
  ingest(db, n1);
  ingest(db, n2);

  const removed = compactNoteOps(db);
  assert.equal(removed, 1, 'only n1 (note-only loser to n2) is pruned');
  const ids = opIds(db);
  assert.ok(ids.includes(multi.id), 'multi-field kept');
  assert.ok(!ids.includes(n1.id), 'n1 pruned');
  assert.ok(ids.includes(n2.id), 'n2 retained');
  assert.equal(convergedNote(db, id), 'd');
});

test('syncedOnly: an unsynced op is NOT pruned and does not license pruning a synced peer', () => {
  const db = openMemoryDb();
  const id = 'item-3';
  // synced winner-candidate, then an UNSYNCED newer edit not yet pushed.
  const s1 = op({ item_id: id, ts: 100, fields: { type: 'note', note: 'v0' } });
  ingest(db, s1, true); // multi-field create anyway (type+note) — irrelevant, kept
  const s2 = op({ item_id: id, ts: 200, fields: { note: 'synced' } });
  ingest(db, s2, true);
  const u3 = op({ item_id: id, ts: 300, fields: { note: 'local-unpushed' } });
  ingest(db, u3, false); // synced=0

  const removed = compactNoteOps(db, { syncedOnly: true });
  // Under syncedOnly, u3 is invisible to compaction: s2 is the only *synced* note-only
  // op, so it's the retained winner and nothing is pruned (u3 must not cause s2's
  // deletion — s2 is what a peer would need if u3 never durably lands).
  assert.equal(removed, 0);
  const ids = opIds(db);
  assert.ok(ids.includes(s2.id), 'synced op retained (unsynced peer cannot license its deletion)');
  assert.ok(ids.includes(u3.id), 'unsynced op never pruned');
});

test('syncedOnly: two synced note-only losers ARE pruned even with an unsynced newest', () => {
  const db = openMemoryDb();
  const id = 'item-3b';
  ingest(db, op({ item_id: id, ts: 100, fields: { type: 'note', title: 'T' } }), true);
  const s1 = op({ item_id: id, ts: 200, fields: { note: 's1' } });
  const s2 = op({ item_id: id, ts: 300, fields: { note: 's2' } });
  const u3 = op({ item_id: id, ts: 400, fields: { note: 'local' } });
  ingest(db, s1, true);
  ingest(db, s2, true);
  ingest(db, u3, false);

  const removed = compactNoteOps(db, { syncedOnly: true });
  assert.equal(removed, 1, 'only s1 pruned; s2 retained as synced winner; u3 untouched');
  const ids = opIds(db);
  assert.ok(!ids.includes(s1.id));
  assert.ok(ids.includes(s2.id));
  assert.ok(ids.includes(u3.id));
  // Materialized value still reflects the unsynced local edit.
  assert.equal(getItem(db, id)?.note, 'local');
});

test('pull-cursor monotonicity: a peer mid-pull converges after low-rowid ops are pruned', () => {
  // Simulate the server log. A peer sits at cursor = rowid of an early op, having
  // pulled some but not all note ops. Compaction removes low-rowid losers; the peer
  // then pulls the remaining suffix (rowid > cursor) and must converge to the winner.
  const server = openMemoryDb();
  const id = 'item-4';
  ingest(server, op({ item_id: id, ts: 100, fields: { type: 'note', title: 'T', note: 'v0' } }));
  const e1 = op({ item_id: id, ts: 200, fields: { note: 'v1' } });
  const e2 = op({ item_id: id, ts: 300, fields: { note: 'v2' } });
  const e3 = op({ item_id: id, ts: 400, fields: { note: 'v3' } });
  ingest(server, e1);
  ingest(server, e2);
  ingest(server, e3);

  // Peer pulls rowid > 0 up to e1 only, then stops mid-stream.
  const peer = openMemoryDb();
  const rowOf = (opId: string) =>
    server.get<{ rowid: number }>('SELECT rowid FROM ops WHERE id = ?', [opId])!.rowid;
  const pullUpTo = (from: number, toRowid: number): number => {
    const rows = server.all<{
      seq: number;
      id: string;
      item_id: string;
      ts: number;
      device_id: string;
      fields: string;
    }>(
      'SELECT rowid AS seq, id, item_id, ts, device_id, fields FROM ops WHERE rowid > ? AND rowid <= ? ORDER BY rowid',
      [from, toRowid],
    );
    let cursor = from;
    for (const r of rows) {
      cursor = r.seq;
      const o: Op = {
        id: r.id,
        item_id: r.item_id,
        ts: Number(r.ts),
        device_id: r.device_id,
        fields: JSON.parse(r.fields),
      };
      insertOp(peer, o, true);
      applyOp(peer, o);
    }
    return cursor;
  };

  let cursor = pullUpTo(0, rowOf(e1.id)); // peer now has v0, v1; cursor at rowid(e1)
  assert.equal(getItem(peer, id)?.note, 'v1');

  // Server compacts while the peer is paused. e1, e2 are pruned (losers to e3).
  const removed = compactNoteOps(server);
  assert.equal(removed, 2);

  // Peer resumes: pulls rowid > cursor. e2 is gone; e3 survives at its original rowid
  // (deletions never renumber surviving rowids), so rowid(e3) > cursor still holds.
  const maxRow = server.get<{ m: number }>('SELECT MAX(rowid) AS m FROM ops')!.m;
  pullUpTo(cursor, maxRow);
  assert.equal(getItem(peer, id)?.note, 'v3', 'peer converges to the winner after resuming');

  // And a peer that pulls the whole compacted log from scratch converges identically.
  assert.equal(convergedNote(server, id), 'v3');
});

test('multi-item: pruning is per-item and never crosses items', () => {
  const db = openMemoryDb();
  ingest(db, op({ item_id: 'A', ts: 100, fields: { type: 'note', note: 'a0' } }));
  ingest(db, op({ item_id: 'B', ts: 110, fields: { type: 'note', note: 'b0' } }));
  const a1 = op({ item_id: 'A', ts: 200, fields: { note: 'a1' } });
  const a2 = op({ item_id: 'A', ts: 300, fields: { note: 'a2' } });
  const b1 = op({ item_id: 'B', ts: 250, fields: { note: 'b1' } });
  ingest(db, a1);
  ingest(db, a2);
  ingest(db, b1);

  const removed = compactNoteOps(db);
  assert.equal(removed, 1, 'only A.a1 (loser to A.a2) pruned; B has a single note-only op');
  const ids = opIds(db);
  assert.ok(!ids.includes(a1.id));
  assert.ok(ids.includes(a2.id));
  assert.ok(ids.includes(b1.id));
  assert.equal(convergedNote(db, 'A'), 'a2');
  assert.equal(convergedNote(db, 'B'), 'b1');
});

test('itemIds scope: compaction only scans the targeted note items', () => {
  const db = openMemoryDb();
  ingest(db, op({ item_id: 'A', ts: 100, fields: { type: 'note', note: 'a0' } }));
  ingest(db, op({ item_id: 'B', ts: 110, fields: { type: 'note', note: 'b0' } }));
  const a1 = op({ item_id: 'A', ts: 200, fields: { note: 'a1' } });
  const a2 = op({ item_id: 'A', ts: 300, fields: { note: 'a2' } });
  const b1 = op({ item_id: 'B', ts: 250, fields: { note: 'b1' } });
  ingest(db, a1);
  ingest(db, a2);
  ingest(db, b1);

  const removed = compactNoteOps(db, { itemIds: ['A'] });
  assert.equal(removed, 1, 'A.a1 pruned while B history stays untouched');
  const ids = opIds(db);
  assert.ok(!ids.includes(a1.id));
  assert.ok(ids.includes(a2.id));
  assert.ok(ids.includes(b1.id));
  assert.equal(convergedNote(db, 'A'), 'a2');
  assert.equal(convergedNote(db, 'B'), 'b1');
});

test('rowid REUSE guard: winner has a LOWER rowid than a max-rowid loser; a later op is not skipped', () => {
  // The winner is chosen by LWW (ts, device_id), NOT by rowid. Under clock skew a
  // note-only LOSER can arrive later (higher rowid) than the winner and sit at
  // MAX(rowid). If compaction deleted that max-rowid loser, SQLite would reuse its
  // rowid on the next insert and any peer parked at that cursor would skip the reused
  // op forever. The MAX(rowid) guard must retain that row.
  const server = openMemoryDb();
  const id = 'item-6';
  // W arrives FIRST (rowid 1) with the HIGHER ts=400 → the LWW winner.
  const w = op({ item_id: id, ts: 400, device_id: 'a', fields: { note: 'winner' } });
  // L arrives SECOND (rowid 2 = MAX) with a LOWER ts=300 → a note-only loser at max rowid.
  const l = op({ item_id: id, ts: 300, device_id: 'a', fields: { note: 'loser' } });
  ingest(server, w);
  ingest(server, l);
  assert.equal(getItem(server, id)?.note, 'winner', 'W wins LWW despite lower rowid');

  const rowOf = (opId: string) =>
    server.get<{ rowid: number }>('SELECT rowid FROM ops WHERE id = ?', [opId])!.rowid;
  assert.ok(rowOf(l.id) > rowOf(w.id), 'loser holds the higher (max) rowid');

  // A peer pulls everything → its cursor is MAX(rowid) at this moment.
  const oldCursor = server.get<{ m: number }>('SELECT MAX(rowid) AS m FROM ops')!.m;
  assert.equal(oldCursor, rowOf(l.id));

  // Compact. The loser L is at MAX(rowid), so the guard must NOT delete it (0 removed).
  const removed = compactNoteOps(server);
  assert.equal(removed, 0, 'max-rowid loser is retained this pass (rowid-reuse guard)');
  assert.ok(
    server.get('SELECT 1 FROM ops WHERE id = ?', [l.id]),
    'the max-rowid row still physically exists',
  );

  // A brand-new op on ANY item is pushed after compaction.
  const n = op({ item_id: 'other', ts: 500, device_id: 'a', fields: { title: 'new' } });
  ingest(server, n);
  // Because the max rowid was never freed, the new op gets a rowid ABOVE oldCursor.
  assert.ok(rowOf(n.id) > oldCursor, 'new op sits above the old cursor — no rowid reuse');

  // The parked peer polls `rowid > oldCursor` and MUST receive the new op.
  const delivered = server
    .all<{ id: string }>('SELECT id FROM ops WHERE rowid > ? ORDER BY rowid', [oldCursor])
    .map((r) => r.id);
  assert.ok(delivered.includes(n.id), 'peer at the old cursor still receives the new op');

  // And once a newer op sits physically above L, the next compaction pass reclaims L.
  const removed2 = compactNoteOps(server);
  assert.equal(removed2, 1, 'loser reclaimed on the next pass');
  assert.ok(!server.get('SELECT 1 FROM ops WHERE id = ?', [l.id]), 'loser now pruned');
  assert.equal(getItem(server, id)?.note, 'winner');
  assert.equal(convergedNote(server, id), 'winner');
});

test('rowid REUSE guard: max-rowid loser under syncedOnly is also retained', () => {
  const db = openMemoryDb();
  const id = 'item-6b';
  const w = op({ item_id: id, ts: 400, fields: { note: 'winner' } });
  const l = op({ item_id: id, ts: 300, fields: { note: 'loser' } });
  ingest(db, w, true);
  ingest(db, l, true); // synced, and at max rowid
  const removed = compactNoteOps(db, { syncedOnly: true });
  assert.equal(removed, 0, 'guard applies uniformly (client path too)');
  assert.ok(db.get('SELECT 1 FROM ops WHERE id = ?', [l.id]));
});

test('device-id tiebreak: equal ts, lower device_id loses and is pruned', () => {
  const db = openMemoryDb();
  const id = 'item-5';
  const lo = op({ item_id: id, ts: 500, device_id: 'a', fields: { note: 'lo' } });
  const hi = op({ item_id: id, ts: 500, device_id: 'z', fields: { note: 'hi' } });
  ingest(db, lo);
  ingest(db, hi);
  assert.equal(getItem(db, id)?.note, 'hi', 'z wins the tie');

  const removed = compactNoteOps(db);
  assert.equal(removed, 1);
  assert.ok(!opIds(db).includes(lo.id), 'lower device_id loser pruned');
  assert.ok(opIds(db).includes(hi.id));
  assert.equal(convergedNote(db, id), 'hi');
});

test('itemIds: [] is a documented no-op (nothing scanned, nothing pruned)', () => {
  const db = openMemoryDb();
  const id = 'item-7';
  ingest(db, op({ item_id: id, ts: 100, fields: { note: 'a' } }));
  ingest(db, op({ item_id: id, ts: 200, fields: { note: 'b' } }));
  const removed = compactNoteOps(db, { itemIds: [] });
  assert.equal(removed, 0);
  assert.equal(opIds(db).length, 2, 'both ops are still physically present');
});

test('a clear-then-reset cycle ({note:null} then {note:"b"}) compacts safely to the latest value', () => {
  // A realistic autosave pattern: the field is cleared (note-only op with a null value —
  // isNoteOnlyOp only checks the key set, so {note: null} is just as prunable as any other
  // note-only op) and later reset. Compaction must still converge on the final value.
  const db = openMemoryDb();
  const id = 'item-8';
  const a = op({ item_id: id, ts: 100, fields: { note: 'a' } });
  const clear = op({ item_id: id, ts: 200, fields: { note: null } });
  const b = op({ item_id: id, ts: 300, fields: { note: 'b' } });
  ingest(db, a);
  ingest(db, clear);
  ingest(db, b);
  assert.equal(getItem(db, id)?.note, 'b');

  const removed = compactNoteOps(db);
  assert.equal(removed, 2, 'a and the null-clear are both note-only losers to b');
  assert.ok(!opIds(db).includes(a.id));
  assert.ok(!opIds(db).includes(clear.id));
  assert.ok(opIds(db).includes(b.id));
  assert.equal(getItem(db, id)?.note, 'b');
  assert.equal(convergedNote(db, id), 'b', 'a peer replaying from scratch still converges on b');
});

test('compaction on a tombstoned (deleted) item leaves the deleted flag and note value intact', () => {
  // A soft-deleted note may still carry a long note-op history. LWW on `note` is
  // independent of `deleted` (they're separate fields with separate clocks), so pruning
  // note-only losers must not disturb the item's tombstone state.
  const db = openMemoryDb();
  const id = 'item-9';
  ingest(db, op({ item_id: id, ts: 100, fields: { type: 'note', title: 'T', note: 'v0' } }));
  const e1 = op({ item_id: id, ts: 200, fields: { note: 'v1' } });
  const e2 = op({ item_id: id, ts: 300, fields: { note: 'v2' } });
  ingest(db, e1);
  ingest(db, e2);
  // Deleted via a separate multi-field-shaped op (still just {deleted:true} — one field,
  // but not `note`, so isNoteOnlyOp is false and it's never a compaction candidate).
  ingest(db, op({ item_id: id, ts: 400, fields: { deleted: true } }));

  const removed = compactNoteOps(db);
  assert.equal(removed, 1, 'only e1 (loser to e2) is pruned; the delete op is untouched');
  assert.ok(!opIds(db).includes(e1.id));
  assert.ok(opIds(db).includes(e2.id));

  const after = getItem(db, id)!;
  assert.equal(after.deleted, true, 'tombstone survives compaction');
  assert.equal(after.note, 'v2');
  assert.equal(convergedNote(db, id), 'v2', 'a peer replaying from scratch still converges on v2');
});
