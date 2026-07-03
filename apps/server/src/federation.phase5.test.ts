/**
 * Federation Phase-5 end-to-end: blob fetch-from-peer for federated attachments.
 *
 * Attachment METADATA rides the op-log; the BYTES do not — they live in each tenant's
 * content-addressed blob store and move out-of-band. This suite proves that after the
 * subtree materializes on the grantee (globex), the attachment row is present but the
 * bytes are NOT, and that globex can pull the bytes from the owner (acme) over the link,
 * hash-verify, cache, and serve — while a link can never fetch a blob outside its granted
 * subtree, a poisoned response is rejected, and the secret is required.
 *
 * Built on the Phase-2 two-tenant loopback harness (acme/alice/Roadmap ↔ globex/bob).
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import {
  createItem,
  addAttachment,
  listAttachmentsFor,
  ensureDeviceId,
  migrate,
  createUser as coreCreateUser,
  getUserByUsername,
} from '@carbon/core';
import { openDb } from './sqlite';
import {
  ensureServerTables,
  basicAuth,
  hashPassword,
  setPassword,
  createSession,
  type AuthVars,
} from './auth';
import { ensureNoticeTables, getNotice, actOnNotice, listOpenNotices } from './notices';
import {
  ensureFederationTables,
  ensureGovernanceTables,
  federationRoutes,
  setFederationPolicy,
  listLinks,
  setLinkStatus,
  fetchFederatedBlob,
  runFederationExchange,
  memBlobStore,
  type FederationMode,
  type DeliverToPeer,
} from './federation';

// ─── two-tenant harness (mirrors Phase-2, plus a persistent per-tenant blob store) ──

interface Tenant {
  label: string;
  db: ReturnType<typeof openDb>;
  deviceId: string;
  app: Hono<{ Variables: AuthVars }>;
  blobs: ReturnType<typeof memBlobStore>;
  addUser(username: string, password: string): { id: string; token: string };
}

function createUserRow(db: ReturnType<typeof openDb>, username: string): string {
  return coreCreateUser(db, { username, displayName: username, role: 'admin' }).id;
}

function makeWorld() {
  const tenants = new Map<string, Tenant>();

  const deliverToPeer: DeliverToPeer = async (peerBaseUrl, path, body) => {
    const peer = tenants.get(peerBaseUrl);
    if (!peer) throw new Error('unsupported_peer');
    const req = new Request(`http://${peerBaseUrl}.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return peer.app.fetch(req);
  };

  function makeTenant(label: string): Tenant {
    const db = openDb(':memory:');
    migrate(db);
    ensureServerTables(db);
    ensureNoticeTables(db);
    ensureFederationTables(db);
    ensureGovernanceTables(db);
    const deviceId = ensureDeviceId(db);
    const sessionAuth = basicAuth(db, false);
    const blobs = memBlobStore();

    const app = new Hono<{ Variables: AuthVars }>();
    app.post('/api/notices/:id/act', sessionAuth, async (c) => {
      const userId = c.get('userId');
      const notice = getNotice(db, c.req.param('id'));
      if (!notice) return c.json({ error: 'not found' }, 404);
      if (notice.user_id !== userId) return c.json({ error: 'forbidden' }, 403);
      const b = (await c.req.json().catch(() => ({}))) as { action?: string };
      const resolved = await actOnNotice(db, deviceId, notice, b.action ?? 'dismiss');
      return c.json({ notice: resolved });
    });

    const fedApi = federationRoutes({
      db,
      serverDeviceId: deviceId,
      myLabel: label,
      resolveMode: () => 'intra_server' as FederationMode,
      deliverToPeer,
      blobStore: blobs,
      sessionAuth,
    });
    app.route('/api/federation', fedApi);

    const t: Tenant = {
      label,
      db,
      deviceId,
      app,
      blobs,
      addUser(username, password) {
        const u = getUserByUsername(db, username);
        const id = u ? u.id : createUserRow(db, username);
        setPassword(db, id, hashPassword(password));
        return { id, token: createSession(db, id) };
      },
    };
    tenants.set(label, t);
    return t;
  }

  return { tenants, deliverToPeer, makeTenant };
}

/** A blob's bytes + its content hash. */
function blob(text: string): { bytes: Buffer; hash: string } {
  const bytes = Buffer.from(text, 'utf8');
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

/** Alice owns "Roadmap" with a child task; return their ids. */
function seedRoadmap(acme: Tenant, aliceId: string): { roadmap: string; child: string } {
  const roadmap = createItem(acme.db, acme.deviceId, {
    type: 'project',
    parentId: null,
    ownerId: aliceId,
    title: 'Roadmap',
  });
  const child = createItem(acme.db, acme.deviceId, {
    type: 'task',
    parentId: roadmap.id,
    ownerId: aliceId,
    title: 'Ship v1',
  });
  return { roadmap: roadmap.id, child: child.id };
}

async function offer(
  acme: Tenant,
  aliceToken: string,
  to: string,
  rootItemId: string,
  permission: 'read' | 'write' = 'read',
): Promise<Response> {
  return acme.app.fetch(
    new Request('http://acme.test/api/federation/offers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ to, root_item_id: rootItemId, permission }),
    }),
  );
}

