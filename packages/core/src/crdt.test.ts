import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { nextTs, observeTs, applyOp, ingestOps, recordOp } from './crdt';
import { getItem } from './repo';
import type { Op } from './types';

const op = (over: Partial<Op> & { item_id: string }): Op => ({
  id: `op-${Math.round(Math.random() * 1e9)}`,
  ts: 1000,
  device_id: 'dev-a',
  fields: {},
  ...over,
});

test('nextTs is monotonic and stays ahead of an observed peer timestamp', () => {
  const db = openMemoryDb();
  const a = nextTs(db);
  const b = nextTs(db);
  assert.ok(b > a, 'monotonic');
  const future = Date.now() + 10_000_000;
  observeTs(db, future);
  assert.ok(nextTs(db) > future, 'a local op after observing a future peer ts wins LWW');
});

test('per-field LWW: higher ts wins, lower ts loses, ties break on device_id', () => {
  const db = openMemoryDb();
  const id = 'item-1';
  ingestOps(db, [op({ item_id: id, ts: 100, device_id: 'a', fields: { type: 'task', title: 'a' } })], true);

  // Higher ts wins.
  ingestOps(db, [op({ item_id: id, ts: 200, device_id: 'a', fields: { title: 'b' } })], true);
  assert.equal(getItem(db, id)?.title, 'b');

  // Lower ts loses (stale write is ignored).
  ingestOps(db, [op({ item_id: id, ts: 150, device_id: 'a', fields: { title: 'stale' } })], true);
  assert.equal(getItem(db, id)?.title, 'b');

  // Equal ts: higher device_id wins.
  ingestOps(db, [op({ item_id: id, ts: 200, device_id: 'z', fields: { title: 'z-wins' } })], true);
  assert.equal(getItem(db, id)?.title, 'z-wins');
  ingestOps(db, [op({ item_id: id, ts: 200, device_id: 'b', fields: { title: 'b-loses' } })], true);
  assert.equal(getItem(db, id)?.title, 'z-wins');
});

test('applyOp is idempotent — replaying the same op changes nothing', () => {
  const db = openMemoryDb();
  const id = 'item-2';
  const create = op({ item_id: id, ts: 100, fields: { type: 'task', title: 'x' } });
  applyOp(db, create);
  applyOp(db, create);
  applyOp(db, create);
  assert.equal(getItem(db, id)?.title, 'x');
});

test('a create op carrying note=null does not clobber a later-stamped note', () => {
  // The original causal-clock bug: a "future" create with note=null wiping a real note.
  const db = openMemoryDb();
  const id = 'item-3';
  // Note added at a genuinely later causal time.
  ingestOps(db, [op({ item_id: id, ts: 100, fields: { type: 'task', title: 't' } })], true);
  ingestOps(db, [op({ item_id: id, ts: 300, fields: { note: 'real note' } })], true);
  // A stale create (note implicitly null) arrives with a lower ts — must NOT clear it.
  ingestOps(db, [op({ item_id: id, ts: 200, fields: { type: 'task', title: 't', note: null } })], true);
  assert.equal(getItem(db, id)?.note, 'real note');
});

test('ingestOps returns only genuinely-new ops (dedup by id)', () => {
  const db = openMemoryDb();
  const one = op({ item_id: 'item-4', ts: 100, fields: { type: 'task', title: 'a' } });
  const fresh1 = ingestOps(db, [one], true);
  assert.equal(fresh1.length, 1);
  const fresh2 = ingestOps(db, [one], true); // same id again
  assert.equal(fresh2.length, 0, 're-sent op is not reported fresh (prevents backfill loops)');
});

test('ingestOps advances the local clock past the batch', () => {
  const db = openMemoryDb();
  const future = Date.now() + 5_000_000;
  ingestOps(db, [op({ item_id: 'item-5', ts: future, fields: { type: 'task', title: 'a' } })], true);
  assert.ok(nextTs(db) > future, 'clock observed the ingested ts');
});

test('recordOp stamps a monotonic causal ts and applies locally', () => {
  const db = openMemoryDb();
  const a = recordOp(db, 'dev', 'item-6', { type: 'task', title: 'a' });
  const b = recordOp(db, 'dev', 'item-6', { title: 'b' });
  assert.ok(b.ts > a.ts);
  assert.equal(getItem(db, 'item-6')?.title, 'b');
});
