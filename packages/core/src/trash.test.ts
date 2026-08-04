import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import {
  createItem,
  deleteItem,
  deletedRoots,
  getItem,
  restorableIds,
  restoreItem,
  TRASH_WINDOW_DAYS,
} from './repo';

const DEVICE = 'dev-trash';

/** Backdate an item's tombstone (and the `updated_at` the SQL prefilter reads),
 *  so the window can be tested without waiting days. */
function backdateDelete(db: ReturnType<typeof openMemoryDb>, id: string, daysAgo: number): void {
  const ms = Date.now() - daysAgo * 86_400_000;
  db.run('UPDATE items SET clocks = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify({ deleted: { ts: ms, dev: DEVICE } }),
    new Date(ms).toISOString(),
    id,
  ]);
}

test('a cascade delete is one restorable entry that brings the whole subtree back', () => {
  const db = openMemoryDb();
  const project = createItem(db, DEVICE, { type: 'project', title: 'Trip' });
  const task = createItem(db, DEVICE, { title: 'Pack', parentId: project.id });
  const sub = createItem(db, DEVICE, { title: 'Passport', parentId: task.id });
  const keep = createItem(db, DEVICE, { type: 'project', title: 'Untouched' });

  deleteItem(db, DEVICE, project.id);

  // One entry for the delete event, not one per descendant.
  const entries = deletedRoots(db);
  assert.deepEqual(
    entries.map((e) => e.item.id),
    [project.id],
  );
  assert.ok(entries[0]!.deletedAt > 0);
  assert.deepEqual(restorableIds(db, project.id), [project.id, task.id, sub.id]);

  assert.equal(restoreItem(db, DEVICE, project.id), 3);
  for (const id of [project.id, task.id, sub.id, keep.id]) {
    assert.equal(getItem(db, id)?.deleted, false);
  }
  assert.deepEqual(deletedRoots(db), []);
});

test('deleting a task with sub-tasks keeps the parent live and lists only that task', () => {
  const db = openMemoryDb();
  const project = createItem(db, DEVICE, { type: 'project', title: 'Trip' });
  const task = createItem(db, DEVICE, { title: 'Pack', parentId: project.id });
  createItem(db, DEVICE, { title: 'Passport', parentId: task.id });

  deleteItem(db, DEVICE, task.id);

  assert.deepEqual(
    deletedRoots(db).map((e) => e.item.id),
    [task.id],
  );
  assert.equal(getItem(db, project.id)?.deleted, false);
});

test('a sub-task deleted earlier is not resurrected by restoring its parent', () => {
  const db = openMemoryDb();
  const task = createItem(db, DEVICE, { title: 'Pack', parentId: null });
  const gone = createItem(db, DEVICE, { title: 'Old sub-task', parentId: task.id });
  const withIt = createItem(db, DEVICE, { title: 'Live sub-task', parentId: task.id });

  deleteItem(db, DEVICE, gone.id); // deleted on purpose, earlier
  deleteItem(db, DEVICE, task.id); // the accident

  // The earlier delete isn't offered while its parent is deleted (restoring it
  // couldn't make it visible); the accident is.
  assert.deepEqual(
    deletedRoots(db).map((e) => e.item.id),
    [task.id],
  );

  assert.equal(restoreItem(db, DEVICE, task.id), 2);
  assert.equal(getItem(db, task.id)?.deleted, false);
  assert.equal(getItem(db, withIt.id)?.deleted, false);
  assert.equal(getItem(db, gone.id)?.deleted, true, 'stays in the trash on its own');

  // …and now that its parent is live again it can be restored separately.
  assert.deepEqual(
    deletedRoots(db).map((e) => e.item.id),
    [gone.id],
  );
  assert.equal(restoreItem(db, DEVICE, gone.id), 1);
  assert.equal(getItem(db, gone.id)?.deleted, false);
});

test('deleteItem leaves an existing tombstone (and its clock) alone', () => {
  const db = openMemoryDb();
  const task = createItem(db, DEVICE, { title: 'Pack' });
  const sub = createItem(db, DEVICE, { title: 'Passport', parentId: task.id });
  deleteItem(db, DEVICE, sub.id);

  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n;
  deleteItem(db, DEVICE, task.id);
  // One op: the parent. Re-tombstoning `sub` would bump its clock and fold an
  // older, separate delete into this cascade.
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n - before, 1);
});

test('entries are newest-first and age out of the window without being destroyed', () => {
  const db = openMemoryDb();
  const old = createItem(db, DEVICE, { title: 'Ancient' });
  const recent = createItem(db, DEVICE, { title: 'Yesterday' });
  deleteItem(db, DEVICE, old.id);
  deleteItem(db, DEVICE, recent.id);
  backdateDelete(db, old.id, TRASH_WINDOW_DAYS + 1);
  backdateDelete(db, recent.id, 1);

  assert.deepEqual(
    deletedRoots(db).map((e) => e.item.id),
    [recent.id],
  );
  // A wider window still finds it, newest first — nothing was thrown away.
  assert.deepEqual(
    deletedRoots(db, TRASH_WINDOW_DAYS + 30).map((e) => e.item.id),
    [recent.id, old.id],
  );
  assert.equal(restoreItem(db, DEVICE, old.id), 1);
  assert.equal(getItem(db, old.id)?.deleted, false);
});

test('restoring an item whose parent row is gone reattaches it at the top level', () => {
  const db = openMemoryDb();
  const project = createItem(db, DEVICE, { type: 'project', title: 'Trip' });
  const task = createItem(db, DEVICE, { title: 'Pack', parentId: project.id });
  deleteItem(db, DEVICE, task.id);
  db.run('DELETE FROM items WHERE id = ?', [project.id]); // e.g. a federation hard-delete

  assert.deepEqual(
    deletedRoots(db).map((e) => e.item.id),
    [task.id],
  );
  assert.equal(restoreItem(db, DEVICE, task.id), 1);
  const restored = getItem(db, task.id)!;
  assert.equal(restored.deleted, false);
  assert.equal(restored.parent_id, null);
});

test('an abandoned untitled draft is not listed, but an untitled container is', () => {
  const db = openMemoryDb();
  const draft = createItem(db, DEVICE, { title: '' });
  const container = createItem(db, DEVICE, { title: '' });
  createItem(db, DEVICE, { title: 'Real work', parentId: container.id });

  deleteItem(db, DEVICE, draft.id);
  deleteItem(db, DEVICE, container.id);

  assert.deepEqual(
    deletedRoots(db).map((e) => e.item.id),
    [container.id],
  );
  // Still restorable directly — it's hidden from the list, not made permanent.
  assert.equal(restoreItem(db, DEVICE, draft.id), 1);
});

test('restoring something that is not deleted is a no-op', () => {
  const db = openMemoryDb();
  const task = createItem(db, DEVICE, { title: 'Pack' });
  assert.deepEqual(restorableIds(db, task.id), []);
  assert.equal(restoreItem(db, DEVICE, task.id), 0);
  assert.equal(restoreItem(db, DEVICE, 'no-such-id'), 0);
});
