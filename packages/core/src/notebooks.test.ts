import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import { MIGRATIONS } from './schema';
import {
  createItem,
  updateItem,
  getItem,
  addAttachment,
  defaultChildType,
  inNotesProject,
  createSiblingAfter,
  collectBlobRefs,
  firstBlobRef,
  parseThumb,
  itemsNeedingThumb,
  blobRefIndex,
} from './repo';

function makeDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  return {
    run: (sql: string, params: SqlParams = []) => void sqlite.prepare(sql).run(...params),
    all: <T>(sql: string, params: SqlParams = []) => sqlite.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: SqlParams = []) =>
      sqlite.prepare(sql).get(...params) as T | undefined,
    exec: (sql: string) => sqlite.exec(sql),
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const r = fn();
        sqlite.exec('COMMIT');
        return r;
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

const DEV = 'test-device';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

// ----- migration v22 --------------------------------------------------------

test('migration v22 defaults existing items to notes_project=0 / thumb=null', () => {
  const db = openDbAtVersion(21);
  db.run(
    `INSERT INTO items (id, parent_id, type, title, status, sort_order, created_at, updated_at, clocks)
     VALUES ('p1', NULL, 'project', 'Legacy', 'active', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}')`,
  );

  migrate(db);

  const p = getItem(db, 'p1')!;
  assert.equal(p.notes_project, false);
  assert.equal(p.thumb, null);
  assert.equal(p.title, 'Legacy'); // nothing else disturbed
});

// ----- notes containers -----------------------------------------------------

test('a project can be flipped to a notes container and back', () => {
  const db = openDb();
  const p = createItem(db, DEV, { type: 'project', title: 'Notebook' });
  assert.equal(p.notes_project, false);

  updateItem(db, DEV, p.id, { notes_project: true });
  assert.equal(getItem(db, p.id)!.notes_project, true);
  assert.equal(getItem(db, p.id)!.type, 'project'); // still a project everywhere else

  updateItem(db, DEV, p.id, { notes_project: false });
  assert.equal(getItem(db, p.id)!.notes_project, false);
});

test('new children of a notes container default to notes, elsewhere to tasks', () => {
  const db = openDb();
  const plain = createItem(db, DEV, { type: 'project', title: 'Work' });
  const book = createItem(db, DEV, { type: 'project', title: 'Notebook', notesProject: true });

  assert.equal(defaultChildType(db, plain.id), 'task');
  assert.equal(defaultChildType(db, book.id), 'note');
  assert.equal(defaultChildType(db, null), 'task'); // inbox

  assert.equal(createItem(db, DEV, { title: 'a', parentId: plain.id }).type, 'task');
  assert.equal(createItem(db, DEV, { title: 'b', parentId: book.id }).type, 'note');
  // Explicit beats inferred — an agent/import can still put a task in a notebook.
  assert.equal(
    createItem(db, DEV, { title: 'c', parentId: book.id, type: 'task' }).type,
    'task',
  );
});

test('the notes default is inherited through nesting, and by siblings', () => {
  const db = openDb();
  const book = createItem(db, DEV, { type: 'project', title: 'Notebook', notesProject: true });
  const note = createItem(db, DEV, { title: 'top', parentId: book.id });

  // A child of a note inside a notebook is still a note (nearest project ancestor).
  assert.equal(inNotesProject(db, note.id), true);
  assert.equal(createItem(db, DEV, { title: 'nested', parentId: note.id }).type, 'note');
  // The outliner's Enter-to-add-sibling path goes through createSiblingAfter.
  assert.equal(createSiblingAfter(db, DEV, note.id, null).type, 'note');
});

test('flipping a project back to tasks only affects newly-created children', () => {
  const db = openDb();
  const book = createItem(db, DEV, { type: 'project', title: 'Notebook', notesProject: true });
  const note = createItem(db, DEV, { title: 'kept', parentId: book.id });

  updateItem(db, DEV, book.id, { notes_project: false });

  assert.equal(getItem(db, note.id)!.type, 'note'); // existing items are untouched
  assert.equal(createItem(db, DEV, { title: 'new', parentId: book.id }).type, 'task');
});

// ----- blob references / thumbnails -----------------------------------------

