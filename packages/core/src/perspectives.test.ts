import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inbox, today, flagged, isAvailable, isOverdue, isActive } from './perspectives';
import type { Item } from './types';

let seq = 0;
function item(p: Partial<Item>): Item {
  return {
    id: `i${seq++}`,
    type: 'task',
    parent_id: null,
    owner_id: null,
    title: 't',
    note: null,
    status: 'active',
    flagged: false,
    priority: 0,
    defer_date: null,
    due_date: null,
    reminder_at: null,
    estimate_minutes: null,
    completed_at: null,
    review_interval: null,
    reviewed_at: null,
    recurrence: null,
    geo: null,
    color: null,
    sort_order: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    deleted: false,
    clocks: '{}',
    ...p,
  } as Item;
}

// Build times in LOCAL zone so assertions don't depend on the runner's timezone
// (the app stores all-day dates at local end-of-day, and today()/isOverdue use local).
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = local(2026, 6, 24, 12);

test('inbox = active top-level tasks only', () => {
  const items = [
    item({ title: 'top' }),
    item({ title: 'child', parent_id: 'i0' }),
    item({ title: 'project', type: 'project' }),
    item({ title: 'done', status: 'done' }),
    item({ title: 'deleted', deleted: true }),
  ];
  assert.deepEqual(inbox(items).map((i) => i.title), ['top']);
});

test('isAvailable hides deferred-to-the-future tasks', () => {
  assert.equal(isAvailable(item({ defer_date: local(2026, 6, 25).toISOString() }), NOW), false);
  assert.equal(isAvailable(item({ defer_date: local(2026, 6, 23).toISOString() }), NOW), true);
  assert.equal(isAvailable(item({ status: 'done' }), NOW), false);
});

test('today includes due-by-end-of-today and flagged, excludes deferred', () => {
  const list = [
    item({ title: 'due-earlier', due_date: local(2026, 6, 20, 9).toISOString() }),
    item({ title: 'due-today', due_date: local(2026, 6, 24, 23, 59).toISOString() }),
    item({ title: 'due-tomorrow', due_date: local(2026, 6, 25, 9).toISOString() }),
    item({ title: 'flagged-no-date', flagged: true }),
    item({ title: 'flagged-but-deferred', flagged: true, defer_date: local(2026, 7, 1).toISOString() }),
    item({ title: 'done-today', status: 'done', due_date: local(2026, 6, 24, 9).toISOString() }),
  ];
  const titles = today(list, NOW).map((i) => i.title).sort();
  assert.deepEqual(titles, ['due-earlier', 'due-today', 'flagged-no-date']);
});

test('today excludes projects even if due', () => {
  const list = [item({ title: 'proj', type: 'project', due_date: local(2026, 6, 20, 9).toISOString() })];
  assert.deepEqual(today(list, NOW), []);
});

test('flagged = active flagged tasks (deferred still counts, done/deleted do not)', () => {
  const list = [
    item({ title: 'a', flagged: true }),
    item({ title: 'b', flagged: true, defer_date: local(2026, 7, 1).toISOString() }),
    item({ title: 'c', flagged: true, status: 'done' }),
    item({ title: 'd', flagged: false }),
  ];
  assert.deepEqual(flagged(list).map((i) => i.title).sort(), ['a', 'b']);
});

test('isOverdue is time-based; not overdue when due later today', () => {
  assert.equal(isOverdue(item({ due_date: local(2026, 6, 24, 9).toISOString() }), NOW), true);
  assert.equal(isOverdue(item({ due_date: local(2026, 6, 24, 23, 59).toISOString() }), NOW), false);
  assert.equal(isOverdue(item({ due_date: null }), NOW), false);
  assert.equal(isOverdue(item({ due_date: local(2026, 6, 20, 9).toISOString(), status: 'done' }), NOW), false);
});

test('isActive excludes done, dropped, and deleted', () => {
  assert.equal(isActive(item({})), true);
  assert.equal(isActive(item({ status: 'done' })), false);
  assert.equal(isActive(item({ status: 'dropped' })), false);
  assert.equal(isActive(item({ deleted: true })), false);
});
