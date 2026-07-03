/**
 * Federation Phase-2 end-to-end: the offer→approve handshake over same-host
 * loopback, plus read-only pull of the shared subtree with identity remap. Two
 * in-process tenant DBs (acme, globex) wired together by a `deliverToPeer` that
 * loops between their apps — the SAME inbound route L3 will later hit over HTTPS.
 *
 * Scope proven here: single granted root, read-only, L2 same-host, all three
 * governance gates, tag-drop, ts-non-clamp, and link-secret auth on /sync.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Hono } from 'hono';
import {
  createItem,
  visibleItemIds,
  getItem,
  getUser,
  ingestOps,
  recordRecordOp,
  getUserByUsername,
  type Op,
} from '@carbon/core';
import { openDb } from './sqlite';
import { migrate, ensureDeviceId } from '@carbon/core';
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
  addPeer,
  listLinks,
  setLinkStatus,
  memBlobStore,
  type FederationMode,
  type FederationPolicy,
  type DeliverToPeer,
} from './federation';

// ─── a minimal, self-contained two-tenant harness ──────────────────────────────

interface Tenant {
  label: string;
  db: ReturnType<typeof openDb>;
  deviceId: string;
  app: Hono<{ Variables: AuthVars }>;
  mode: FederationMode;
  addUser(username: string, password: string): { id: string; token: string };
}

/** Registry that both tenants share: label → the other tenant's Hono app. */
function makeWorld(mode: () => Record<string, FederationMode>) {
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

    const sessionAuth = basicAuth(db, false); // users always present in these tests

    const app = new Hono<{ Variables: AuthVars }>();
    // Notices act route (session-authed to the addressed user) — Gate 3.
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
      resolveMode: () => mode()[label] ?? 'off',
      deliverToPeer,
      blobStore: memBlobStore(),
      sessionAuth,
    });
    app.route('/api/federation', fedApi);

    const t: Tenant = {
      label,
      db,
      deviceId,
      app,
      mode: 'intra_server',
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

// createUser via core (avoids importing under the shadowed name); returns id.
import { createUser as coreCreateUser } from '@carbon/core';
function createUserRow(db: ReturnType<typeof openDb>, username: string): string {
  return coreCreateUser(db, { username, displayName: username, role: 'admin' }).id;
}

/** Alice on acme owns project "Roadmap" with a child task; returns their ids. */
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

// ─── the end-to-end happy path (assertions 1–4, 6) ──────────────────────────────

describe('federation Phase 2 — offer→approve, pull, remap (L2 loopback)', () => {
  test('offer creates pending links both sides; bob gets exactly one notice; accept materializes Roadmap under shadow alice; tags dropped; far-future ts unclamped', async () => {
    const modes: Record<string, FederationMode> = { acme: 'intra_server', globex: 'intra_server' };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    setFederationPolicy(acme.db, 'user_open');
    setFederationPolicy(globex.db, 'user_open');

    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap, child } = seedRoadmap(acme, alice.id);

    // A tag on Roadmap on acme (must NOT create a tag on globex — assertion 4).
    const nowIso = new Date().toISOString();
    recordRecordOp(acme.db, acme.deviceId, 'tag', 't1', {
      id: 't1',
      name: 'urgent',
      color: null,
      status: 'active',
      sort_order: 0,
      geo: null,
      created_at: nowIso,
      updated_at: nowIso,
      deleted: false,
    });
    recordRecordOp(acme.db, acme.deviceId, 'item_tag', `${roadmap}:t1`, {
      item_id: roadmap,
      tag_id: 't1',
      updated_at: nowIso,
      deleted: false,
    });

    // A far-future causal ts on an acme op (assertion 6): a title edit dated year 3000.
    const farTs = Date.parse('3000-01-01T00:00:00Z');
    const farOp: Op = {
      id: 'far-op-1',
      item_id: roadmap,
      ts: farTs,
      device_id: 'acme-dev',
      fields: { title: 'Roadmap (future)' },
    };
    ingestOps(acme.db, [farOp], true);

    // 1. Offer succeeds; pending link on both sides.
    const res = await offer(acme, alice.token, 'bob@globex', roadmap, 'read');
    assert.equal(res.status, 200, await res.text().catch(() => ''));
    assert.equal(listLinks(acme.db).length, 1, 'acme has a pending outbound link');
    assert.equal(listLinks(acme.db)[0]!.status, 'pending');
    assert.equal(listLinks(globex.db).length, 1, 'globex has a pending inbound link');
    assert.equal(listLinks(globex.db)[0]!.status, 'pending');

    // 2. globex has exactly one federation_offer notice for bob.
    const open = listOpenNotices(globex.db, bob.id);
    assert.equal(open.length, 1, 'exactly one open notice');
    assert.equal(open[0]!.kind, 'federation_offer');
    const noticeItem = getItem(globex.db, open[0]!.item_id)!;
    assert.equal(noticeItem.sys_kind, 'federation_offer');
    assert.equal(noticeItem.parent_id, null, 'lands in Inbox');
    assert.ok(noticeItem.title.includes('Roadmap'), 'title names the shared root');
    assert.ok(
      noticeItem.title.toLowerCase().includes('alice') || noticeItem.title.includes('acme'),
      'title names the sharer',
    );

    // 3. bob accepts (his session) → link active + Roadmap materialized + visible.
    const act = await globex.app.fetch(
      new Request(`http://globex.test/api/notices/${open[0]!.id}/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    const actBody = (await act.json()) as { notice: { state: string } };
    assert.equal(act.status, 200, JSON.stringify(actBody));
    assert.equal(actBody.notice.state, 'accepted');

    // recipient-side link active
    assert.equal(listLinks(globex.db)[0]!.status, 'active');
    // issuer-side link activated by the confirm callback
    assert.equal(listLinks(acme.db)[0]!.status, 'active');

    // Roadmap + child materialized on globex, owned by a shadow of acme's alice.
    // The shadow id namespaces alice's LOCAL acme id: `remote:acme:<alice.id>`.
    const shadowId = `remote:acme:${alice.id}`;
    const gRoadmap = getItem(globex.db, roadmap);
    const gChild = getItem(globex.db, child);
    assert.ok(gRoadmap, 'Roadmap materialized on globex');
    assert.ok(gChild, 'child task materialized on globex');
    assert.equal(gRoadmap!.owner_id, shadowId, 'owned by shadow alice');
    assert.equal(gChild!.owner_id, shadowId);
    // Shadow user provisioned + named.
    const shadow = getUser(globex.db, shadowId);
    assert.ok(shadow, 'shadow user exists');
    assert.equal(shadow!.is_remote, true);

    // Visible to bob (the remapped share alice→remote:globex:bob becomes shadow→bob).
    const visible = visibleItemIds(globex.db, bob.id);
    assert.ok(visible.has(roadmap), 'Roadmap visible to bob');
    assert.ok(visible.has(child), 'child visible to bob');

    // 4. No tag/item_tag on globex.
    const tagCount = globex.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM record_ops WHERE entity IN ('tag','item_tag')",
    );
    assert.equal(tagCount!.n, 0, 'tags dropped on federated ingest');

    // 6. The far-future ts survived unclamped (title won LWW at year-3000 ts).
    assert.equal(gRoadmap!.title, 'Roadmap (future)', 'far-future op won LWW, unclamped');
    const farRow = globex.db.get<{ ts: number }>('SELECT ts FROM ops WHERE id = ?', ['far-op-1']);
    assert.ok(farRow, 'far op ingested on globex');
    assert.equal(Number(farRow!.ts), farTs, 'ts not clamped to now+5min');
  });
});

// ─── how the share becomes the grant (assertion 3 detail) ──────────────────────

describe('federation Phase 2 — the remapped share is the grant', () => {
  test('an acme share alice→remote:globex:bob lands on globex as shadow-alice→bob', async () => {
    const modes: Record<string, FederationMode> = { acme: 'intra_server', globex: 'intra_server' };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    setFederationPolicy(acme.db, 'user_open');
    setFederationPolicy(globex.db, 'user_open');

    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = seedRoadmap(acme, alice.id);

    // acme shares Roadmap with globex's bob as a shadow — the grant that federation
    // carries. The shadow id namespaces bob's LOCAL globex id: `remote:globex:<bob.id>`
    // (exactly how acme would have shadowed bob when globex first federated). On pull
    // back into globex, remapUserRef un-maps `remote:globex:<id>` → `<id>` = local bob.
    const shareUser = `remote:globex:${bob.id}`;
    const shareRow = {
      id: `s:${roadmap}:${shareUser}`,
      item_id: roadmap,
      user_id: shareUser,
      permission: 'read' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted: false,
    };
    recordRecordOp(acme.db, acme.deviceId, 'share', shareRow.id, shareRow);

    const res = await offer(acme, alice.token, 'bob@globex', roadmap, 'read');
    assert.equal(res.status, 200);
    const notice = listOpenNotices(globex.db, bob.id)[0]!;
    await globex.app.fetch(
      new Request(`http://globex.test/api/notices/${notice.id}/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
        body: JSON.stringify({ action: 'accept' }),
      }),
    );

    // The remapped share on globex: remote:globex:bob → bob (un-mapped local),
    // and the join id is regenerated after remap.
    const shares = globex.db.all<{ user_id: string; id: string }>(
      'SELECT id, user_id FROM shares WHERE item_id = ? AND deleted = 0',
      [roadmap],
    );
    assert.ok(
      shares.some((s) => s.user_id === bob.id && s.id === `s:${roadmap}:${bob.id}`),
      'share remapped to local bob with regenerated join id',
    );
    assert.ok(visibleItemIds(globex.db, bob.id).has(roadmap), 'grant makes Roadmap visible to bob');
  });
});

