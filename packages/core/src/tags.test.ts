import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import {
  createItem,
  createTag,
  updateTag,
  moveTag,
  mergeTag,
  setItemTags,
  getItemTags,
  listTags,
  tagSegments,
  normalizeTagName,
  tagParentPath,
  tagLeaf,
  tagDepth,
  tagId,
  descendantTagIds,
  expandTagIds,
  effectiveTagColor,
  onHoldTagIds,
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
  assert.equal(tagDepth('Shopping'), 0);
  assert.equal(tagDepth('Shopping:Coles:FreshGoods'), 2);
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

test('mergeTag unions links onto the destination', () => {
  const db = openMemoryDb();
  const a = createItem(db, DEV, { title: 'a' });
  const b = createItem(db, DEV, { title: 'b' });
  createTag(db, DEV, 'Coles');
  createTag(db, DEV, 'Woolies');
  setItemTags(db, DEV, a.id, [tagId('Coles')]);
  setItemTags(db, DEV, b.id, [tagId('Woolies')]);

  mergeTag(db, DEV, tagId('Coles'), tagId('Woolies'));

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
