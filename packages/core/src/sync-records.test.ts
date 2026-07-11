import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { observeTs, ingestOps } from './crdt';
import {
  createItem,
  updateItem,
  setCompleted,
  shareItem,
  unshareItem,
  listSharesForItem,
  upsertAttachment,
  itemsMissingCreate,
  claimUnowned,
  createUser,
  upsertUser,
  getUser,
  getItem,
  ingestRecordOps,
  startTimer,
  stopTimer,
  saveTimeLog,
  getTimeLogs,
} from './repo';
import { getUnsyncedRecordOps } from './records';
import type { Attachment, Op, User } from './types';

const A = 'device-a';
const B = 'device-b';

// Y1 — a duplicate username must not crash sync ingest (it used to throw on the
// UNIQUE(username) constraint and wedge all sync).
test('upsertUser de-collides a duplicate username instead of throwing', () => {
  const db = openMemoryDb();
  const bob = createUser(db, { username: 'bob', displayName: 'Bob' });
  const other: User = {
    id: 'a-different-id-1234',
    username: 'bob', // same name, different id (minted on another device)
    display_name: 'Bob 2',
    role: 'member',
    is_bot: false,
    avatar_color: null,
    avatar_initial: null,
    plan_startup_min: null,
    plan_default_estimate_min: null,
    is_remote: false,
    home_server: null,
    created_at: '2026-06-24T00:00:00.000Z',
    updated_at: '2026-06-24T00:00:00.000Z',
    deleted: false,
  };
  assert.doesNotThrow(() => upsertUser(db, other));
  // Both rows survive; the original keeps its name.
  assert.equal(getUser(db, bob.id)?.username, 'bob');
  const rows = db.all<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  assert.equal(rows[0]!.n, 2);
});

// Y2 — record LWW now uses the causal clock, so an unshare made *after observing* a
// share (even from a fast-clock peer) wins, instead of being lost to the peer's
// inflated wall-clock updated_at (tombstone resurrection of a revoked share).
test('an unshare after observing the share wins, even against a fast-clock peer', () => {
  const dbA = openMemoryDb();
  const dbB = openMemoryDb();
  // Device A has a wildly fast clock.
  observeTs(dbA, Date.now() + 10 * 365 * 86_400_000);
  shareItem(dbA, A, 'itemX', 'bob', 'write');
  const shareOp = getUnsyncedRecordOps(dbA).find((o) => o.entity === 'share')!;
  assert.ok(shareOp, 'A produced a share op');

  // B receives the share (and observes A's inflated clock via the op ts).
  ingestRecordOps(dbB, [shareOp], true);
  assert.equal(listSharesForItem(dbB, 'itemX').length, 1, 'B sees the grant');

  // B revokes it. Pre-fix this used Date.now() and lost to A's future updated_at.
  unshareItem(dbB, B, 'itemX', 'bob');
  assert.equal(listSharesForItem(dbB, 'itemX').length, 0, 'revoke wins on B');

  // And the revoke propagates back to A without resurrecting the share.
  const tombstone = getUnsyncedRecordOps(dbB).find((o) => o.entity === 'share')!;
  ingestRecordOps(dbA, [tombstone], true);
  assert.equal(listSharesForItem(dbA, 'itemX').length, 0, 'revoke wins on A too');
});

// SYNC-2 — upsertTimeLog now guards with the standard LWW check (previously absent
// entirely, since TimeLog had no updated_at column at all): a stale edit that arrives
// after a genuinely newer one — replay/ingest is rowid/arrival order, not ts order —
// must not clobber it, e.g. silently reopening a timer that was already stopped.
test('a stale timelog edit arriving after a newer one does not clobber it', () => {
  const dbA = openMemoryDb();
  const dbB = openMemoryDb();

  const log = startTimer(dbA, A, 'itemX', 'bob');
  const createOp = getUnsyncedRecordOps(dbA).find((o) => o.entity === 'timelog')!;
  ingestRecordOps(dbB, [createOp], true); // B receives the running timer

  // A edits the note next — soon to be stale, but not yet delivered to B.
  saveTimeLog(dbA, A, { ...log, note: 'stale note' });
  const noteOp = getUnsyncedRecordOps(dbA).find(
    (o) => o.entity === 'timelog' && (o.data as { note: string | null }).note === 'stale note',
  )!;
  assert.ok(noteOp, 'A produced a note-edit op');

  // B's clock races far ahead (e.g. it was offline with a fast device clock) and
  // stops the timer — genuinely later, and applied locally before A's note-edit op
  // ever arrives.
  observeTs(dbB, Date.now() + 10 * 365 * 86_400_000);
  stopTimer(dbB, B, log.id);
  assert.ok(
    getTimeLogs(dbB, 'itemX').find((t) => t.id === log.id)?.end_time,
    'B stopped the timer locally',
  );

  // A's stale note-edit op arrives afterward. Pre-fix, upsertTimeLog's unconditional
  // ON CONFLICT DO UPDATE applied it anyway, silently clearing end_time and
  // un-stopping a completed timer.
  ingestRecordOps(dbB, [noteOp], true);
  const finalB = getTimeLogs(dbB, 'itemX').find((t) => t.id === log.id);
  assert.ok(finalB?.end_time, 'stop survives the later-arriving stale edit');
  assert.equal(finalB?.note, null, 'the stale note edit itself is dropped, not applied');
});

