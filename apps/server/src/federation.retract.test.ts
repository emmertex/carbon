/**
 * Federation retraction: OWNER-AUTHORITATIVE move-out. When the owner (the side that
 * owns the granted roots) moves an item OUT of the shared subtree — or revokes — the
 * grantee's materialized shadow copy must be DROPPED, not silently stranded. Without
 * this the grantee keeps its last-synced copy forever and, worse, a grantee edit to
 * that moved-out item is scope-rejected by the owner → the two copies fork permanently.
 *
 * Two in-process tenant DBs (acme/alice/Roadmap OWNS the roots ↔ globex/bob grantee),
 * wired by the same loopback `deliverToPeer` the phase-3 suite uses. The link is granted
 * WRITE so both the divergence path and the pure move-out path are exercisable.
 *
 * Covers the 6 required assertions:
 *   1. reparent a child OUT of the shared root → grantee drops it; owner's copy unaffected
 *   2. divergence gone: a grantee edit before the retract round does NOT resurrect/fork
 *   3. a moved-out SUBTREE (T with child C) drops whole on the grantee
 *   4. moving an item WITHIN the shared subtree does NOT retract it
 *   5. a grantee cannot make the owner drop data (grantee→owner retract is ignored)
 *   6. revoke-retract-all: revoking the owner link drops the whole shared subtree
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Hono } from 'hono';
import {
  createItem,
  updateItem,
  getItem,
  ingestOps,
  visibleItemIds,
  getUserByUsername,
  createUser as coreCreateUser,
  migrate,
  ensureDeviceId,
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
  registerFederationConfigRoutes,
  setFederationPolicy,
  listLinks,
  runFederationExchange,
  applyRetraction,
  memBlobStore,
  type FederationLink,
  type FederationMode,
  type DeliverToPeer,
} from './federation';

// ─── two-tenant harness (mirrors the phase-3 harness) ──────────────────────────

interface Tenant {
  label: string;
  db: ReturnType<typeof openDb>;
  deviceId: string;
  app: Hono<{ Variables: AuthVars }>;
  addUser(username: string, password: string): { id: string; token: string };
}

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
    const sessionAuth = basicAuth(db, false);

    const api = new Hono<{ Variables: AuthVars }>();
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

    // The Phase-4 config routes (with delivery) so /links/:id/revoke can retract-all.
    registerFederationConfigRoutes(api, {
      db,
      resolveMode: () => mode()[label] ?? 'off',
      // In this harness every seeded user is an admin, so requireSession/requireAdmin
      // both collapse to the plain session auth.
      sessionAuth,
      adminAuth: sessionAuth,
      deliverToPeer,
    });
    app.route('/api', api);

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
      addUser(username, password) {
        const u = getUserByUsername(db, username);
        const id = u ? u.id : coreCreateUser(db, { username, displayName: username, role: 'admin' }).id;
        setPassword(db, id, hashPassword(password));
        return { id, token: createSession(db, id) };
      },
    };
    tenants.set(label, t);
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
    title: 'T',
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

/** Drive the full offer→approve handshake. After this the acme (outbound/owner) +
 *  globex (inbound/grantee) links are active and Roadmap+T are materialized on globex. */
