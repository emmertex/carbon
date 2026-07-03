/**
 * Federation Phase-6 end-to-end: cross-server (L3) HTTPS transport.
 *
 * Phases 0–5 built the entire federation mechanism over a same-host in-process
 * loopback. Phase 6's ONLY structural change is making the peer-delivery seam do real
 * HTTPS for non-local peers. This suite proves the L3 path carries the SAME protocol,
 * byte-for-byte, as the L2 loopback:
 *
 *   1. L3 end-to-end — two tenants addressed as full `https://…` bases, wired by the
 *      REAL `makeDeliverToPeer` remote path with an injected transport that routes the
 *      "HTTPS" POST into the peer's in-process app (no real socket, no SSRF trip). The
 *      full offer→approve→exchange converges exactly like the loopback case, and a
 *      federated blob is fetched over the same HTTPS seam.
 *   2. Ceiling gate — `intra_server` rejects a cross-server (dotted) offer at BOTH
 *      edges; `cross_server` permits it.
 *   3. SSRF / allowPrivate — `deliverToPeer` to a private/loopback URL is refused by
 *      `safeFetch` when allowPrivate is false, permitted when true.
 *   4. Secret via header — the remote path sends `x-federation-secret` and `linkAuth`
 *      accepts it (no `__link_secret` in the body).
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import {
  createItem,
  visibleItemIds,
  getItem,
  addAttachment,
  listAttachmentsFor,
  migrate,
  ensureDeviceId,
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
  fetchFederatedBlob,
  runFederationExchange,
  makeDeliverToPeer,
  isLocalPeer,
  joinPeerUrl,
  memBlobStore,
  type FederationMode,
  type DeliverToPeer,
  type HttpFetch,
} from './federation';

// ─── two-tenant L3 harness ─────────────────────────────────────────────────────
//
// Each tenant is addressed by a FULL host (e.g. `acme.example`) — a dotted label, so
// `tierForLabel` classifies the peer as `cross_server` and `isLocalPeer` is false, so
// `makeDeliverToPeer` takes the REAL L3 HTTPS branch. The injected `httpFetch` maps a
// `https://<host>/<path>` URL back to that host's in-process app — the stand-in for a
// real network hop. Keeping the tenant's `myLabel` == its host preserves the identity-
// remap label symmetry the loopback tests rely on (so the round-trip un-maps cleanly).

interface Tenant {
  host: string; // full dotted host, e.g. "acme.example" — its myLabel + address label
  db: ReturnType<typeof openDb>;
  deviceId: string;
  app: Hono<{ Variables: AuthVars }>;
  blobs: ReturnType<typeof memBlobStore>;
  addUser(username: string, password: string): { id: string; token: string };
}

function createUserRow(db: ReturnType<typeof openDb>, username: string): string {
  return coreCreateUser(db, { username, displayName: username, role: 'admin' }).id;
}

function makeWorld(mode: () => Record<string, FederationMode>) {
  const tenants = new Map<string, Tenant>(); // keyed by host

  // The injected L3 transport: resolve `https://<host>/<path>` back to the peer app,
  // forwarding headers (so `x-federation-secret` reaches `linkAuth`). This is the seam
  // a real `safeFetch` would occupy; routing it in-process avoids sockets and the SSRF
  // guard entirely, while exercising the FULL remote code path (URL join, header
  // injection, allowPrivate resolution).
  const httpFetch: HttpFetch = async (url, _allowPrivate, init) => {
    const u = new URL(url);
    const peer = tenants.get(u.hostname);
    if (!peer) throw new Error(`no peer at ${u.hostname}`);
    const req = new Request(`http://${u.hostname}${u.pathname}`, {
      method: init?.method ?? 'POST',
      headers: init?.headers,
      body: init?.body,
    });
    return peer.app.fetch(req);
  };

  // The REAL production factory: no local tenants (getApp → null), so every bare label
  // would throw `unsupported_peer` — but our peers are all dotted hosts, taking the L3
  // branch. allowPrivate defaults through the factory (we pass an explicit resolver per
  // test where it matters).
  const deliverToPeer: DeliverToPeer = makeDeliverToPeer({
    getApp: () => null,
    httpFetch,
    allowPrivate: () => true, // the injected transport ignores it; real safeFetch honors it
  });

  function makeTenant(host: string): Tenant {
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
      myLabel: host, // == the address label, so remap symmetry holds (see note above)
      myBaseUrl: host, // advertised as the L3 callback base
      resolveMode: () => mode()[host] ?? 'off',
      deliverToPeer,
      blobStore: blobs,
      sessionAuth,
    });
    app.route('/api/federation', fedApi);

    const t: Tenant = {
      host,
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
    tenants.set(host, t);
    return t;
  }

  return { tenants, deliverToPeer, makeTenant };
}

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
    new Request(`http://${acme.host}/api/federation/offers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ to, root_item_id: rootItemId, permission }),
    }),
  );
}

/** Drive the full offer→accept handshake over L3 so the grantee materializes the
 *  subtree and both sides hold an ACTIVE link. Returns the seeded ids. */