// M5 — attachment `deleted` is monotonic; replaying a stale create after a tombstone
// must not resurrect it.
test('a deleted attachment is not resurrected by replaying its stale create', () => {
  const db = openMemoryDb();
  const att: Attachment = {
    id: 'att1',
    parent_type: 'item',
    parent_id: 'item1',
    item_id: 'item1',
    filename: 'a.png',
    mime_type: 'image/png',
    size: 10,
    hash: 'a'.repeat(64),
    created_by: 'u1',
    created_at: '2026-06-24T00:00:00.000Z',
    deleted: false,
  };
  upsertAttachment(db, att); // create
  upsertAttachment(db, { ...att, deleted: true }); // tombstone
  upsertAttachment(db, att); // stale create replayed
  const row = db.get<{ deleted: number }>('SELECT deleted FROM attachments WHERE id = ?', ['att1']);
  assert.equal(row?.deleted, 1, 'stays deleted');
});

// M6 — create-op detection parses the op, so a note value containing the literal
// `"type":` no longer masquerades as a creation op (which would suppress backfill).
test('itemsMissingCreate is not fooled by "type": appearing inside a field value', () => {
  const db = openMemoryDb();
  const op: Op = {
    id: 'op1',
    item_id: 'shell1',
    ts: 100,
    device_id: A,
    fields: { parent_id: 'p', note: 'mentions "type": here but is not a create' },
  };
  ingestOps(db, [op], true); // creates a shell row, no real create op
  assert.deepEqual(itemsMissingCreate(db, ['shell1']), ['shell1'], 'flagged as missing its create');

  // Once a real create op (carrying `type`) arrives, it is no longer flagged.
  ingestOps(db, [{ id: 'op2', item_id: 'shell1', ts: 200, device_id: A, fields: { type: 'task', title: 't' } }], true);
  assert.deepEqual(itemsMissingCreate(db, ['shell1']), []);
});

// C4 — the defer→due gap carries over as whole calendar days (stable across variable
// month lengths), not absolute milliseconds.
test('recurrence defer gap carries over in calendar days across a short month', () => {
  const db = openMemoryDb();
  // Future dates so the C2 catch-up loop (anchored on the real "now") doesn't advance
  // the occurrence — this isolates the C4 calendar-day-gap behaviour. Jan 31 → Feb 28.
  const item = createItem(db, A, {
    title: 'monthly with defer',
    dueDate: new Date(2027, 0, 31, 9, 0).toISOString(), // Jan 31 2027 local
    deferDate: new Date(2027, 0, 24, 9, 0).toISOString(), // Jan 24 2027 local (7-day gap)
  });
  updateItem(db, A, item.id, { recurrence: JSON.stringify({ type: 'monthly', interval: 1 }) });
  const { spawned } = setCompleted(db, A, item.id, true);
  assert.ok(spawned?.due_date && spawned.defer_date);
  const due = new Date(spawned!.due_date!);
  const defer = new Date(spawned!.defer_date!);
  const gapDays = Math.round((due.getTime() - defer.getTime()) / 86_400_000);
  assert.equal(gapDays, 7, 'gap preserved as 7 calendar days');
  // due clamps to Feb 28; defer is 7 days earlier = Feb 21.
  assert.equal(due.getMonth(), 1); // February
  assert.equal(due.getDate(), 28);
  assert.equal(defer.getDate(), 21);
});

