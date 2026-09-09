import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewDueAt, needsReview } from './review';
import type { Item } from './types';

function makeProject(p: Partial<Item>): Item {
  return {
    id: 'p1',
    type: 'project',
    title: 'Test Project',
    parent_id: null,
    owner_id: null,
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
    notes_project: false,
    thumb: null,
    folder_id: null,
    sort_order: 0,
    order_mode: 'parallel',
    sys_kind: null,
    metadata: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted: false,
    clocks: '{}',
    ...p,
  } as Item;
}

test('reviewDueAt: project with interval returns a future date', () => {
  const item = makeProject({ review_interval: 30, reviewed_at: '2026-06-01T00:00:00.000Z' });
  const due = reviewDueAt(item);
  assert.ok(due);
  // 30 days after review
  assert.equal(due!.getMonth(), 6);
  assert.equal(due!.getDate(), 1);
});

test('reviewDueAt: falls back to created_at when reviewed_at is null', () => {
  const item = makeProject({ review_interval: 7, reviewed_at: null });
  const due = reviewDueAt(item);
  assert.ok(due);
  // 7 days after created_at (Jan 1 + 7 = Jan 8)
  assert.equal(due!.getDate(), 8);
});

test('reviewDueAt: returns null for non-projects', () => {
  const task = makeProject({ type: 'task' });
  assert.equal(reviewDueAt(task), null);
});

test('reviewDueAt: returns null for projects without interval', () => {
  const item = makeProject({ review_interval: null });
  assert.equal(reviewDueAt(item), null);
});

test('needsReview: true when past due', () => {
  const item = makeProject({
    review_interval: 1,
    reviewed_at: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(needsReview(item, new Date('2026-01-05T00:00:00.000Z')), true);
});

test('needsReview: false when not yet due', () => {
  const item = makeProject({
    review_interval: 30,
    reviewed_at: '2026-06-01T00:00:00.000Z',
  });
  assert.equal(needsReview(item, new Date('2026-06-10T00:00:00.000Z')), false);
});

test('needsReview: false for non-projects', () => {
  const task = makeProject({ type: 'task', review_interval: 7 });
  assert.equal(needsReview(task), false);
});