test('collectBlobRefs / firstBlobRef read image references out of a body', () => {
  const body = `intro\n![one](/api/blobs/${H1})\nmiddle\n![two](/api/blobs/${H2})`;
  assert.deepEqual(collectBlobRefs(body), [H1, H2]);
  assert.equal(firstBlobRef(body), H1); // document order — the row's image
  assert.equal(firstBlobRef('no images here'), null);
  assert.equal(firstBlobRef(null), null);
  // Hashes are minted lowercase but a hand-edited body could be uppercase.
  assert.deepEqual(collectBlobRefs(`![x](/api/blobs/${H1.toUpperCase()})`), [H1]);
});

test('parseThumb survives missing and malformed values', () => {
  assert.equal(parseThumb({ thumb: null }), null);
  assert.equal(parseThumb({ thumb: 'not json' }), null);
  assert.equal(parseThumb({ thumb: '{"w":1}' }), null); // no src/hash
  assert.deepEqual(parseThumb({ thumb: JSON.stringify({ src: H1, hash: H2, w: 8, h: 6 }) }), {
    src: H1,
    hash: H2,
    w: 8,
    h: 6,
  });
});

test('itemsNeedingThumb finds notes with a new, changed, or orphaned thumbnail', () => {
  const db = openDb();
  const missing = createItem(db, DEV, { title: 'missing', note: `![a](/api/blobs/${H1})` });
  const current = createItem(db, DEV, { title: 'current', note: `![a](/api/blobs/${H1})` });
  const stale = createItem(db, DEV, { title: 'stale', note: `![b](/api/blobs/${H2})` });
  const orphan = createItem(db, DEV, { title: 'orphan', note: 'just words' });
  createItem(db, DEV, { title: 'imageless', note: 'just words' });

  updateItem(db, DEV, current.id, {
    thumb: JSON.stringify({ src: H1, hash: H3, w: 4, h: 4 }),
  });
  // Thumbnail left over from a previous first image.
  updateItem(db, DEV, stale.id, { thumb: JSON.stringify({ src: H1, hash: H3, w: 4, h: 4 }) });
  // Image removed from the body but thumb left behind (remote clear, failed clear, …).
  updateItem(db, DEV, orphan.id, { thumb: JSON.stringify({ src: H1, hash: H3, w: 4, h: 4 }) });

  const ids = itemsNeedingThumb(db).map((i) => i.id).sort();
  assert.deepEqual(ids, [missing.id, stale.id, orphan.id].sort());
});

test('blobRefIndex separates always-kept thumbnails from evictable content', () => {
  const db = openDb();
  const note = createItem(db, DEV, { title: 'photo', note: `![a](/api/blobs/${H1})` });
  updateItem(db, DEV, note.id, { thumb: JSON.stringify({ src: H1, hash: H2, w: 4, h: 4 }) });
  const task = createItem(db, DEV, { title: 'with file' });
  addAttachment(db, DEV, {
    parentType: 'item',
    parentId: task.id,
    itemId: task.id,
    filename: 'f.pdf',
    mimeType: 'application/pdf',
    size: 10,
    hash: H3,
    createdBy: null,
  });

  const { thumbs, full } = blobRefIndex(db);
  assert.deepEqual([...thumbs], [H2]);
  assert.deepEqual([...full].sort(), [H1, H3].sort());
});

test('blobRefIndex ignores deleted items and keeps thumbnail status when a hash is both', () => {
  const db = openDb();
  const gone = createItem(db, DEV, { title: 'gone', note: `![a](/api/blobs/${H1})` });
  updateItem(db, DEV, gone.id, { deleted: true });
  // Pathological but possible: the same blob referenced as a body image on one
  // item and as another's thumbnail. Thumbnail retention must win.
  const body = createItem(db, DEV, { title: 'body', note: `![a](/api/blobs/${H2})` });
  updateItem(db, DEV, body.id, { thumb: JSON.stringify({ src: H3, hash: H2, w: 4, h: 4 }) });

  const { thumbs, full } = blobRefIndex(db);
  assert.equal(full.has(H1), false);
  assert.equal(thumbs.has(H2), true);
  assert.equal(full.has(H2), false);
});
