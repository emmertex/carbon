import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import { MIGRATIONS } from './schema';
import {
  createItem,
  getItem,
  getProjects,
  getFolders,
  projectAncestor,
  moveProjectToFolder,
  deleteFolder,
} from './repo';

function makeDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  return {
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
}

function openDb(): Db {
  const db = makeDb();
  migrate(db);
  return db;
}

/** A db migrated only up to `version`, leaving later migrations unapplied. */
function openDbAtVersion(version: number): Db {
  const db = makeDb();
  for (const m of MIGRATIONS) {
    if (m.version <= version) db.exec(m.up);
  }
  db.run(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(version)],
  );
  return db;
}

const DEVICE = 'test-device';

test('folders are invisible to project/task queries and the parent chain', () => {
  const db = openDb();
  const folder = createItem(db, DEVICE, { type: 'folder', title: 'Work' });
  const project = createItem(db, DEVICE, {
    type: 'project',
    title: 'Launch',
    folderId: folder.id,
  });
  const task = createItem(db, DEVICE, { title: 'do thing', parentId: project.id });

  // getProjects never returns a folder; getFolders returns only folders.
  const projectIds = getProjects(db).map((p) => p.id);
  assert.ok(projectIds.includes(project.id));
  assert.ok(!projectIds.includes(folder.id));
  assert.deepEqual(
    getFolders(db).map((f) => f.id),
    [folder.id],
  );

  // folder_id is membership only; the project's parent_id stays null, so the
  // task's project ancestor is still the project (folders never appear in the chain).
  assert.equal(getItem(db, project.id)?.parent_id, null);
  assert.equal(getItem(db, project.id)?.folder_id, folder.id);
  assert.equal(projectAncestor(db, task.id)?.id, project.id);
});

test('moveProjectToFolder sets folder_id + sort_order in a single op', () => {
  const db = openDb();
  const folder = createItem(db, DEVICE, { type: 'folder', title: 'Home' });
  const project = createItem(db, DEVICE, { type: 'project', title: 'Garden' });

  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops WHERE item_id = ?', [
    project.id,
  ])!.n;
  moveProjectToFolder(db, DEVICE, project.id, folder.id, 42);
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops WHERE item_id = ?', [
    project.id,
  ])!.n;

  assert.equal(after - before, 1, 'should record exactly one op');
  const moved = getItem(db, project.id)!;
  assert.equal(moved.folder_id, folder.id);
  assert.equal(moved.sort_order, 42);

  // Moving back out clears folder_id.
  moveProjectToFolder(db, DEVICE, project.id, null, 7);
  assert.equal(getItem(db, project.id)?.folder_id, null);
});

test('deleteFolder reparents members to top level instead of orphaning them', () => {
  const db = openDb();
  const folder = createItem(db, DEVICE, { type: 'folder', title: 'Errands' });
  const a = createItem(db, DEVICE, { type: 'project', title: 'A', folderId: folder.id });
  const b = createItem(db, DEVICE, { type: 'project', title: 'B', folderId: folder.id });

  deleteFolder(db, DEVICE, folder.id);

  // Folder is gone from getFolders; its projects survive at the top level.
  assert.deepEqual(getFolders(db), []);
  assert.equal(getItem(db, folder.id)?.deleted, true);
  const projectIds = getProjects(db).map((p) => p.id);
  assert.ok(projectIds.includes(a.id) && projectIds.includes(b.id));
  assert.equal(getItem(db, a.id)?.folder_id, null);
  assert.equal(getItem(db, b.id)?.folder_id, null);
});

test('migration v15 preserves data and admits type=folder', () => {
  const db = openDbAtVersion(14);

  // A v14 row (no folder_id column yet). Insert raw to mimic pre-upgrade data.
  db.run(
    `INSERT INTO items (id, type, title, status, sort_order, created_at, updated_at, deleted, clocks)
     VALUES ('p1', 'project', 'Legacy', 'active', 5, '2026-01-01', '2026-01-01', 0, '{}')`,
  );
  // Pre-migration, type='folder' must be rejected by the v14 CHECK constraint.
  assert.throws(() =>
    db.run(
      `INSERT INTO items (id, type, title, status, sort_order, created_at, updated_at, deleted, clocks)
       VALUES ('f0', 'folder', 'X', 'active', 0, '2026-01-01', '2026-01-01', 0, '{}')`,
    ),
  );

  migrate(db);

  // Existing row survived the table rebuild with its fields intact, folder_id null.
  const legacy = getItem(db, 'p1')!;
  assert.equal(legacy.title, 'Legacy');
  assert.equal(legacy.sort_order, 5);
  assert.equal(legacy.folder_id, null);

  // type='folder' now inserts cleanly.
  const folder = createItem(db, DEVICE, { type: 'folder', title: 'New' });
  assert.equal(getItem(db, folder.id)?.type, 'folder');
});
