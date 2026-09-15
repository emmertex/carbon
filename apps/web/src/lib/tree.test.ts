import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { removeDescendants, computeSortOrder, getProjection } from './tree';
import type { FlatItem } from './tree';
import type { Item } from '@carbon/core';

function makeItem(id: string, parentId: string, depth: number, sort_order: number): FlatItem {
  const item: Item = {
    id, parent_id: parentId, type: 'task', owner_id: null, title: 'test', note: null,
    status: 'active', flagged: false, priority: 0, defer_date: null, due_date: null,
    reminder_at: null, estimate_minutes: null, completed_at: null, review_interval: null,
    reviewed_at: null, recurrence: null, geo: null, color: null, notes_project: false,
    thumb: null, folder_id: null, sort_order, order_mode: 'parallel', sys_kind: null,
    metadata: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', deleted: false,
  };
  return { id, item, parentId, depth };
}

describe('removeDescendants', () => {
  test('removes descendants of dragged item but keeps item', () => {
    const items = [
      makeItem('i1', 'root', 0, 0),
      makeItem('i2', 'i1', 1, 0),
      makeItem('i3', 'i1', 1, 1),
      makeItem('i4', 'root', 0, 1),
    ];
    const result = removeDescendants(items, 'i1');
    assert.equal(result.length, 2);
  });
});

describe('computeSortOrder', () => {
  test('returns midpoint between adjacent siblings', () => {
    const items = [
      makeItem('i1', 'p1', 0, 1),
      makeItem('i2', 'p1', 0, 3),
      makeItem('i3', 'p1', 0, 5),
    ];
    const order = computeSortOrder(items, 'i3', 'i2', 'p1');
    assert.equal(order, 2);
  });

  test('returns 1 for no siblings', () => {
    const items: FlatItem[] = [];
    const order = computeSortOrder(items, 'i1', 'i1', 'root');
    assert.equal(order, 1);
  });
});

describe('tree drag destinations', () => {
  const rows = [makeItem('a', 'root', 0, 1), makeItem('b', 'root', 0, 2), makeItem('c', 'root', 0, 3)];
  test('upward and downward moves use the projected insertion point', () => {
    assert.equal(computeSortOrder(rows, 'c', 'a', 'root'), 0);
    assert.equal(computeSortOrder(rows, 'a', 'b', 'root'), 2.5);
    assert.equal(computeSortOrder(rows, 'a', 'c', 'root'), 4);
  });
  test('horizontal drag nests and then promotes the task back to a sibling', () => {
    assert.deepEqual(getProjection(rows, 'root', 'b', 'b', 16), { depth: 1, parentId: 'a' });
    const nested = [rows[0]!, makeItem('b', 'a', 1, 1), rows[2]!];
    assert.deepEqual(getProjection(nested, 'root', 'b', 'b', -16), { depth: 0, parentId: 'root' });
    assert.equal(computeSortOrder(nested, 'b', 'b', 'root'), 2);
  });
  test('compact indentation matches the displayed 12px step', () => {
    assert.deepEqual(getProjection(rows, 'root', 'b', 'b', 7, 12), { depth: 1, parentId: 'a' });
  });
  test('moving a subtree excludes its descendants and preserves the destination parent', () => {
    const nested = [rows[0]!, makeItem('child', 'a', 1, 1), rows[1]!, rows[2]!];
    const visible = removeDescendants(nested, 'a');
    assert.deepEqual(getProjection(visible, 'root', 'a', 'b', 16), { depth: 1, parentId: 'b' });
    assert.equal(computeSortOrder(visible, 'a', 'b', 'b'), 1);
  });
});

test('nesting into a collapsed parent inserts before its hidden children without ties', () => {
  const all = [makeItem('a', 'root', 0, 1), makeItem('b', 'a', 1, 1), makeItem('c', 'root', 0, 2)];
  assert.equal(computeSortOrder([all[0]!, all[2]!], 'c', 'c', 'a', all), 0);
});