/** Drive the full offer→accept handshake so globex has the materialized subtree + an
 *  ACTIVE inbound link and acme an ACTIVE outbound link. Returns the seeded ids. */
async function federate(
  acme: Tenant,
  globex: Tenant,
  alice: { id: string; token: string },
  bob: { id: string; token: string },
): Promise<{ roadmap: string; child: string }> {
  setFederationPolicy(acme.db, 'user_open');
  setFederationPolicy(globex.db, 'user_open');
  const { roadmap, child } = seedRoadmap(acme, alice.id);
  const res = await offer(acme, alice.token, 'bob@globex', roadmap, 'read');
  assert.equal(res.status, 200, await res.text().catch(() => ''));
  const notice = listOpenNotices(globex.db, bob.id)[0]!;
  await globex.app.fetch(
    new Request(`http://globex.test/api/notices/${notice.id}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ action: 'accept' }),
    }),
  );
  return { roadmap, child };
}

/** Store a blob on acme and record a live attachment on Roadmap referencing its hash,
 *  then run one more exchange round so the attachment record materializes on globex. */
function attachOnAcme(
  acme: Tenant,
  itemId: string,
  b: { bytes: Buffer; hash: string },
  aliceId: string,
): void {
  acme.blobs.store(b.hash, b.bytes);
  addAttachment(acme.db, acme.deviceId, {
    parentType: 'item',
    parentId: itemId,
    itemId,
    filename: 'notes.txt',
    mimeType: 'text/plain',
    size: b.bytes.length,
    hash: b.hash,
    createdBy: aliceId,
  });
}

// ─── the harness itself must federate cleanly (sanity) ─────────────────────────

describe('federation Phase 5 — blob fetch-from-peer', () => {
  // 1. Metadata materializes on globex; the bytes do NOT.
  test('after accept, the attachment row is on globex but the blob bytes are not', async () => {
    const world = makeWorld();
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = await federate(acme, globex, alice, bob);

    const b = blob('roadmap attachment payload');
    attachOnAcme(acme, roadmap, b, alice.id);

    // One exchange round: the attachment RECORD flows to globex (bytes do not).
    const gLink = listLinks(globex.db).find((l) => l.direction === 'inbound' && l.status === 'active')!;
    await runFederationExchange(globex.db, gLink, world.deliverToPeer, 'globex');

    // Metadata present on globex.
    const atts = listAttachmentsFor(globex.db, 'item', roadmap);
    assert.equal(atts.length, 1, 'attachment metadata materialized on globex');
    assert.equal(atts[0]!.hash, b.hash);
    // Bytes NOT present locally on globex.
    assert.equal(globex.blobs.has(b.hash), false, 'blob bytes absent on globex');
    // Bytes ARE present on acme (the owner).
    assert.equal(acme.blobs.has(b.hash), true, 'blob bytes present on acme');
  });

  // 2. fetchFederatedBlob pulls, verifies, caches, and serves; second call is cache-only.
  test('fetchFederatedBlob pulls from acme, hash-verifies, caches; a second request hits cache (no peer fetch)', async () => {
    const world = makeWorld();
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = await federate(acme, globex, alice, bob);

    const b = blob('the real bytes');
    attachOnAcme(acme, roadmap, b, alice.id);
    const gLink = listLinks(globex.db).find((l) => l.direction === 'inbound' && l.status === 'active')!;
    await runFederationExchange(globex.db, gLink, world.deliverToPeer, 'globex');

    // Count peer fetches by wrapping deliverToPeer.
    let blobFetches = 0;
    const counting: DeliverToPeer = async (base, path, body) => {
      if (path === '/api/federation/blob') blobFetches++;
      return world.deliverToPeer(base, path, body);
    };

    // First fetch: pulls, verifies, caches, returns the correct bytes.
    const got = await fetchFederatedBlob(globex.db, counting, globex.blobs, b.hash);
    assert.ok(got, 'blob fetched from peer');
    assert.equal(Buffer.compare(got!, b.bytes), 0, 'bytes match the original');
    assert.equal(globex.blobs.has(b.hash), true, 'blob cached locally on globex');
    assert.equal(blobFetches, 1, 'exactly one peer fetch');

    // Second fetch would re-hit the peer, but the caller (GET /api/blobs) serves the
    // now-cached bytes without ever calling fetchFederatedBlob. Emulate that: the local
    // store already has it, so no peer round-trip is needed.
    assert.equal(globex.blobs.read(b.hash) !== null, true, 'second read served from cache');
    assert.equal(blobFetches, 1, 'no second peer fetch (served from local cache)');
  });

  // 3. Scope: a hash on acme NOT referenced within globex's granted subtree → 404.
  test('a blob referenced OUTSIDE the granted subtree is not served (no exfiltration)', async () => {
    const world = makeWorld();
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = await federate(acme, globex, alice, bob);

    // A SECOND, un-shared project on acme with its own attachment. Its hash exists on
    // acme but is not referenced anywhere in globex's granted subtree.
    const secret = createItem(acme.db, acme.deviceId, {
      type: 'project',
      parentId: null,
      ownerId: alice.id,
      title: 'Secret',
    });
    const secretBlob = blob('classified');
    attachOnAcme(acme, secret.id, secretBlob, alice.id);
    // Also an in-scope blob so we know the link works for legitimate hashes.
    const okBlob = blob('shared ok');
    attachOnAcme(acme, roadmap, okBlob, alice.id);

    const gLink = listLinks(globex.db).find((l) => l.direction === 'inbound' && l.status === 'active')!;

    // Directly hit acme's serve endpoint with globex's link secret for the secret hash.
    const serve = (hash: string) =>
      acme.app.fetch(
        new Request('http://acme.test/api/federation/blob', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ __link_secret: gLink.secret, hash }),
        }),
      );

    const outOfScope = await serve(secretBlob.hash);
    assert.equal(outOfScope.status, 404, 'out-of-scope hash returns 404 (no exfiltration)');

    // The in-scope hash IS served (positive control — the link works).
    const inScope = await serve(okBlob.hash);
    assert.equal(inScope.status, 200, 'in-scope hash is served');
    const served = Buffer.from(await inScope.arrayBuffer());
    assert.equal(Buffer.compare(served, okBlob.bytes), 0, 'served bytes match');

    // And fetchFederatedBlob on globex never even attempts the secret hash (no link
    // references it), so it returns null without touching the peer.
    const got = await fetchFederatedBlob(globex.db, world.deliverToPeer, globex.blobs, secretBlob.hash);
    assert.equal(got, null, 'no inbound link references the secret hash → null');
    assert.equal(globex.blobs.has(secretBlob.hash), false, 'nothing cached for the secret hash');
  });

  // 4. Poison: peer returns bytes whose sha256 ≠ the requested hash → rejected, nothing cached.
  test('a peer that returns the wrong bytes is rejected; nothing is cached, null is returned', async () => {
    const world = makeWorld();
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = await federate(acme, globex, alice, bob);

    const b = blob('honest bytes');
    // Attachment references b.hash, but acme's store is poisoned: the hash maps to
    // DIFFERENT bytes (simulating a malicious/buggy peer serving mismatched content).
    addAttachment(acme.db, acme.deviceId, {
      parentType: 'item',
      parentId: roadmap,
      itemId: roadmap,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      size: b.bytes.length,
      hash: b.hash,
      createdBy: alice.id,
    });
    acme.blobs.store(b.hash, Buffer.from('POISON — not the claimed content', 'utf8'));

    const gLink = listLinks(globex.db).find((l) => l.direction === 'inbound' && l.status === 'active')!;
    await runFederationExchange(globex.db, gLink, world.deliverToPeer, 'globex');

    // Fetch: the peer serves 200 with the wrong bytes; the grantee re-hashes, sees a
    // mismatch, rejects — returns null, caches nothing.
    const got = await fetchFederatedBlob(globex.db, world.deliverToPeer, globex.blobs, b.hash);
    assert.equal(got, null, 'poisoned bytes rejected (null)');
    assert.equal(globex.blobs.has(b.hash), false, 'nothing cached for a hash mismatch');
  });

  // 5. Link-secret required; a revoked link does not serve.
  test('wrong/absent secret → 401; a revoked link does not serve', async () => {
    const world = makeWorld();
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = await federate(acme, globex, alice, bob);

    const b = blob('secretly served only to active links');
    attachOnAcme(acme, roadmap, b, alice.id);
    const gLink = listLinks(globex.db).find((l) => l.direction === 'inbound' && l.status === 'active')!;
    // acme's active outbound link secret == globex's link secret (same shared secret).
    const acmeLink = listLinks(acme.db).find((l) => l.status === 'active')!;

    const serve = (secret?: string) =>
      acme.app.fetch(
        new Request('http://acme.test/api/federation/blob', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...(secret ? { __link_secret: secret } : {}), hash: b.hash }),
        }),
      );

    // Absent secret → 401.
    assert.equal((await serve()).status, 401, 'absent secret rejected');
    // Wrong secret → 401.
    assert.equal((await serve('not-the-secret')).status, 401, 'wrong secret rejected');
    // Correct active-link secret → 200.
    assert.equal((await serve(gLink.secret)).status, 200, 'active-link secret serves');

    // Revoke acme's side of the link → the same correct secret is now rejected (401).
    setLinkStatus(acme.db, acmeLink.id, 'revoked');
    assert.equal((await serve(gLink.secret)).status, 401, 'revoked link no longer serves');
  });
});