async function handshake(permission: 'read' | 'write') {
  const modes: Record<string, FederationMode> = { acme: 'intra_server', globex: 'intra_server' };
  const world = makeWorld(() => modes);
  const acme = world.makeTenant('acme');
  const globex = world.makeTenant('globex');
  setFederationPolicy(acme.db, 'user_open');
  setFederationPolicy(globex.db, 'user_open');
  const alice = acme.addUser('alice', 'pw');
  const bob = globex.addUser('bob', 'pw');
  const { roadmap, child } = seedRoadmap(acme, alice.id);

  const res = await offer(acme, alice.token, 'bob@globex', roadmap, permission);
  assert.equal(res.status, 200, await res.text().catch(() => ''));
  const notice = listOpenNotices(globex.db, bob.id)[0]!;
  const act = await globex.app.fetch(
    new Request(`http://globex.test/api/notices/${notice.id}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ action: 'accept' }),
    }),
  );
  assert.equal(act.status, 200);
  return { world, acme, globex, alice, bob, roadmap, child };
}

function links(acme: Tenant, globex: Tenant): { acme: FederationLink; globex: FederationLink } {
  return { acme: listLinks(acme.db)[0]!, globex: listLinks(globex.db)[0]! };
}

// A round from globex's side then acme's side — a full both-directions exchange. The
// OWNER (acme, outbound) computes + delivers retraction on ITS round.
async function exchangeBothWays(acme: Tenant, globex: Tenant, deliver: DeliverToPeer) {
  const l = links(acme, globex);
  await runFederationExchange(globex.db, l.globex, deliver, 'globex');
  await runFederationExchange(acme.db, l.acme, deliver, 'acme');
}

// ─── 1. move-out → grantee drops it, owner unaffected ───────────────────────────

describe('federation retract — owner move-out drops the grantee copy', () => {
  test('alice reparents T out of Roadmap → globex no longer shows T; acme keeps its T', async () => {
    const { world, acme, globex, alice, bob, roadmap, child } = await handshake('write');
    const deliver = world.deliverToPeer;

    // Prime one exchange so T is fully synced and the scope snapshot records it.
    await exchangeBothWays(acme, globex, deliver);
    assert.ok(getItem(globex.db, child), 'T materialized on globex');
    assert.ok(visibleItemIds(globex.db, bob.id).has(child), 'bob can see T pre-retract');

    // alice reparents T OUT of Roadmap into another acme project (leaves the shared subtree).
    const other = createItem(acme.db, acme.deviceId, {
      type: 'project',
      parentId: null,
      ownerId: alice.id,
      title: 'Other',
    });
    updateItem(acme.db, acme.deviceId, child, { parent_id: other.id });

    // Next exchange → the owner retracts T; globex drops it.
    await exchangeBothWays(acme, globex, deliver);

    assert.equal(getItem(globex.db, child), undefined, 'T hard-dropped on globex');
    assert.ok(!visibleItemIds(globex.db, bob.id).has(child), 'T gone from bob visibility');
    // acme's T is unaffected — still present, now under Other.
    const acmeT = getItem(acme.db, child)!;
    assert.ok(acmeT, "acme's T still exists");
    assert.equal(acmeT.parent_id, other.id, "acme's T moved under Other, not deleted");
  });
});

// ─── 2. divergence gone: a grantee edit before retract does not fork/resurrect ──

describe('federation retract — no silent divergence', () => {
  test('bob edits his copy of T before retraction → T absent on globex, acme keeps its own state', async () => {
    const { world, acme, globex, alice, bob, roadmap, child } = await handshake('write');
    const deliver = world.deliverToPeer;

    await exchangeBothWays(acme, globex, deliver);
    assert.ok(getItem(globex.db, child), 'T on globex');

    // bob edits HIS copy of T (a local write on globex) — the divergence seed.
    updateItem(globex.db, globex.deviceId, child, { title: 'T (bob edit)' });

    // alice reparents T out on acme in the SAME window.
    const other = createItem(acme.db, acme.deviceId, {
      type: 'project',
      parentId: null,
      ownerId: alice.id,
      title: 'Other',
    });
    updateItem(acme.db, acme.deviceId, child, { parent_id: other.id });

    // Converge. globex pushes bob's edit; acme scope-rejects it (T out of scope now) AND
    // retracts T. The retraction must win — no stranded/forked copy on globex.
    await exchangeBothWays(acme, globex, deliver);
    await exchangeBothWays(acme, globex, deliver);

    // No fork on globex: T is simply gone (not a diverged ghost).
    assert.equal(getItem(globex.db, child), undefined, 'no forked T left on globex');
    assert.ok(!visibleItemIds(globex.db, bob.id).has(child), 'bob no longer sees T');

    // acme's T keeps its own state (bob's scope-rejected edit never landed).
    const acmeT = getItem(acme.db, child)!;
    assert.equal(acmeT.title, 'T', "acme's T keeps its own title (no resurrection)");
    assert.equal(acmeT.parent_id, other.id, "acme's T is under Other");
    void bob;
  });
});

// ─── 3. moved-out subtree (T with child C) drops whole ──────────────────────────

describe('federation retract — subtree drops whole', () => {
  test('T with its own child C moved out → both T and C dropped on globex', async () => {
    const { world, acme, globex, alice, bob, roadmap, child } = await handshake('write');
    const deliver = world.deliverToPeer;

    // Give T a child C (still under Roadmap).
    const c = createItem(acme.db, acme.deviceId, {
      type: 'task',
      parentId: child,
      ownerId: alice.id,
      title: 'C',
    });
    await exchangeBothWays(acme, globex, deliver);
    assert.ok(getItem(globex.db, child), 'T on globex');
    assert.ok(getItem(globex.db, c.id), 'C on globex');

    // Move T (carrying C) OUT of Roadmap.
    const other = createItem(acme.db, acme.deviceId, {
      type: 'project',
      parentId: null,
      ownerId: alice.id,
      title: 'Other',
    });
    updateItem(acme.db, acme.deviceId, child, { parent_id: other.id });

    await exchangeBothWays(acme, globex, deliver);

    assert.equal(getItem(globex.db, child), undefined, 'T dropped on globex');
    assert.equal(getItem(globex.db, c.id), undefined, 'C (descendant) dropped on globex too');
    assert.ok(!visibleItemIds(globex.db, bob.id).has(c.id), 'C gone from bob visibility');
    // acme keeps both.
    assert.ok(getItem(acme.db, child), "acme's T intact");
    assert.ok(getItem(acme.db, c.id), "acme's C intact");
  });
});

// ─── 4. move WITHIN the shared subtree does NOT retract ─────────────────────────

describe('federation retract — in-subtree move is not a retraction', () => {
  test('reparenting T under another item still inside Roadmap does not drop it', async () => {
    const { world, acme, globex, alice, bob, roadmap, child } = await handshake('write');
    const deliver = world.deliverToPeer;

    // A second task under Roadmap to serve as the new parent (still in scope).
    const sibling = createItem(acme.db, acme.deviceId, {
      type: 'task',
      parentId: roadmap,
      ownerId: alice.id,
      title: 'Sibling',
    });
    await exchangeBothWays(acme, globex, deliver);
    assert.ok(getItem(globex.db, child), 'T on globex');

    // Move T UNDER sibling — still within the Roadmap subtree, so NOT a retraction.
    updateItem(acme.db, acme.deviceId, child, { parent_id: sibling.id });
    await exchangeBothWays(acme, globex, deliver);

    const gT = getItem(globex.db, child);
    assert.ok(gT, 'T still present on globex (in-subtree move, not retracted)');
    assert.equal(gT!.parent_id, sibling.id, 'T reparented under sibling on globex');
    assert.ok(visibleItemIds(globex.db, bob.id).has(child), 'bob still sees T');
  });
});

// ─── 5. a grantee cannot make the owner drop data ───────────────────────────────

describe('federation retract — grantee cannot retract owner data', () => {
  test('a retract field sent grantee→owner over an outbound link is ignored', async () => {
    const { world, acme, globex, roadmap, child } = await handshake('write');
    const deliver = world.deliverToPeer;
    const l = links(acme, globex);

    await exchangeBothWays(acme, globex, deliver);
    assert.ok(getItem(acme.db, child), 'T on acme (owner)');

    // globex (the grantee) POSTs a retract of Roadmap+T straight to acme's /sync using the
    // ACTIVE link secret. acme's link is OUTBOUND (acme owns the roots) → retract ignored.
    const res = await deliver('acme', '/api/federation/sync', {
      __link_secret: l.acme.secret,
      retract: [roadmap, child],
      since: 0,
      rsince: 0,
    });
    assert.equal(res.status, 200);

    assert.ok(getItem(acme.db, roadmap), 'owner Roadmap NOT dropped by a grantee retract');
    assert.ok(getItem(acme.db, child), 'owner T NOT dropped by a grantee retract');
  });
});

// ─── 6. revoke-retract-all ──────────────────────────────────────────────────────

describe('federation retract — revoke drops the shared roots', () => {
  test('revoking the owner link retracts all roots → grantee drops the whole subtree', async () => {
    const { world, acme, globex, alice, bob, roadmap, child } = await handshake('write');
    const deliver = world.deliverToPeer;

    await exchangeBothWays(acme, globex, deliver);
    assert.ok(getItem(globex.db, roadmap), 'Roadmap on globex');
    assert.ok(getItem(globex.db, child), 'T on globex');

    // alice (admin) revokes the outbound link via the config route — it retract-alls first.
    const l = links(acme, globex);
    const res = await acme.app.fetch(
      new Request(`http://acme.test/api/federation/links/${l.acme.id}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({}),
      }),
    );
    assert.equal(res.status, 200, await res.text().catch(() => ''));

    assert.equal(getItem(globex.db, roadmap), undefined, 'Roadmap dropped on globex after revoke');
    assert.equal(getItem(globex.db, child), undefined, 'T dropped on globex after revoke');
    assert.ok(!visibleItemIds(globex.db, bob.id).has(roadmap), 'bob no longer sees Roadmap');
  });
});

