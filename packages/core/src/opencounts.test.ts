import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import {
  createItem,
  setCompleted,
  subtaskProgress,
  openCountsByContainer,
  type CountScope,
} from './repo';

const DEV = 'dev-1';

/** openCountsByContainer must equal subtaskProgress's (total - done) for every
 *  container, under both scopes — it's a batch reimplementation of that walk. */
test('openCountsByContainer matches subtaskProgress per container', () => {
  const db = openMemoryDb();

  // P1: A (with A1 done, A2 open), B done  ·  P2: empty  ·  focused task T with subtasks
  const p1 = createItem(db, DEV, { type: 'project', title: 'P1', sortOrder: 1 });
  const a = createItem(db, DEV, { type: 'task', title: 'A', parentId: p1.id, sortOrder: 1 });
  const a1 = createItem(db, DEV, { type: 'task', title: 'A1', parentId: a.id, sortOrder: 1 });
  createItem(db, DEV, { type: 'task', title: 'A2', parentId: a.id, sortOrder: 2 });
  const b = createItem(db, DEV, { type: 'task', title: 'B', parentId: p1.id, sortOrder: 2 });
  const p2 = createItem(db, DEV, { type: 'project', title: 'P2', sortOrder: 2 });
  const t = createItem(db, DEV, { type: 'task', title: 'T', sortOrder: 3 });
  createItem(db, DEV, { type: 'task', title: 'T1', parentId: t.id, sortOrder: 1 });

  setCompleted(db, DEV, a1.id, true);
  setCompleted(db, DEV, b.id, true);

  const ids = [p1.id, p2.id, a.id, t.id];
  for (const scope of ['all', 'direct'] as CountScope[]) {
    const batch = openCountsByContainer(db, ids, scope);
    for (const id of ids) {
      const { done, total } = subtaskProgress(db, id, scope);
      assert.equal(batch.get(id), total - done, `${scope} count for ${id}`);
    }
  }
});

test('openCountsByContainer handles empty input and unknown ids', () => {
  const db = openMemoryDb();
  assert.equal(openCountsByContainer(db, [], 'all').size, 0);
  const only = createItem(db, DEV, { type: 'project', title: 'solo', sortOrder: 1 });
  const counts = openCountsByContainer(db, [only.id, 'nope'], 'all');
  assert.equal(counts.get(only.id), 0);
  assert.equal(counts.get('nope'), 0);
});
