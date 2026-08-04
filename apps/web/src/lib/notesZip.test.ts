import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync, strFromU8 } from 'fflate';
import { migrate, createItem, type Db, type SqlParams } from '@carbon/core';
import type { NotesManifest } from './notesZip';

// notesZip reads per-note settings through noteMeta, which pulls in the mutate →
// store → config chain; that chain touches localStorage while the module loads.
// Same in-memory stub + deferred import as where.test.ts.
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { buildNotesFiles, buildNotesZip, collectAssetHashes, listNotes, notesManifest } =
  await import('./notesZip');

// Minimal in-memory Db backed by node:sqlite (mirrors notesMd.test.ts).
function openMemoryDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const db: Db = {
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
  migrate(db);
  return db;
}

const DEV = 'dev';
const H1 = 'a'.repeat(64); // fake sha-256 asset hashes
const H2 = 'b'.repeat(64);

/** A getAsset resolver over an in-memory hash->bytes map. */
function assetMap(map: Record<string, Uint8Array>) {
  return async (hash: string) => map[hash] ?? null;
}

describe('collectAssetHashes()', () => {
  test('extracts hashes from markdown and bare /api/blobs refs, de-duped', () => {
    const body = `Look ![pic](/api/blobs/${H1}) and again /api/blobs/${H1} plus ![](/api/blobs/${H2})`;
    assert.deepEqual(collectAssetHashes(body).sort(), [H1, H2].sort());
  });
  test('empty / null body yields no hashes', () => {
    assert.deepEqual(collectAssetHashes(null), []);
    assert.deepEqual(collectAssetHashes(''), []);
  });
  test('an uppercase hash is captured and normalized to lowercase', () => {
    const upper = H1.toUpperCase();
    const body = `![pic](/api/blobs/${upper}) and lowercase /api/blobs/${H1}`;
    // Both references point at the same (case-insensitive) hash, so they de-dupe to one.
    assert.deepEqual(collectAssetHashes(body), [H1]);
  });
});

describe('buildNotesFiles()', () => {
  test('lays out notes/*.md with frontmatter, assets/{hash}, manifest.json', async () => {
    const db = openMemoryDb();
    const n1 = createItem(db, DEV, {
      type: 'note',
      title: 'Groceries',
      note: `- milk\n![pic](/api/blobs/${H1})`,
    });
    const n2 = createItem(db, DEV, {
      type: 'note',
      title: 'Ideas',
      note: `thoughts /api/blobs/${H2}`,
      parentId: n1.id,
    });
    // A task must NOT be exported.
    createItem(db, DEV, { type: 'task', title: 'a task', note: 'not a note' });

    const { files, missingAssets } = await buildNotesFiles(
      db,
      assetMap({ [H1]: new Uint8Array([1, 2, 3]), [H2]: new Uint8Array([4]) }),
    );
    assert.deepEqual(missingAssets, [], 'both referenced assets resolved');
    const paths = Object.keys(files).sort();

    assert.ok(paths.includes('notes/groceries.md'), 'note md by slug');
    assert.ok(paths.includes('notes/ideas.md'));
    assert.ok(paths.includes(`assets/${H1}`), 'referenced asset bundled');
    assert.ok(paths.includes(`assets/${H2}`));
    assert.ok(paths.includes('manifest.json'));
    // No task file leaked in.
    assert.ok(!paths.some((p) => p.startsWith('notes/') && strFromU8(files[p]!).includes('not a note')));

    // Frontmatter present in a note md.
    const groceries = strFromU8(files['notes/groceries.md']!);
    assert.ok(groceries.startsWith('---\ntitle: Groceries'), 'YAML frontmatter emitted');
    assert.ok(groceries.includes('- milk'), 'body preserved');
    // The image ref is rewritten to the bundled asset's path (relative to notes/,
    // one level up) — /api/blobs/{hash} has no server to resolve against once this
    // is just a folder on disk.
    assert.ok(
      groceries.includes(`![pic](../assets/${H1})`),
      `expected rewritten relative asset ref, got: ${groceries}`,
    );
    assert.ok(!groceries.includes('/api/blobs/'), 'no server-relative refs left in the exported body');

    // Child note records its parent in frontmatter.
    const ideas = strFromU8(files['notes/ideas.md']!);
    assert.ok(ideas.includes(`parent: ${n1.id}`), 'parent frontmatter for nested note');

    // Manifest shape.
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as NotesManifest;
    assert.equal(manifest.format, 'carbon-notes');
    assert.equal(manifest.version, 1);
    assert.equal(manifest.notes.length, 2);
    const gEntry = manifest.notes.find((n) => n.id === n1.id)!;
    assert.equal(gEntry.slug, 'groceries.md');
    assert.equal(gEntry.parent, null);
    assert.deepEqual(gEntry.assets, [H1]);
    const iEntry = manifest.notes.find((n) => n.id === n2.id)!;
    assert.equal(iEntry.parent, n1.id);
    assert.deepEqual(iEntry.assets, [H2]);
  });

  test('de-dupes slug collisions with a numeric suffix', async () => {
    const db = openMemoryDb();
    createItem(db, DEV, { type: 'note', title: 'Same Title', note: 'one' });
    createItem(db, DEV, { type: 'note', title: 'Same Title', note: 'two' });
    createItem(db, DEV, { type: 'note', title: 'Same Title', note: 'three' });

    const { files } = await buildNotesFiles(db, assetMap({}));
    const noteFiles = Object.keys(files).filter((p) => p.startsWith('notes/')).sort();
    assert.deepEqual(noteFiles, [
      'notes/same-title-2.md',
      'notes/same-title-3.md',
      'notes/same-title.md',
    ]);

    // Manifest slugs are unique too.
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as NotesManifest;
    const slugs = manifest.notes.map((n) => n.slug).sort();
    assert.deepEqual(new Set(slugs).size, 3, 'all slugs distinct');
  });

  test('non-Latin titles get distinct id-derived slugs instead of colliding on "note"', async () => {
    const db = openMemoryDb();
    createItem(db, DEV, { type: 'note', title: '買い物リスト' });
    createItem(db, DEV, { type: 'note', title: 'Списък за пазаруване' });

    const { files } = await buildNotesFiles(db, assetMap({}));
    const noteFiles = Object.keys(files).filter((p) => p.startsWith('notes/'));
    assert.equal(noteFiles.length, 2, 'both notes got their own file');
    assert.ok(
      noteFiles.every((p) => /^notes\/note-[0-9a-f]{8}\.md$/.test(p)),
      `expected id-derived slugs, got: ${noteFiles.join(', ')}`,
    );
    assert.notEqual(noteFiles[0], noteFiles[1], 'slugs are distinct, not note.md/note-2.md');
  });

  test('a referenced asset that is unavailable is omitted but still recorded in manifest', async () => {
    const db = openMemoryDb();
    createItem(db, DEV, { type: 'note', title: 'Broken', note: `![x](/api/blobs/${H1})` });
    const { files, missingAssets } = await buildNotesFiles(db, assetMap({})); // resolver returns null
    assert.ok(!(`assets/${H1}` in files), 'missing blob not bundled');
    assert.deepEqual(missingAssets, [H1], 'reported as missing so the caller can warn the user');
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as NotesManifest;
    assert.deepEqual(manifest.notes[0]!.assets, [H1], 'reference still recorded');
  });
});

