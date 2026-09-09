import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createUser, createItem, addAttachment } from '@carbon/core';
import { initTenantDb } from './tenant';
import { createSession } from './auth';
import { appFetch } from './test-app';
import { listOpenNotices } from './notices';
import type { DeliverToPeer } from './federation';

/**
 * A5 — blob-reference inventory feeds the reconcile.
 *
 * The reconcile (A4) must report every blob reference — not just attachments —
 * when its content is missing or diverged. A workspace with a MISSING-blob
 * reference (note image + attachment, content never uploaded) and a DIVERGED-blob
 * reference (row thumbnail whose stored bytes no longer hash to the name) is
 * REPORTED, never silently dropped. This mirrors A4's 404-not-corrupt contract and
 * exercises at least one reference of each of the three kinds (note / thumb /
 * attachment).
 */

const TMP = `/tmp/carbon-a5-inv-${process.pid}`;
process.env.DATABASE_PATH = `${TMP}/carbon.db`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.BLOBS_DIR = `${TMP}/blobs`;
process.env.CARBON_NO_AUTOSTART = '1';

const NO_DELIVERY: DeliverToPeer = async () =>
  new Response(JSON.stringify({ error: 'no delivery in test' }), { status: 501 });

let _build: typeof import('./index').buildTenantApp | null = null;
async function build(): Promise<typeof import('./index').buildTenantApp> {
  if (!_build) _build = (await import('./index')).buildTenantApp;
  return _build;
}

function ctx(name: string) {
  mkdirSync(`${TMP}/${name}`, { recursive: true });
  const c = initTenantDb({
    id: 'default',
    subdomain: '',
    dbPath: `${TMP}/${name}/carbon.db`,
    blobsDir: `${TMP}/${name}/blobs`,
  });
  return c;
}

const CONTENT = Buffer.from('a5-inventory-content-0123456789');
const H_NOTE = createHash('sha256').update(CONTENT).digest('hex'); // note image — content never uploaded
const H_ATT = createHash('sha256').update(Buffer.from('a5-att-bytes')).digest('hex'); // attachment — content never uploaded
const H_THUMB = createHash('sha256').update(Buffer.from('a5-thumb-bytes')).digest('hex'); // thumb — diverged file

test('reconcile reports a missing AND a diverged reference across note/thumb/attachment', async () => {
  const t = ctx('inventory');
  const alice = createUser(t.db, { username: 'alice', displayName: 'Alice', role: 'member' });
  const admin = createUser(t.db, { username: 'admin', displayName: 'Admin', role: 'admin' });
  const aliceTok = createSession(t.db, alice.id);
  const adminTok = createSession(t.db, admin.id);
  const app = (await build())(t, NO_DELIVERY);

  // A note item whose body references a blob whose content was never uploaded.
  const note = createItem(t.db, 'd', {
    type: 'note',
    title: 'n',
    note: `![img](/api/blobs/${H_NOTE})`,
    ownerId: alice.id,
  });
  // The same item carries a row thumbnail whose stored file is DIVERGED.
  t.db.run('UPDATE items SET thumb = ? WHERE id = ?', [
    JSON.stringify({ src: H_NOTE, hash: H_THUMB, w: 1, h: 1 }),
    note.id,
  ]);
  writeFileSync(`${TMP}/inventory/blobs/${H_THUMB}`, Buffer.from('corrupted-thumb-bytes'));

  // An item-attached blob whose content was never uploaded.
  addAttachment(t.db, 'd', {
    parentType: 'item',
    parentId: note.id,
    itemId: note.id,
    filename: 'a.bin',
    mimeType: 'application/octet-stream',
    size: 4,
    hash: H_ATT,
    createdBy: alice.id,
  });

  const res = await appFetch(app, '/api/admin/blobs/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200, 'admin reconcile endpoint');
  const report = (await res.json()) as { missing: string[]; diverged: string[] };

  // Missing: the note image and the attachment both reference content that was never
  // uploaded → reported as missing (content-pending), not a silent 404.
  assert.ok(report.missing.includes(H_NOTE), 'note-image reference reported missing');
  assert.ok(report.missing.includes(H_ATT), 'attachment reference reported missing');
  // Diverged: the thumbnail's stored bytes don't hash to its name → reported diverged.
  assert.ok(report.diverged.includes(H_THUMB), 'thumbnail reference reported diverged');
  // The diverged hash must not also be reported missing, and the healthy content
  // (none here) must not appear at all.
  assert.ok(!report.missing.includes(H_THUMB), 'diverged is not also reported missing');

  // The affected owner is told (not silently discarded).
  const notices = listOpenNotices(t.db, alice.id);
  assert.ok(notices.some((n) => n.kind === 'blob_content_missing'), 'owner gets a notice');

  // The report is not polluted by the session/identity plumbing.
  assert.ok(report.missing.every((h) => h === h.toLowerCase()), 'hashes lowercased');
  void aliceTok;
  void randomUUID;
});