// ─── unit: applyRetraction is scoped + idempotent ───────────────────────────────

describe('federation retract — applyRetraction unit', () => {
  test('drops the id + descendants, leaves out-of-list items, and re-runs as a no-op', async () => {
    const { world, acme, globex, bob, roadmap, child } = await handshake('write');
    await exchangeBothWays(acme, globex, world.deliverToPeer);
    // A sibling of T under Roadmap that we do NOT retract — must survive.
    const keepId = 'globex-keep-under-roadmap';
    ingestOps(
      globex.db,
      [
        {
          id: 'keep-op',
          item_id: keepId,
          ts: Date.now(),
          device_id: 'x',
          fields: { type: 'task', parent_id: roadmap, owner_id: `remote:acme:someone`, title: 'keep' },
        },
      ],
      true,
    );
    assert.ok(getItem(globex.db, keepId), 'keep item present');

    applyRetraction(globex.db, [child]);
    assert.equal(getItem(globex.db, child), undefined, 'retracted T gone');
    assert.ok(getItem(globex.db, keepId), 'un-retracted sibling still present (scoped)');

    // Idempotent: re-running for the already-dropped id is a harmless no-op.
    applyRetraction(globex.db, [child]);
    assert.equal(getItem(globex.db, child), undefined, 'still gone, no throw');
    void bob;
  });
});
