/**
 * Blob storage route tests. Uses a real temporary directory (like the server does)
 * since blobs are stored on-disk by SHA256 hash.
 */
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';
import {
  visibleItemIds,
  addAttachment,
  createItem,
} from '@carbon/core';

const MAX_BLOB_BYTES = 25 * 1024 * 1024; // 25 MB

function buildBlobsApp(db: TestDb, deviceId: string, blobsDir: string) {
  const app = makeHono(db, false);
  const isHash = (h: string) => /^[a-f0-9]{64}$/.test(h);

  function isBot(userId: string): boolean {
    const u = db.get<{ is_bot: number }>('SELECT is_bot FROM users WHERE id = ?', [userId]);
    return !!u?.is_bot;
  }

  function canReadBlob(userId: string, hash: string): boolean {
    if (isBot(userId)) return true;
    const rows = db.all<{ item_id: string | null; parent_type: string; parent_id: string }>(
      'SELECT item_id, parent_type, parent_id FROM attachments WHERE hash = ? AND deleted = 0',
      [hash],
    );
    const visible = visibleItemIds(db, userId);
    for (const r of rows) {
      const itemId = r.item_id ?? (r.parent_type === 'item' ? r.parent_id : null);
      if (itemId && visible.has(itemId)) return true;
    }
    // Mirrors production: note-embedded images have no attachments row — grant
    // read when a live, visible item's note body references the hash.
    const noteRefs = db.all<{ id: string }>(
      "SELECT id FROM items WHERE deleted = 0 AND note LIKE '%/api/blobs/' || ? || '%'",
      [hash],
    );
    return noteRefs.some((r) => visible.has(r.id));
  }

  app.get('/blobs/:hash', (c) => {
    const hash = c.req.param('hash');
    if (!isHash(hash)) return c.json({ error: 'bad hash' }, 400);
    if (!canReadBlob(c.get('userId'), hash)) return c.json({ error: 'not found' }, 404);
    const path = join(blobsDir, hash);
    if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
    return new Response(new Uint8Array(readFileSync(path)), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });

  app.post('/blobs/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!isHash(hash)) return c.json({ error: 'bad hash' }, 400);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared && declared > MAX_BLOB_BYTES) return c.json({ error: 'blob too large' }, 413);
    const path = join(blobsDir, hash);
    if (!existsSync(path)) {
      const buf = Buffer.from(await c.req.arrayBuffer());
      if (buf.length > MAX_BLOB_BYTES) return c.json({ error: 'blob too large' }, 413);
      const actual = createHash('sha256').update(buf).digest('hex');
      if (actual !== hash) return c.json({ error: 'content does not match hash' }, 400);
      writeFileSync(path, buf);
    }
    return c.json({ ok: true });
  });

  return app;
}

// Helper: hash some bytes and return { hash, data }
function makeBlob(content: string): { hash: string; data: Buffer } {
  const data = Buffer.from(content, 'utf8');
  const hash = createHash('sha256').update(data).digest('hex');
  return { hash, data };
}

let blobsDir: string;

before(() => {
  blobsDir = mkdtempSync(join(tmpdir(), 'carbon-blobs-test-'));
});

after(() => {
  rmSync(blobsDir, { recursive: true, force: true });
});

// ─── upload ───────────────────────────────────────────────────────────────────

describe('POST /blobs/:hash — upload', () => {
  test('uploads a blob with correct hash', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw', 'admin');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const { hash, data } = makeBlob('Hello, blob!');
    const res = await appFetch(app, `/blobs/${hash}`, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Length': String(data.length) },
      body: data,
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
    assert.ok(existsSync(join(blobsDir, hash)), 'file written to disk');
  });

  test('upload is idempotent — re-uploading same hash returns 200', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw', 'admin');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const { hash, data } = makeBlob('Idempotent blob content');
    await appFetch(app, `/blobs/${hash}`, {
      method: 'POST',
      headers: { Authorization: basic },
      body: data,
    });
    const res2 = await appFetch(app, `/blobs/${hash}`, {
      method: 'POST',
      headers: { Authorization: basic },
      body: data,
    });
    assert.equal(res2.status, 200, 're-upload is idempotent');
  });

  test('rejects upload where content does not match declared hash', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw', 'admin');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const { hash } = makeBlob('Original content');
    const tampered = Buffer.from('Tampered!', 'utf8');
    const res = await appFetch(app, `/blobs/${hash}`, {
      method: 'POST',
      headers: { Authorization: basic },
      body: tampered,
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('match'), 'error mentions hash mismatch');
  });

  test('returns 400 for bad hash format', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw', 'admin');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const res = await appFetch(app, '/blobs/not-a-valid-hash', {
      method: 'POST',
      headers: { Authorization: basic },
      body: Buffer.from('data'),
    });
    assert.equal(res.status, 400);
  });

  test('returns 401 when unauthenticated', async () => {
    const { db, deviceId } = makeTestDb();
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const { hash, data } = makeBlob('Unauthed');
    const res = await appFetch(app, `/blobs/${hash}`, { method: 'POST', body: data });
    assert.equal(res.status, 401);
  });
});

