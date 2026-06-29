import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import { createItem, updateItem, createTag, updateTag, setItemTags, tagId } from './repo';
import { tasksNearLocation } from './geo';

// Minimal in-memory Db backed by node:sqlite (mirrors repo.test.ts).
function openMemoryDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const db: Db = {
    run(sql: string, params: SqlParams = []): void {
      sqlite.prepare(sql).run(...params);
    },
    all<T>(sql: string, params: SqlParams = []): T[] {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: SqlParams = []): T | undefined {
      return sqlite.prepare(sql).get(...params) as T | undefined;
    },
    exec(sql: string): void {
      sqlite.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const result = fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  migrate(db);
  return db;
}

const DEVICE = 'test-device';
const OFFICE = { lat: -37.81, lng: 144.96 };
const geo = (over: object) => JSON.stringify({ lat: OFFICE.lat, lng: OFFICE.lng, radius: 100, ...over });

test('tasksNearLocation matches a direct task geo by zone label', () => {
  const db = openMemoryDb();
  const t = createItem(db, DEVICE, { title: 'Buy milk' });
  updateItem(db, DEVICE, t.id, { geo: geo({ label: 'Coles' }) });
  const other = createItem(db, DEVICE, { title: 'no geo' });

  const hit = tasksNearLocation(db, { zone: 'coles' });
  assert.deepEqual(hit.map((i) => i.id), [t.id]);
  // The other task without geo is excluded.
  assert.ok(!hit.some((i) => i.id === other.id));
});

test('tasksNearLocation matches a direct task geo by GPS radius', () => {
  const db = openMemoryDb();
  const near = createItem(db, DEVICE, { title: 'near' });
  updateItem(db, DEVICE, near.id, { geo: geo({ radius: 100 }) });
  const far = createItem(db, DEVICE, { title: 'far' });
  updateItem(db, DEVICE, far.id, { geo: geo({ lat: OFFICE.lat + 0.009, radius: 100 }) }); // ~1km away

  const hit = tasksNearLocation(db, { point: OFFICE });
  assert.deepEqual(hit.map((i) => i.id), [near.id]);
});

test('tasksNearLocation matches when an ANCESTOR (parent task) carries the geo', () => {
  const db = openMemoryDb();
  const parent = createItem(db, DEVICE, { title: 'At the shops' });
  updateItem(db, DEVICE, parent.id, { geo: geo({ label: 'Coles' }) });
  const child = createItem(db, DEVICE, { title: 'Grab bread', parentId: parent.id });
  const grandchild = createItem(db, DEVICE, { title: 'wholegrain', parentId: child.id });

  const hit = tasksNearLocation(db, { zone: 'Coles' });
  const ids = new Set(hit.map((i) => i.id));
  // Parent, child and grandchild are all active tasks → all match (parent via own
  // geo, descendants via ancestor geo).
  assert.ok(ids.has(parent.id));
  assert.ok(ids.has(child.id));
  assert.ok(ids.has(grandchild.id));
});

test('tasksNearLocation matches via the PROJECT ancestor', () => {
  const db = openMemoryDb();
  const project = createItem(db, DEVICE, { type: 'project', title: 'Groceries' });
  updateItem(db, DEVICE, project.id, { geo: geo({ label: 'Coles' }) });
  const task = createItem(db, DEVICE, { title: 'Milk', parentId: project.id });

  const hit = tasksNearLocation(db, { zone: 'coles' });
  // Projects are not tasks, so only the task is returned.
  assert.deepEqual(hit.map((i) => i.id), [task.id]);
});

test('tasksNearLocation de-duplicates when both task and ancestor match', () => {
  const db = openMemoryDb();
  const parent = createItem(db, DEVICE, { title: 'parent' });
  updateItem(db, DEVICE, parent.id, { geo: geo({ label: 'Coles' }) });
  const child = createItem(db, DEVICE, { title: 'child', parentId: parent.id });
  updateItem(db, DEVICE, child.id, { geo: geo({ label: 'Coles' }) });

  const hit = tasksNearLocation(db, { zone: 'Coles' });
  assert.equal(hit.filter((i) => i.id === child.id).length, 1);
});

test('tasksNearLocation returns nothing with no location and excludes non-matches', () => {
  const db = openMemoryDb();
  const t = createItem(db, DEVICE, { title: 'Buy milk' });
  updateItem(db, DEVICE, t.id, { geo: geo({ label: 'Coles' }) });

  // No location at all.
  assert.deepEqual(tasksNearLocation(db, {}), []);
  // A different zone, and a point far from the geo.
  assert.deepEqual(tasksNearLocation(db, { zone: 'Home' }), []);
  assert.deepEqual(tasksNearLocation(db, { point: { lat: 0, lng: 0 } }), []);
});

test('tasksNearLocation matches via a TAG location when the task has none', () => {
  const db = openMemoryDb();
  createTag(db, DEVICE, 'Errands');
  updateTag(db, DEVICE, tagId('Errands'), { geo: geo({ label: 'Coles' }) });
  const task = createItem(db, DEVICE, { title: 'Milk' });
  setItemTags(db, DEVICE, task.id, [tagId('Errands')]);
  const untagged = createItem(db, DEVICE, { title: 'no tag' });

  const hit = tasksNearLocation(db, { zone: 'coles' });
  assert.deepEqual(hit.map((i) => i.id), [task.id]);
  assert.ok(!hit.some((i) => i.id === untagged.id));
});

test('task location overrides its tag and project (task > tag > project)', () => {
  const db = openMemoryDb();
  const project = createItem(db, DEVICE, { type: 'project', title: 'Groceries' });
  updateItem(db, DEVICE, project.id, { geo: geo({ label: 'Project' }) });
  createTag(db, DEVICE, 'Errands');
  updateTag(db, DEVICE, tagId('Errands'), { geo: geo({ label: 'Tag' }) });
  const task = createItem(db, DEVICE, { title: 'Milk', parentId: project.id });
  setItemTags(db, DEVICE, task.id, [tagId('Errands')]);
  updateItem(db, DEVICE, task.id, { geo: geo({ label: 'Task' }) });

  // The task's own location wins; the tag/project labels do not match it.
  assert.deepEqual(tasksNearLocation(db, { zone: 'Task' }).map((i) => i.id), [task.id]);
  // It still matches its tag's zone (tag overrides project) when the task has no own geo.
  updateItem(db, DEVICE, task.id, { geo: null });
  assert.deepEqual(tasksNearLocation(db, { zone: 'Tag' }).map((i) => i.id), [task.id]);
});

test('tasksNearLocation ignores done/deleted tasks', () => {
  const db = openMemoryDb();
  const done = createItem(db, DEVICE, { title: 'done' });
  updateItem(db, DEVICE, done.id, { geo: geo({ label: 'Coles' }), status: 'done' });
  const del = createItem(db, DEVICE, { title: 'deleted' });
  updateItem(db, DEVICE, del.id, { geo: geo({ label: 'Coles' }), deleted: true });

  assert.deepEqual(tasksNearLocation(db, { zone: 'Coles' }), []);
});
