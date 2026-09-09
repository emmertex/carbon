import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from '../../../../packages/core/src/test-helpers';
import { createItem, allItems } from '@carbon/core';
import { moveListItem } from './listReorder';

test('precise move repairs equal imported ranks and reaches distant destinations', () => {
  const db = openMemoryDb();
  const items = Array.from({ length: 250 }, (_, i) => createItem(db, 'd', { title: `row ${i}` }));
  db.run('UPDATE items SET sort_order = 0');
  const tied = items.map((i) => ({ ...i, sort_order: 0 }));
  moveListItem(db, 'd', tied, items[0]!.id, 100);
  let ordered = allItems(db).sort((a, b) => a.sort_order - b.sort_order);
  assert.equal(ordered[100]!.id, items[0]!.id);
  assert.equal(new Set(ordered.map((i) => i.sort_order)).size, 250);
  moveListItem(db, 'd', ordered, items[0]!.id, 249);
  ordered = allItems(db).sort((a, b) => a.sort_order - b.sort_order);
  assert.equal(ordered[249]!.id, items[0]!.id);
});
