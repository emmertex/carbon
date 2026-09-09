import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allItems, createItem, isOverdue } from '@carbon/core';
import { openMemoryDb } from '../../../../packages/core/src/test-helpers';
import { countOverdueTasks } from './sidebarCounts';

test('Forecast badge counts overdue descendants and matches Forecast task predicates', () => {
  const db = openMemoryDb();
  const now = new Date('2026-09-09T12:00:00Z');
  const parent = createItem(db, 'd', { title: 'Parent without a due date' });
  for (const [type, status, deleted, due] of [
    ['task', 'active', 0, '2026-09-09T20:00:00+10:00'],
    ['task', 'done', 0, '2026-09-08T00:00:00Z'],
    ['task', 'active', 1, '2026-09-08T00:00:00Z'],
    ['note', 'active', 0, '2026-09-08T00:00:00Z'],
    ['task', 'active', 0, '2026-09-10T00:00:00Z'],
    ['task', 'active', 0, now.toISOString()],
  ] as const) {
    const item = createItem(db, 'd', { title: 'Child', type });
    db.run('UPDATE items SET parent_id = ?, status = ?, deleted = ?, due_date = ? WHERE id = ?',
      [parent.id, status, deleted, due, item.id]);
  }
  assert.equal(countOverdueTasks(db, now), 1);
  assert.equal(countOverdueTasks(db, now), allItems(db).filter(i => i.type === 'task' && isOverdue(i, now)).length);
});
