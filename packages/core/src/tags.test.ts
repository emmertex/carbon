import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import { observeTs } from './crdt';
import { getUnsyncedRecordOps } from './records';
import {
  createItem,
  createTag,
  updateTag,
  moveTag,
  deleteTag,
  setItemTags,
  getItemTags,
  listTags,
  tagSegments,
  normalizeTagName,
  tagParentPath,
  tagLeaf,
  tagId,
  descendantTagIds,
  expandTagIds,
  effectiveTagColor,
  onHoldTagIds,
  heldTagIds,
  itemHasHeldTag,
  reorderTag,
  ingestRecordOps,
} from './repo';

function openMemoryDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const db: Db = {
    run: (sql: string, params: SqlParams = []) => void sqlite.prepare(sql).run(...params),
    all: <T>(sql: string, params: SqlParams = []) => sqlite.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: SqlParams = []) => sqlite.prepare(sql).get(...params) as T | undefined,
    exec: (sql: string) => sqlite.exec(sql),
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const r = fn();
        sqlite.exec('COMMIT');
        return r;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  migrate(db);
  return db;
}

const DEV = 'test-device';

test('path helpers parse/normalize colon paths', () => {
  assert.deepEqual(tagSegments('Shopping:Coles:FreshGoods'), ['Shopping', 'Coles', 'FreshGoods']);
  assert.equal(normalizeTagName(' Shopping : Coles '), 'Shopping:Coles');
  assert.equal(normalizeTagName('Shopping::Coles'), 'Shopping:Coles'); // empties dropped
  assert.equal(tagParentPath('Shopping:Coles:FreshGoods'), 'Shopping:Coles');
  assert.equal(tagParentPath('Shopping'), '');
  assert.equal(tagLeaf('Shopping:Coles:FreshGoods'), 'FreshGoods');
  // id is whitespace/case-insensitive so devices converge.
  assert.equal(tagId('Shopping: Coles'), tagId('shopping:coles'));
});

test('createTag materializes missing ancestor rows', () => {
  const db = openMemoryDb();
  const leaf = createTag(db, DEV, 'Shopping:Coles:FreshGoods');
  assert.equal(leaf.name, 'Shopping:Coles:FreshGoods');
  const names = listTags(db)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(names, ['Shopping', 'Shopping:Coles', 'Shopping:Coles:FreshGoods']);
});

test('descendant expansion is prefix-scoped', () => {
  const db = openMemoryDb();
  createTag(db, DEV, 'Shopping:Coles:FreshGoods');
  createTag(db, DEV, 'Shopping:Woolies');
  createTag(db, DEV, 'Shoppingfoo'); // must NOT be treated as a descendant of Shopping
  const shoppingId = tagId('Shopping');
  const desc = descendantTagIds(db, shoppingId).sort();
  assert.deepEqual(desc, [tagId('Shopping:Coles'), tagId('Shopping:Coles:FreshGoods'), tagId('Shopping:Woolies')].sort());
  const expanded = expandTagIds(db, [shoppingId]);
  assert.ok(expanded.has(shoppingId));
  assert.ok(expanded.has(tagId('Shopping:Coles:FreshGoods')));
  assert.ok(!expanded.has(tagId('Shoppingfoo')));
});

test('colour inherits from nearest coloured ancestor, overridable', () => {
  const db = openMemoryDb();
  createTag(db, DEV, 'Shopping:Coles:FreshGoods');
  updateTag(db, DEV, tagId('Shopping'), { color: '#ef4444' });
  // leaf with no colour inherits Shopping's
  assert.equal(effectiveTagColor(db, 'Shopping:Coles:FreshGoods'), '#ef4444');
  // a mid-level override wins for itself and below
  updateTag(db, DEV, tagId('Shopping:Coles'), { color: '#3b82f6' });
  assert.equal(effectiveTagColor(db, 'Shopping:Coles:FreshGoods'), '#3b82f6');
  assert.equal(effectiveTagColor(db, 'Shopping'), '#ef4444');
  // a tag with no coloured ancestor returns null
  createTag(db, DEV, 'Solo');
  assert.equal(effectiveTagColor(db, 'Solo'), null);
});

test('moveTag re-keys the subtree and re-points item links', () => {
  const db = openMemoryDb();
  const item = createItem(db, DEV, { title: 'milk' });
  createTag(db, DEV, 'Shopping:Coles:FreshGoods');
  setItemTags(db, DEV, item.id, [tagId('Shopping:Coles:FreshGoods')]);

  // Reparent Coles under Errands → Errands:Coles:FreshGoods
  moveTag(db, DEV, tagId('Shopping:Coles'), 'Errands:Coles');

  const live = listTags(db)
    .map((t) => t.name)
    .sort();
  assert.ok(live.includes('Errands:Coles:FreshGoods'));
  assert.ok(!live.includes('Shopping:Coles:FreshGoods'));
  assert.ok(!live.includes('Shopping:Coles'));

  // the task's link followed the rename
  const itemTags = getItemTags(db, item.id).map((t) => t.name);
  assert.deepEqual(itemTags, ['Errands:Coles:FreshGoods']);
});

test('moveTag onto an existing tag unions links onto the destination', () => {
  const db = openMemoryDb();
  const a = createItem(db, DEV, { title: 'a' });
  const b = createItem(db, DEV, { title: 'b' });
  createTag(db, DEV, 'Coles');
  createTag(db, DEV, 'Woolies');
  setItemTags(db, DEV, a.id, [tagId('Coles')]);
  setItemTags(db, DEV, b.id, [tagId('Woolies')]);

  moveTag(db, DEV, tagId('Coles'), 'Woolies');

  assert.deepEqual(getItemTags(db, a.id).map((t) => t.name), ['Woolies']);
  assert.deepEqual(getItemTags(db, b.id).map((t) => t.name), ['Woolies']);
  assert.ok(!listTags(db).some((t) => t.name === 'Coles'));
});