// ─── download ─────────────────────────────────────────────────────────────────

describe('GET /blobs/:hash — download', () => {
  test('owner can download a blob they have an attachment for', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const { hash, data } = makeBlob(`owner download test ${Date.now()}`);

    // Upload
    await appFetch(app, `/blobs/${hash}`, {
      method: 'POST',
      headers: { Authorization: basic },
      body: data,
    });

    // Create item + attachment so canReadBlob passes
    const task = createItem(db, deviceId, { type: 'task', title: 'With blob', ownerId: userId });
    addAttachment(db, deviceId, {
      parentType: 'item',
      parentId: task.id,
      itemId: task.id,
      filename: 'file.bin',
      mimeType: null,
      size: data.length,
      hash,
      createdBy: userId,
    });

    const res = await appFetch(app, `/blobs/${hash}`, { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const downloaded = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(downloaded, data, 'downloaded content matches uploaded');
  });

  test('returns 404 when blob exists but user has no attachment reference', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic: aliceBasic } = addUser('alice', 'pw');
    const { basic: bobBasic } = addUser('bob', 'pw');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const { hash, data } = makeBlob(`no-ref test ${Date.now()}`);

    // Alice uploads
    await appFetch(app, `/blobs/${hash}`, {
      method: 'POST',
      headers: { Authorization: aliceBasic },
      body: data,
    });

    // Bob tries to download without any attachment record
    const res = await appFetch(app, `/blobs/${hash}`, { headers: { Authorization: bobBasic } });
    assert.equal(res.status, 404);
  });

  test('owner can download a blob referenced only by their note body (no attachment row)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const { hash, data } = makeBlob(`note-embedded image ${Date.now()}`);

    await appFetch(app, `/blobs/${hash}`, {
      method: 'POST',
      headers: { Authorization: basic },
      body: data,
    });

    // The Notes flow inserts `![alt](/api/blobs/{hash})` into the body and never
    // creates an attachments row — the note reference alone must grant the read.
    createItem(db, deviceId, {
      type: 'note',
      title: 'With inline image',
      ownerId: userId,
      note: `some text\n\n![screenshot](/api/blobs/${hash})\n`,
    });

    const res = await appFetch(app, `/blobs/${hash}`, { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const downloaded = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(downloaded, data, 'downloaded content matches uploaded');
  });

  test("returns 404 when only another user's note references the blob", async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId, basic: aliceBasic } = addUser('alice', 'pw');
    const { basic: bobBasic } = addUser('bob', 'pw');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const { hash, data } = makeBlob(`private note image ${Date.now()}`);

    await appFetch(app, `/blobs/${hash}`, {
      method: 'POST',
      headers: { Authorization: aliceBasic },
      body: data,
    });
    createItem(db, deviceId, {
      type: 'note',
      title: 'Alice private note',
      ownerId: aliceId,
      note: `![secret](/api/blobs/${hash})`,
    });

    const res = await appFetch(app, `/blobs/${hash}`, { headers: { Authorization: bobBasic } });
    assert.equal(res.status, 404);
  });

  test('returns 404 for nonexistent hash', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const fakeHash = '0'.repeat(64);
    const res = await appFetch(app, `/blobs/${fakeHash}`, { headers: { Authorization: basic } });
    assert.equal(res.status, 404);
  });

  test('returns 400 for malformed hash', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildBlobsApp(db, deviceId, blobsDir);
    const res = await appFetch(app, '/blobs/tooshort', { headers: { Authorization: basic } });
    assert.equal(res.status, 400);
  });
});