// ─── governance gates at both edges (assertion 5) ──────────────────────────────

describe('federation Phase 2 — governance gates', () => {
  async function runOffer(opts: {
    acmeMode: FederationMode;
    globexMode: FederationMode;
    acmePolicy: FederationPolicy;
    globexPolicy: FederationPolicy;
    whitelistAcmeOnGlobex?: boolean;
    /** acme (the sender) puts globex on its deny list → outbound edge blocks. */
    denyGlobexOnAcme?: boolean;
    /** globex (the recipient) puts acme on its deny list → inbound edge blocks. */
    denyAcmeOnGlobex?: boolean;
  }) {
    const modes: Record<string, FederationMode> = {
      acme: opts.acmeMode,
      globex: opts.globexMode,
    };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    setFederationPolicy(acme.db, opts.acmePolicy);
    setFederationPolicy(globex.db, opts.globexPolicy);
    if (opts.whitelistAcmeOnGlobex) {
      addPeer(globex.db, { baseUrl: 'acme', subdomain: 'acme', label: 'acme' });
    }
    if (opts.denyGlobexOnAcme) {
      addPeer(acme.db, { baseUrl: 'globex', subdomain: 'globex', label: 'globex', listType: 'deny' });
    }
    if (opts.denyAcmeOnGlobex) {
      addPeer(globex.db, { baseUrl: 'acme', subdomain: 'acme', label: 'acme', listType: 'deny' });
    }
    const alice = acme.addUser('alice', 'pw');
    globex.addUser('bob', 'pw');
    const { roadmap } = seedRoadmap(acme, alice.id);
    const res = await offer(acme, alice.token, 'bob@globex', roadmap, 'read');
    const noticeCount = globex.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM system_notices',
    )!.n;
    return { res, noticeCount };
  }

  test('globex policy workspace_only → inbound offer rejected, no notice', async () => {
    const { res, noticeCount } = await runOffer({
      acmeMode: 'intra_server',
      globexMode: 'intra_server',
      acmePolicy: 'user_open',
      globexPolicy: 'workspace_only',
    });
    assert.notEqual(res.status, 200, 'offer rejected at inbound edge');
    assert.equal(noticeCount, 0, 'no notice created');
  });

  test('globex admin_whitelist, acme NOT whitelisted → rejected', async () => {
    const { res, noticeCount } = await runOffer({
      acmeMode: 'intra_server',
      globexMode: 'intra_server',
      acmePolicy: 'user_open',
      globexPolicy: 'admin_whitelist',
      whitelistAcmeOnGlobex: false,
    });
    assert.notEqual(res.status, 200);
    assert.equal(noticeCount, 0);
  });

  test('globex admin_whitelist, acme whitelisted → accepted (notice created)', async () => {
    const { res, noticeCount } = await runOffer({
      acmeMode: 'intra_server',
      globexMode: 'intra_server',
      acmePolicy: 'user_open',
      globexPolicy: 'admin_whitelist',
      whitelistAcmeOnGlobex: true,
    });
    assert.equal(res.status, 200, await res.text().catch(() => ''));
    assert.equal(noticeCount, 1);
  });

  test('host ceiling off → offer rejected at the outbound edge', async () => {
    const { res, noticeCount } = await runOffer({
      acmeMode: 'off',
      globexMode: 'intra_server',
      acmePolicy: 'user_open',
      globexPolicy: 'user_open',
    });
    assert.equal(res.status, 403, 'outbound edge blocks when acme ceiling is off');
    assert.equal(noticeCount, 0);
  });

  test('host ceiling off on the recipient → rejected at the inbound edge', async () => {
    const { res, noticeCount } = await runOffer({
      acmeMode: 'intra_server',
      globexMode: 'off',
      acmePolicy: 'user_open',
      globexPolicy: 'user_open',
    });
    assert.notEqual(res.status, 200, 'inbound edge blocks when globex ceiling is off');
    assert.equal(noticeCount, 0);
  });

  test('sender deny list → outbound offer rejected (reason mentions deny), no notice', async () => {
    // Open policy on both sides; the ONLY blocker is acme's deny of globex.
    const { res, noticeCount } = await runOffer({
      acmeMode: 'intra_server',
      globexMode: 'intra_server',
      acmePolicy: 'user_open',
      globexPolicy: 'user_open',
      denyGlobexOnAcme: true,
    });
    assert.equal(res.status, 403, 'outbound edge blocks a denied peer even under Open');
    const body = (await res.json()) as { error?: string; reason?: string };
    assert.equal(body.error, 'federation_denied');
    assert.ok(/deny/i.test(body.reason ?? ''), 'the rejection reason mentions the deny list');
    assert.equal(noticeCount, 0, 'nothing delivered to the recipient');
  });

  test('recipient deny list → inbound offer rejected (canAccept), no notice', async () => {
    // Open on both; acme is NOT denied on its own side, so it sends — but globex has
    // acme on its deny list, so the inbound edge (canAccept) blocks it. Deny beats Open.
    const { res, noticeCount } = await runOffer({
      acmeMode: 'intra_server',
      globexMode: 'intra_server',
      acmePolicy: 'user_open',
      globexPolicy: 'user_open',
      denyAcmeOnGlobex: true,
    });
    assert.notEqual(res.status, 200, 'inbound edge rejects an offer from a denied peer');
    assert.equal(noticeCount, 0, 'no notice created for a denied peer');
  });

  test('recipient deny beats its own allow list (deny wins under admin_whitelist)', async () => {
    // globex both whitelists AND denies acme; deny must win → inbound rejected.
    const { res, noticeCount } = await runOffer({
      acmeMode: 'intra_server',
      globexMode: 'intra_server',
      acmePolicy: 'user_open',
      globexPolicy: 'admin_whitelist',
      whitelistAcmeOnGlobex: true,
      denyAcmeOnGlobex: true,
    });
    assert.notEqual(res.status, 200, 'deny wins even when the peer is also allow-listed');
    assert.equal(noticeCount, 0);
  });
});

