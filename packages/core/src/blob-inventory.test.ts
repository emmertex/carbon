import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import { createItem, addAttachment, addComment, blobReferenceInventory } from './repo';

// A5 — blob-reference inventory. The inventory is the single source of truth for
// "every blob the workspace references" (note images, thumbnails, attachments),
// so export, import verification, reconcile, and orphan cleanup all reason about
// provenance from one place instead of re-scanning.

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

/** A distinct, valid 64-lowercase-hex content hash (a real sha-256 digest). */
function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

const DEV = 'test-device';

test('blobReferenceInventory enumerates note images, thumbs, item + comment attachments', () => {
  const db = openDb();
  const hNote = hash('noteimg');
  const hThumb = hash('thumb');
  const hItemAtt = hash('itematt');
  const hCommentAtt = hash('commentatt');

  // A note item whose body references an image.
  const note = createItem(db, DEV, { type: 'note', title: 'N', note: `![x](/api/blobs/${hNote})` });
  // Give it a row thumbnail (client-written; set the column directly).
  db.run('UPDATE items SET thumb = ? WHERE id = ?', [
    JSON.stringify({ src: hNote, hash: hThumb, w: 1, h: 1 }),
    note.id,
  ]);
  // An item-attached blob.
  addAttachment(db, DEV, {
    parentType: 'item',
    parentId: note.id,
    itemId: note.id,
    filename: 'f.bin',
    mimeType: 'application/octet-stream',
    size: 4,
    hash: hItemAtt,
    createdBy: null,
  });

  // A second item that carries a comment; the comment carries an attached blob.
  const host = createItem(db, DEV, { type: 'task', title: 'H' });
  const comment = addComment(db, DEV, { itemId: host.id, authorId: null, body: 'hi' });
  addAttachment(db, DEV, {
    parentType: 'comment',
    parentId: comment.id,
    itemId: host.id,
    filename: 'c.bin',
    mimeType: 'application/octet-stream',
    size: 4,
    hash: hCommentAtt,
    createdBy: null,
  });

  const { refs, byHash } = blobReferenceInventory(db, { includeDeleted: false });

  // All four references are present, with the right provenance.
  assert.ok(byHash.has(hNote), 'note image ref');
  assert.equal(byHash.get(hNote)!.kind, 'note');
  assert.equal(byHash.get(hNote)!.itemId, note.id);

  assert.ok(byHash.has(hThumb), 'thumbnail ref');
  assert.equal(byHash.get(hThumb)!.kind, 'thumb');
  assert.equal(byHash.get(hThumb)!.itemId, note.id);

  assert.ok(byHash.has(hItemAtt), 'item-attachment ref');
  assert.equal(byHash.get(hItemAtt)!.kind, 'attachment');
  assert.equal(byHash.get(hItemAtt)!.itemId, note.id);
  assert.ok(byHash.get(hItemAtt)!.attachmentId, 'attachment id recorded');

  // A comment-attached blob resolves to the comment's ITEM (not the comment).
  assert.ok(byHash.has(hCommentAtt), 'comment-attachment ref');
  assert.equal(byHash.get(hCommentAtt)!.kind, 'attachment');
  assert.equal(byHash.get(hCommentAtt)!.itemId, host.id);
  assert.ok(!byHash.get(hCommentAtt)!.deleted, 'live item ref is not deleted');

  // The full list keeps every per-row reference (4 distinct hashes here).
  assert.equal(refs.length, 4);
});

test('blobReferenceInventory de-duplicates by hash with thumb priority', () => {
  const db = openDb();
  const h = hash('dual');
  const note = createItem(db, DEV, { type: 'note', title: 'D', note: `![x](/api/blobs/${h})` });
  // The SAME hash is both the note's image and the row's thumbnail.
  db.run('UPDATE items SET thumb = ? WHERE id = ?', [
    JSON.stringify({ src: h, hash: h, w: 1, h: 1 }),
    note.id,
  ]);

  const { refs, byHash } = blobReferenceInventory(db, { includeDeleted: false });

  // Two per-row refs (note + thumb) for the same hash…
  const forHash = refs.filter((r) => r.hash === h);
  assert.equal(forHash.length, 2, 'both the note and thumb references are kept');
  // …but byHash keeps the stronger-retention kind (thumb wins).
  assert.equal(byHash.get(h)!.kind, 'thumb');
});

test('blobReferenceInventory honors includeDeleted (trashed refs kept only when asked)', () => {
  const db = openDb();
  const h = hash('trashed');
  const item = createItem(db, DEV, { type: 'note', title: 'T', note: `![x](/api/blobs/${h})` });
  // Tombstone the item (raw flag — the inventory only reads items.deleted).
  db.run('UPDATE items SET deleted = 1 WHERE id = ?', [item.id]);

  const live = blobReferenceInventory(db, { includeDeleted: false });
  assert.ok(!live.byHash.has(h), 'trashed ref excluded when includeDeleted:false');

  const all = blobReferenceInventory(db, { includeDeleted: true });
  assert.ok(all.byHash.has(h), 'trashed ref included when includeDeleted:true');
  assert.equal(all.byHash.get(h)!.deleted, true, 'trashed ref flagged deleted');
});

test('blobReferenceInventory skips detached (deleted) attachment rows', () => {
  const db = openDb();
  const h = hash('detached');
  const item = createItem(db, DEV, { type: 'task', title: 'A' });
  const att = addAttachment(db, DEV, {
    parentType: 'item',
    parentId: item.id,
    itemId: item.id,
    filename: 'd.bin',
    mimeType: 'application/octet-stream',
    size: 4,
    hash: h,
    createdBy: null,
  });
  // Detach the file: the row is tombstoned and no longer references the blob.
  db.run('UPDATE attachments SET deleted = 1 WHERE id = ?', [att.id]);

  const { byHash } = blobReferenceInventory(db, { includeDeleted: true });
  assert.ok(!byHash.has(h), 'a detached attachment does not reference its blob');
});
