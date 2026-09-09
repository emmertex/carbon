import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFilters,
  anyFilterActive,
  applySort,
  DEFAULT_FILTERS,
  baseDefaultFilters,
} from './views';
import type { Item } from '@carbon/core';

describe('normalizeFilters', () => {
  test('fills defaults for null/undefined', () => {
    const f = normalizeFilters(null);
    assert.equal(f.showCompleted, false);
  });

  test('preserves provided values', () => {
    const f = normalizeFilters({ showCompleted: true });
    assert.equal(f.showCompleted, true);
  });

  test('migrates legacy tagId to tagAny', () => {
    const f = normalizeFilters({ tagId: 't1' });
    assert.deepEqual(f.tagAny, ['t1']);
  });
});

describe('anyFilterActive', () => {
  test('false for default filters', () => {
    assert.equal(anyFilterActive(DEFAULT_FILTERS), false);
  });

  test('true when showCompleted is set', () => {
    assert.equal(anyFilterActive({ ...DEFAULT_FILTERS, showCompleted: true }), true);
  });
});

describe('baseDefaultFilters', () => {
  test('today defaults hideBlocked to true', () => {
    assert.equal(baseDefaultFilters('today').hideBlocked, true);
  });

  test('all defaults hideBlocked to false', () => {
    assert.equal(baseDefaultFilters('all').hideBlocked, false);
  });
});

describe('applySort', () => {
  test('sort by due date ascending', () => {
    const items = [
      { id: 'i1', type: 'task', status: 'active', title: 'test', parent_id: null, sort_order: 0, created_at: '2024-01-01', updated_at: '2024-01-01', due_date: '2024-01-15T00:00:00Z', defer_date: null, flagged: false, priority: 0, completed_at: null, deleted_at: null, metadata: null },
      { id: 'i2', type: 'task', status: 'active', title: 'test', parent_id: null, sort_order: 0, created_at: '2024-01-01', updated_at: '2024-01-01', due_date: '2024-01-10T00:00:00Z', defer_date: null, flagged: false, priority: 0, completed_at: null, deleted_at: null, metadata: null },
    ] as unknown[] as Item[];
    const result = applySort(items, 'due');
    assert.equal(result[0]!.id, 'i2');
  });
});