test('tag status: defaults active, settable to on-hold', () => {
  const db = openMemoryDb();
  const t = createTag(db, DEV, 'Waiting');
  assert.equal(t.status, 'active');
  assert.equal(onHoldTagIds(db).size, 0);
  updateTag(db, DEV, tagId('Waiting'), { status: 'on-hold' });
  const held = onHoldTagIds(db);
  assert.equal(held.size, 1);
  assert.ok(held.has(tagId('Waiting')));
  // status survives a round-trip through the row
  assert.equal(listTags(db).find((x) => x.id === tagId('Waiting'))!.status, 'on-hold');
});

test('tags get an incrementing sort_order and reorderTag repositions them', () => {
  const db = openMemoryDb();
  const a = createTag(db, DEV, 'Alpha');
  const b = createTag(db, DEV, 'Bravo');
  const c = createTag(db, DEV, 'Charlie');
  assert.ok(b.sort_order > a.sort_order);
  assert.ok(c.sort_order > b.sort_order);
  // listTags is ordered by sort_order, so creation order is preserved.
  assert.deepEqual(listTags(db).map((t) => t.name), ['Alpha', 'Bravo', 'Charlie']);
  // Move Charlie between Alpha and Bravo via a fractional midpoint.
  reorderTag(db, DEV, tagId('Charlie'), (a.sort_order + b.sort_order) / 2);
  assert.deepEqual(listTags(db).map((t) => t.name), ['Alpha', 'Charlie', 'Bravo']);
});

test('tag location: stored, updatable, cleared, and preserved across moveTag', () => {
  const db = openMemoryDb();
  createTag(db, DEV, 'Home:Garage');
  assert.equal(listTags(db).find((t) => t.id === tagId('Home'))!.geo, null);
  const geo = JSON.stringify({ lat: -37.8, lng: 144.9, radius: 150, label: 'Home' });
  updateTag(db, DEV, tagId('Home'), { geo });
  assert.equal(listTags(db).find((t) => t.id === tagId('Home'))!.geo, geo);
  // Reparenting Home → Errands:Home carries the location with it.
  moveTag(db, DEV, tagId('Home'), 'Errands:Home');
  assert.equal(listTags(db).find((t) => t.id === tagId('Errands:Home'))!.geo, geo);
  // Clearing sets it back to null.
  updateTag(db, DEV, tagId('Errands:Home'), { geo: null });
  assert.equal(listTags(db).find((t) => t.id === tagId('Errands:Home'))!.geo, null);
});

test('itemHasHeldTag is true when a task carries an on-hold tag or its descendant', () => {
  const db = openMemoryDb();
  const onTask = createItem(db, DEV, { title: 'blocked' });
  const offTask = createItem(db, DEV, { title: 'free' });
  createTag(db, DEV, 'Waiting:Reply');
  updateTag(db, DEV, tagId('Waiting'), { status: 'on-hold' });
  // Descendant of an on-hold tag counts as held.
  setItemTags(db, DEV, onTask.id, [tagId('Waiting:Reply')]);
  createTag(db, DEV, 'Active');
  setItemTags(db, DEV, offTask.id, [tagId('Active')]);

  const held = heldTagIds(db);
  assert.ok(held.has(tagId('Waiting:Reply'))); // expansion includes descendants
  assert.ok(itemHasHeldTag(db, onTask.id, held));
  assert.ok(!itemHasHeldTag(db, offTask.id, held));
  // Works without passing a precomputed set, too.
  assert.ok(itemHasHeldTag(db, onTask.id));
});

// SYNC-3 — tag record-ops now stamp `updated_at` from the causal clock (previously
// raw wall-clock, unlike every other record entity), so a delete made *after
// observing* a peer's create wins, instead of losing to a fast-clock peer's inflated
// wall-clock updated_at (tag resurrection). Mirrors the share/comment Y2 test in
// sync-records.test.ts.
test('deleting a tag after observing its creation wins, even against a fast-clock peer', () => {
  const dbA = openMemoryDb();
  const dbB = openMemoryDb();
  const A = 'device-a';
  const B = 'device-b';

  // Device A has a wildly fast clock.
  observeTs(dbA, Date.now() + 10 * 365 * 86_400_000);
  createTag(dbA, A, 'Waiting');
  const createOp = getUnsyncedRecordOps(dbA).find((o) => o.entity === 'tag')!;
  assert.ok(createOp, 'A produced a tag create op');

  // B receives the tag (and observes A's inflated clock via the op ts).
  ingestRecordOps(dbB, [createOp], true);
  assert.ok(listTags(dbB).some((t) => t.name === 'Waiting'), 'B sees the tag');

  // B deletes it. Pre-fix this used Date.now() and lost to A's future updated_at.
  deleteTag(dbB, B, tagId('Waiting'));
  assert.ok(!listTags(dbB).some((t) => t.name === 'Waiting'), 'delete wins on B');

  // And the delete propagates back to A without resurrecting the tag.
  const tombstone = getUnsyncedRecordOps(dbB).find((o) => o.entity === 'tag')!;
  ingestRecordOps(dbA, [tombstone], true);
  assert.ok(!listTags(dbA).some((t) => t.name === 'Waiting'), 'delete wins on A too');
});