describe('buildNotesZip()', () => {
  test('produces a real zip whose entries round-trip through unzipSync', async () => {
    const db = openMemoryDb();
    createItem(db, DEV, { type: 'note', title: 'Zipme', note: `hi ![p](/api/blobs/${H1})` });
    const { bytes, missingAssets } = await buildNotesZip(db, assetMap({ [H1]: new Uint8Array([9, 9, 9]) }));
    assert.deepEqual(missingAssets, []);
    const entries = unzipSync(bytes);
    const paths = Object.keys(entries).sort();
    assert.deepEqual(paths, ['assets/' + H1, 'manifest.json', 'notes/zipme.md']);
    assert.deepEqual([...entries[`assets/${H1}`]!], [9, 9, 9], 'asset bytes intact');
    assert.ok(strFromU8(entries['notes/zipme.md']!).includes('title: Zipme'));
  });

  test('reports missing assets alongside the produced bytes', async () => {
    const db = openMemoryDb();
    createItem(db, DEV, { type: 'note', title: 'Broken', note: `![x](/api/blobs/${H1})` });
    const { bytes, missingAssets } = await buildNotesZip(db, assetMap({}));
    assert.deepEqual(missingAssets, [H1]);
    const entries = unzipSync(bytes);
    assert.ok(!(`assets/${H1}` in entries), 'the zip itself has no bytes for the missing asset');
  });
});

describe('listNotes() / notesManifest()', () => {
  test('listNotes returns only note items', () => {
    const db = openMemoryDb();
    createItem(db, DEV, { type: 'note', title: 'N' });
    createItem(db, DEV, { type: 'task', title: 'T' });
    createItem(db, DEV, { type: 'project', title: 'P' });
    const notes = listNotes(db);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.title, 'N');
  });

  test('notesManifest maps slugs and assets', () => {
    const db = openMemoryDb();
    const n = createItem(db, DEV, { type: 'note', title: 'X', note: `/api/blobs/${H1}` });
    const slugs = new Map([[n.id, 'x']]);
    const m = notesManifest(listNotes(db), slugs);
    assert.equal(m.notes[0]!.slug, 'x.md');
    assert.deepEqual(m.notes[0]!.assets, [H1]);
  });
});