// claimUnowned stamps ownership of locally-captured (unowned) items on first sign-in.
test('claimUnowned assigns owner_id to currently-unowned items', () => {
  const db = openMemoryDb();
  const t = createItem(db, A, { title: 'captured offline' }); // ownerId defaults to null
  assert.equal(getItem(db, t.id)?.owner_id, null);
  const n = claimUnowned(db, A, 'user-1');
  assert.equal(n, 1);
  assert.equal(getItem(db, t.id)?.owner_id, 'user-1');
});

// Y3 — legacy record-ops (created before newer columns existed) carry data JSON
// without those keys. A missing key binds `undefined`, which every SQL driver
// rejects — and because ingest ran in one throwing transaction, a fresh device's
// first full sync would wedge forever on the first legacy op it pulled (the
// APK "tried to bind a value of an unknown type" bug). Missing keys must
// coalesce to NULL/defaults and ingest must converge.
test('ingestRecordOps applies a legacy attachment op missing item_id/mime_type/size', () => {
  const db = openMemoryDb();
  // Pre-schema-v4 shape: no item_id, no mime_type, no size, no created_by.
  const legacy = {
    id: 'att-legacy-1',
    parent_type: 'item',
    parent_id: 'item-1',
    filename: 'old.pdf',
    hash: 'a'.repeat(64),
    created_at: '2025-01-01T00:00:00.000Z',
    deleted: false,
  };
  const fresh = ingestRecordOps(
    db,
    [
      {
        id: 'rop-legacy-1',
        entity: 'attachment',
        row_id: legacy.id,
        ts: 1000,
        device_id: B,
        data: legacy,
      },
    ],
    true,
  );
  assert.equal(fresh.length, 1);
  const row = db.get<{ item_id: string | null; size: number }>(
    'SELECT item_id, size FROM attachments WHERE id = ?',
    ['att-legacy-1'],
  );
  assert.ok(row, 'attachment materialized');
  assert.equal(row!.item_id, null);
  assert.equal(row!.size, 0);
});

// Y4 — one genuinely unappliable op must not roll back the batch or block the ops
// after it; it is skipped (logged) and everything else converges.
test('ingestRecordOps skips a poison op and still applies the rest of the batch', () => {
  const db = openMemoryDb();
  const poison = {
    id: 'rop-poison-1',
    entity: 'share',
    row_id: 'share-x',
    ts: 1000,
    device_id: B,
    data: { id: 'share-x' }, // missing item_id/user_id/timestamps → NOT NULL violation
  };
  const good = {
    id: 'rop-good-1',
    entity: 'share',
    row_id: 's:item-1:user-1',
    ts: 1001,
    device_id: B,
    data: {
      id: 's:item-1:user-1',
      item_id: 'item-1',
      user_id: 'user-1',
      permission: 'write',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted: false,
    },
  };
  let fresh: unknown[] = [];
  assert.doesNotThrow(() => {
    fresh = ingestRecordOps(db, [poison, good], true);
  });
  assert.equal(fresh.length, 1, 'only the good op counts as ingested');
  assert.equal(listSharesForItem(db, 'item-1').length, 1, 'good share applied');
  // Re-syncing the same batch stays quiet: the poison op was skipped (not stored),
  // the good one is deduped.
  assert.doesNotThrow(() => ingestRecordOps(db, [poison, good], true));
});

// Y5 — item ops from a foreign/legacy client can carry decoded JSON (an object)
// where the column stores a string, or a missing `fields` altogether. Neither may
// throw out of ingestOps; object values are serialized to the stored JSON string.
test('ingestOps tolerates object field values and a missing fields key', () => {
  const db = openMemoryDb();
  const item = createItem(db, A, { title: 'target' });
  const objectFields: Op = {
    id: 'op-obj-1',
    item_id: item.id,
    ts: Date.now() + 1000,
    device_id: B,
    fields: { recurrence: { type: 'weekly', interval: 1 } as unknown as string },
  };
  const noFields = { id: 'op-nofields-1', item_id: item.id, ts: 5, device_id: B } as Op;
  assert.doesNotThrow(() => ingestOps(db, [objectFields, noFields], true));
  assert.equal(
    getItem(db, item.id)?.recurrence,
    JSON.stringify({ type: 'weekly', interval: 1 }),
    'object value stored as its JSON string',
  );
});