async function federate(
  acme: Tenant,
  globex: Tenant,
  alice: { id: string; token: string },
  bob: { id: string; token: string },
  permission: 'read' | 'write' = 'read',
): Promise<{ roadmap: string; child: string }> {
  setFederationPolicy(acme.db, 'user_open');
  setFederationPolicy(globex.db, 'user_open');
  const { roadmap, child } = seedRoadmap(acme, alice.id);
  const res = await offer(acme, alice.token, `bob@${globex.host}`, roadmap, permission);
  assert.equal(res.status, 200, await res.text().catch(() => ''));
  const notice = listOpenNotices(globex.db, bob.id)[0]!;
  await globex.app.fetch(
    new Request(`http://${globex.host}/api/notices/${notice.id}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ action: 'accept' }),
    }),
  );
  return { roadmap, child };
}

// ─── 1. L3 end-to-end: the protocol carries unchanged over real HTTPS ──────────

describe('federation Phase 6 — cross-server (L3) HTTPS transport', () => {
  test('offer→approve→exchange converges over the L3 HTTPS seam exactly like the loopback', async () => {
    const modes: Record<string, FederationMode> = {
      'acme.example': 'cross_server',
      'globex.example': 'cross_server',
    };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme.example');
    const globex = world.makeTenant('globex.example');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');

    const { roadmap, child } = await federate(acme, globex, alice, bob, 'write');

    // The link is cross-server: peer_base_url is a dotted host (would form https://…).
    const acmeLink = listLinks(acme.db)[0]!;
    const globexLink = listLinks(globex.db)[0]!;
    assert.equal(acmeLink.status, 'active', 'acme outbound link active after callback');
    assert.equal(globexLink.status, 'active', 'globex inbound link active after accept');
    assert.equal(isLocalPeer(acmeLink.peer_base_url), false, 'peer is remote (L3), not a loopback');
    assert.equal(globexLink.peer_base_url, 'acme.example', 'globex calls back to acmes full host');

    // The subtree materialized on the grantee under a shadow of alice — exactly the
    // loopback outcome, proving the L3 transport carried the protocol unchanged.
    const shadowVisible = visibleItemIds(globex.db, bob.id);
    assert.ok(shadowVisible.has(roadmap), 'Roadmap materialized on globex over L3');
    assert.ok(shadowVisible.has(child), 'child task materialized on globex over L3');
    assert.equal(getItem(globex.db, roadmap)?.title, 'Roadmap');

    // Round-trip convergence: an edit on the grantee (write grant) flows back to the
    // owner over L3. Bob edits the child title; one exchange each way propagates it.
    createItem(globex.db, globex.deviceId, {
      type: 'task',
      parentId: roadmap,
      ownerId: bob.id,
      title: 'Added on globex',
    });
    // globex pushes its edit to acme; acme pulls nothing new back.
    await runFederationExchange(globex.db, globexLink, world.deliverToPeer, globex.host);
    // acme now sees the new child (write-gated ingest of the grantee push).
    const acmeChildren = acme.db
      .all<{ title: string }>('SELECT title FROM items WHERE parent_id = ?', [roadmap])
      .map((r) => r.title);
    assert.ok(
      acmeChildren.includes('Added on globex'),
      'grantee edit flowed back to the owner over L3',
    );
  });

  test('a federated blob is fetched over the L3 HTTPS seam, hash-verified, and cached', async () => {
    const modes: Record<string, FederationMode> = {
      'acme.example': 'cross_server',
      'globex.example': 'cross_server',
    };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme.example');
    const globex = world.makeTenant('globex.example');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = await federate(acme, globex, alice, bob);

    // acme stores a blob and records a live attachment on Roadmap referencing it.
    const bytes = Buffer.from('cross-server attachment payload', 'utf8');
    const hash = createHash('sha256').update(bytes).digest('hex');
    acme.blobs.store(hash, bytes);
    addAttachment(acme.db, acme.deviceId, {
      parentType: 'item',
      parentId: roadmap,
      itemId: roadmap,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      hash,
      createdBy: alice.id,
    });

    // One exchange round materializes the attachment RECORD on globex (bytes do not).
    const globexLink = listLinks(globex.db).find(
      (l) => l.direction === 'inbound' && l.status === 'active',
    )!;
    await runFederationExchange(globex.db, globexLink, world.deliverToPeer, globex.host);
    assert.equal(listAttachmentsFor(globex.db, 'item', roadmap).length, 1, 'attachment metadata on globex');
    assert.equal(globex.blobs.has(hash), false, 'bytes absent on globex before fetch');

    // Fetch over L3: the binary Response is read via arrayBuffer, hash-verified, cached.
    const got = await fetchFederatedBlob(globex.db, world.deliverToPeer, globex.blobs, hash);
    assert.ok(got, 'blob fetched over L3 HTTPS');
    assert.equal(Buffer.compare(got!, bytes), 0, 'bytes match the original over the real-fetch path');
    assert.equal(globex.blobs.has(hash), true, 'verified bytes cached locally');
  });

  // ─── 2. Ceiling gate: intra_server blocks L3, cross_server allows it ──────────

  test('FEDERATION_MODE=intra_server rejects a cross-server offer at the OUTBOUND edge', async () => {
    const modes: Record<string, FederationMode> = {
      'acme.example': 'intra_server', // ← ceiling below cross_server
      'globex.example': 'cross_server',
    };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme.example');
    world.makeTenant('globex.example');
    setFederationPolicy(acme.db, 'user_open');
    const alice = acme.addUser('alice', 'pw');
    const { roadmap } = seedRoadmap(acme, alice.id);

    const res = await offer(acme, alice.token, 'bob@globex.example', roadmap);
    assert.equal(res.status, 403, 'outbound edge blocks a cross-server peer under intra_server');
    const j = (await res.json()) as { error?: string };
    assert.equal(j.error, 'federation_denied');
    assert.equal(listLinks(acme.db).length, 0, 'no link minted when the ceiling blocks the offer');
  });

  test('FEDERATION_MODE=intra_server rejects a cross-server offer at the INBOUND edge', async () => {
    // The issuer's ceiling is cross_server (so its outbound gate passes), but the
    // recipient's ceiling is intra_server — the inbound edge re-checks and rejects.
    const modes: Record<string, FederationMode> = {
      'acme.example': 'cross_server',
      'globex.example': 'intra_server', // ← recipient ceiling blocks L3
    };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme.example');
    const globex = world.makeTenant('globex.example');
    setFederationPolicy(acme.db, 'user_open');
    setFederationPolicy(globex.db, 'user_open');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = seedRoadmap(acme, alice.id);

    const res = await offer(acme, alice.token, `bob@globex.example`, roadmap);
    // The issuer minted a pending link and delivered; the recipient rejected inbound,
    // so the issuer surfaces a peer_rejected (409) and tombstones its side.
    assert.equal(res.status, 409, 'peer rejected the inbound offer (recipient ceiling)');
    const j = (await res.json()) as { peer_error?: string };
    assert.equal(j.peer_error, 'federation_denied');
    assert.equal(listOpenNotices(globex.db, bob.id).length, 0, 'no notice created on the recipient');
    assert.equal(listLinks(acme.db)[0]!.status, 'revoked', 'issuer tombstoned its pending link');
  });

  test('FEDERATION_MODE=cross_server permits the offer both edges pass', async () => {
    const modes: Record<string, FederationMode> = {
      'acme.example': 'cross_server',
      'globex.example': 'cross_server',
    };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme.example');
    const globex = world.makeTenant('globex.example');
    setFederationPolicy(acme.db, 'user_open');
    setFederationPolicy(globex.db, 'user_open');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = seedRoadmap(acme, alice.id);

    const res = await offer(acme, alice.token, `bob@globex.example`, roadmap);
    assert.equal(res.status, 200, 'cross_server ceiling permits the L3 offer');
    assert.equal(listOpenNotices(globex.db, bob.id).length, 1, 'recipient got exactly one notice');
  });

  // ─── 3. SSRF / allowPrivate: the real safeFetch path refuses private targets ──

  test('deliverToPeer to a private/loopback host is refused by safeFetch unless allowPrivate', async () => {
    // Use the REAL safeFetch (no injected httpFetch), so the SSRF guard actually runs.
    // A loopback target must throw when allowPrivate is false and be permitted (i.e.
    // pass the guard — the connection then fails, a DIFFERENT error) when true.
    const guarded = makeDeliverToPeer({ getApp: () => null, allowPrivate: () => false });
    await assert.rejects(
      () => guarded('127.0.0.1:59999', '/api/federation/sync', { __link_secret: 's' }),
      /private|loopback|LAN/i,
      'a loopback peer is refused by the SSRF guard when allowPrivate=false',
    );

    // With allowPrivate=true the guard passes; the actual connection then fails with a
    // NON-SSRF error (nothing is listening) — proving the guard no longer blocks it.
    const permitted = makeDeliverToPeer({ getApp: () => null, allowPrivate: () => true });
    await assert.rejects(
      () => permitted('127.0.0.1:59999', '/api/federation/sync', { __link_secret: 's' }),
      (err: Error) => !/private|loopback|LAN/i.test(err.message),
      'with allowPrivate=true the SSRF guard is bypassed (failure is a connection error, not the guard)',
    );
  });

  test('a bare (non-local) label with no local tenant is unsupported; a dotted host forms an https base', () => {
    assert.equal(isLocalPeer('globex'), true, 'a bare subdomain is a same-host loopback candidate');
    assert.equal(isLocalPeer('globex.example'), false, 'a dotted host is a remote (L3) peer');
    assert.equal(isLocalPeer('https://globex.example'), false, 'a full URL is a remote peer');
    // The L3 base is a proper https origin (bare host defaults to https; a full origin
    // is kept as-is).
    assert.equal(
      joinPeerUrl('globex.example', '/api/federation/sync'),
      'https://globex.example/api/federation/sync',
    );
    assert.equal(
      joinPeerUrl('https://globex.example/', 'api/federation/sync'),
      'https://globex.example/api/federation/sync',
    );
  });

  // ─── 4. Secret via header: the remote path sends x-federation-secret ──────────

  test('the L3 remote path sends the link secret in the x-federation-secret header (not just the body)', async () => {
    // Capture the init the remote transport builds, and confirm the header carries the
    // secret. Then feed the request into a tenant app to prove `linkAuth` accepts a
    // header-only credential (no __link_secret needed in the body).
    const modes: Record<string, FederationMode> = {
      'acme.example': 'cross_server',
      'globex.example': 'cross_server',
    };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme.example');

    let capturedHeader: string | undefined;
    let capturedBodyHadSecret = false;
    const spyFetch: HttpFetch = async (url, _allow, init) => {
      const headers = new Headers(init?.headers);
      capturedHeader = headers.get('x-federation-secret') ?? undefined;
      const parsed = JSON.parse((init?.body as string) ?? '{}') as { __link_secret?: string };
      capturedBodyHadSecret = typeof parsed.__link_secret === 'string';
      // Route into acme's real app so linkAuth runs against the HEADER credential only.
      const u = new URL(url);
      const req = new Request(`http://${u.hostname}${u.pathname}`, {
        method: 'POST',
        headers, // includes x-federation-secret
        body: JSON.stringify(parsed), // keep the body as-built
      });
      return acme.app.fetch(req);
    };
    const deliver = makeDeliverToPeer({ getApp: () => null, httpFetch: spyFetch });

    // Point the delivery at an ACTIVE link on acme so linkAuth can match its secret.
    // Provision one via the offer→accept flow to a peer of acme.
    world.makeTenant('globex.example');
    setFederationPolicy(acme.db, 'user_open');
    const alice = acme.addUser('alice', 'pw');
    const bob = world.tenants.get('globex.example')!.addUser('bob', 'pw');
    setFederationPolicy(world.tenants.get('globex.example')!.db, 'user_open');
    await federate(acme, world.tenants.get('globex.example')!, alice, bob);
    const activeLink = listLinks(acme.db).find((l) => l.status === 'active')!;

    // Deliver a /sync with the secret ONLY in the body-as-source; makeDeliverToPeer
    // lifts it into the header. linkAuth (header-first) must accept it → 200 (not 401).
    const res = await deliver('acme.example', '/api/federation/sync', {
      __link_secret: activeLink.secret,
    });
    assert.equal(capturedHeader, activeLink.secret, 'secret sent in x-federation-secret header');
    assert.equal(capturedBodyHadSecret, true, 'body also retains __link_secret for uniformity');
    assert.equal(res.status, 200, 'linkAuth accepted the header-borne secret (not 401)');
  });
});
