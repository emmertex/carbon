import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlParams } from './db';
import { openMemoryDb } from './test-helpers';

/** Guards the v26 fix: without ANALYZE stats SQLite picked
 *  idx_items_deleted_updated (deleted=?) for child/folder lookups, turning every
 *  getChildren into a full table walk. These hot lookups must seek on the key. */
function plan(sql: string, params: SqlParams = ['x']): string {
  const db = openMemoryDb();
  return db
    .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)
    .map((r) => r.detail)
    .join(' | ');
}

test('getChildren seeks idx_items_parent_live without a temp sort', () => {
  const p = plan(
    'SELECT * FROM items WHERE parent_id = ? AND deleted = 0 ORDER BY sort_order, created_at',
  );
  assert.match(p, /idx_items_parent_live \(parent_id=\? AND deleted=\?\)/);
  assert.doesNotMatch(p, /TEMP B-TREE/);
});

test('folder member lookup seeks idx_items_folder_live', () => {
  const p = plan('SELECT id FROM items WHERE folder_id = ? AND deleted = 0');
  assert.match(p, /idx_items_folder_live \(folder_id=\? AND deleted=\?\)/);
});