// ─── /api/federation/sync auth (assertion 7) ───────────────────────────────────

describe('federation Phase 2 — /sync link-secret auth', () => {
  test('wrong/absent secret rejected; revoked link rejected; active link serves', async () => {
    const modes: Record<string, FederationMode> = { acme: 'intra_server', globex: 'intra_server' };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    setFederationPolicy(acme.db, 'user_open');
    setFederationPolicy(globex.db, 'user_open');
    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = seedRoadmap(acme, alice.id);

    // Drive the handshake so acme has an ACTIVE outbound link with a known secret.
    await offer(acme, alice.token, 'bob@globex', roadmap, 'read');
    const notice = listOpenNotices(globex.db, bob.id)[0]!;
    await globex.app.fetch(
      new Request(`http://globex.test/api/notices/${notice.id}/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    const link = listLinks(acme.db)[0]!;
    assert.equal(link.status, 'active');

    const sync = (secret?: string) =>
      acme.app.fetch(
        new Request('http://acme.test/api/federation/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(secret ? { __link_secret: secret } : {}),
        }),
      );

    // Absent secret → 401.
    assert.equal((await sync()).status, 401, 'absent secret rejected');
    // Wrong secret → 401.
    assert.equal((await sync('not-the-secret')).status, 401, 'wrong secret rejected');
    // Correct secret on the active link → 200 with a scoped payload.
    const ok = await sync(link.secret);
    assert.equal(ok.status, 200, 'active-link secret serves');
    const payload = (await ok.json()) as { ops: unknown[] };
    assert.ok(Array.isArray(payload.ops) && payload.ops.length > 0, 'payload has scoped ops');

    // Revoke the link → the same correct secret is now rejected.
    setLinkStatus(acme.db, link.id, 'revoked');
    assert.equal((await sync(link.secret)).status, 401, 'revoked link rejected');
  });
});
