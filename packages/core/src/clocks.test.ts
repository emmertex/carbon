import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { createItem, updateItem, getItem } from './repo';
import {
  applyOp,
  decodeClocks,
  encodeClocks,
  recodeLegacyClocks,
  type ClockMap,
} from './crdt';
import { ITEM_PATCH_FIELDS } from './types';

const A = '3f1c2a9e-0b7d-4d2e-9a41-5c6f7e8d9a01';
const B = '7a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d';

test('compact clocks round-trip every field, device and timestamp', () => {
  const map: ClockMap = {};
  ITEM_PATCH_FIELDS.forEach((f, i) => {
    map[f] = i % 3 ? { ts: 1_731_500_000_000, dev: A } : { ts: 1_731_500_000_000 + i, dev: B };
  });
  map.some_future_field = { ts: 5, dev: A }; // not in the code table: stored by name
  const enc = encodeClocks(map);
  assert.deepEqual(decodeClocks(enc), map);
  assert.ok(enc.length < 400, `encoded ${enc.length} bytes`);
  assert.equal(encodeClocks(decodeClocks(enc)), enc, 'deterministic');
});

test('legacy object clocks still decode, and malformed entries are dropped', () => {
  const legacy = JSON.stringify({ title: { ts: 9, dev: A }, note: { ts: 'x', dev: A }, flagged: null });
  assert.deepEqual(decodeClocks(legacy), { title: { ts: 9, dev: A } });
  assert.deepEqual(decodeClocks('{}'), {});
  assert.deepEqual(decodeClocks(null), {});
  assert.deepEqual(decodeClocks('[2,[]]'), {});
});

test('LWW merge behaves identically on legacy and re-encoded rows', () => {
  const db = openMemoryDb();
  const item = createItem(db, A, { title: 'Original' });
  // Rewrite as the legacy encoding a pre-v27 database holds.
  const clocks = decodeClocks(db.get<{ clocks: string }>('SELECT clocks FROM items WHERE id = ?', [item.id])!.clocks);
  const legacy = JSON.stringify(clocks);
  db.run('UPDATE items SET clocks = ? WHERE id = ?', [legacy, item.id]);
  const titleTs = clocks.title!.ts;

  // An older op loses, a same-ts op from a higher device wins, on the legacy row.
  applyOp(db, { id: 'o1', item_id: item.id, ts: titleTs - 1, device_id: B, fields: { title: 'stale' } });
  assert.equal(getItem(db, item.id)!.title, 'Original');
  applyOp(db, { id: 'o2', item_id: item.id, ts: titleTs, device_id: 'zzzz', fields: { title: 'tie-break' } });
  assert.equal(getItem(db, item.id)!.title, 'tie-break');
  const stored = db.get<{ clocks: string }>('SELECT clocks FROM items WHERE id = ?', [item.id])!.clocks;
  assert.ok(stored.startsWith('['), 'written back compactly');
  assert.equal(decodeClocks(stored).title!.dev, 'zzzz');
  assert.equal(decodeClocks(stored).status!.ts, clocks.status!.ts, 'untouched fields keep their clocks');

  updateItem(db, A, item.id, { flagged: true });
  assert.equal(getItem(db, item.id)!.flagged, true);
});

test('recodeLegacyClocks rewrites legacy rows only and preserves every clock', () => {
  const db = openMemoryDb();
  const a = createItem(db, A, { title: 'a' });
  const b = createItem(db, A, { title: 'b' });
  const before = decodeClocks(db.get<{ clocks: string }>('SELECT clocks FROM items WHERE id = ?', [a.id])!.clocks);
  db.run('UPDATE items SET clocks = ? WHERE id = ?', [JSON.stringify(before), a.id]);
  const bEnc = db.get<{ clocks: string }>('SELECT clocks FROM items WHERE id = ?', [b.id])!.clocks;
  assert.equal(recodeLegacyClocks(db), 1);
  const after = db.get<{ clocks: string }>('SELECT clocks FROM items WHERE id = ?', [a.id])!.clocks;
  assert.ok(after.startsWith('['));
  assert.deepEqual(decodeClocks(after), before);
  assert.equal(db.get<{ clocks: string }>('SELECT clocks FROM items WHERE id = ?', [b.id])!.clocks, bEnc);
  assert.equal(recodeLegacyClocks(db), 0, 'idempotent');
});
