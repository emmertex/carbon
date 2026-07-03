/**
 * Federation Phase-3b: declining an offer writes back to the issuer.
 *
 * Phase 2 landed the offer→accept handshake and a decline that only tombstoned the
 * RECIPIENT's local pending link — the ISSUER's pending link dangled forever and the
 * offerer was never told. This suite proves the decline write-back:
 *
 *   1. bob declines alice's offer → BOTH pending links are tombstoned with no dangling
 *      roots, and alice gets an informational `federation_declined` notice naming bob +
 *      "Roadmap".
 *   2. If the issuer callback fails, the recipient's local decline still tombstones its
 *      link (no exception escapes the decline).
 *
 * Same two-tenant L2 loopback harness as Phase 2, but the world's `deliverToPeer` is
 * wrappable so a test can inject a failure on the `/offers/declined` path.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Hono } from 'hono';
import { createItem, getUserByUsername, createUser as coreCreateUser } from '@carbon/core';
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
import {
  ensureNoticeTables,
  getNotice,
  actOnNotice,
  listOpenNotices,
  type SystemNotice,
} from './notices';
import {
  ensureFederationTables,
  ensureGovernanceTables,
  federationRoutes,
  setFederationPolicy,
  listLinks,
  listLinkRoots,
  getLink,
  memBlobStore,
  type FederationMode,
  type DeliverToPeer,
} from './federation';

// ─── two-tenant harness (mirrors phase2, but deliverToPeer is wrappable) ─────────

interface Tenant {
  label: string;
  db: ReturnType<typeof openDb>;
  deviceId: string;
  app: Hono<{ Variables: AuthVars }>;
  addUser(username: string, password: string): { id: string; token: string };
}

function createUserRow(db: ReturnType<typeof openDb>, username: string): string {
  return coreCreateUser(db, { username, displayName: username, role: 'admin' }).id;
}

/**
 * `wrap` lets a test intercept the loopback transport (e.g. to fail the declined
 * callback). It receives the base deliver and returns the effective one. Because
 * `bindOfferDelivery` captures the deliver passed to `federationRoutes`, the wrapper
 * must be in place BEFORE tenants are built — so it's passed to `makeWorld`.
 */
function makeWorld(
  mode: () => Record<string, FederationMode>,
  wrap?: (base: DeliverToPeer) => DeliverToPeer,
) {
  const tenants = new Map<string, Tenant>();

  const baseDeliver: DeliverToPeer = async (peerBaseUrl, path, body) => {
    const peer = tenants.get(peerBaseUrl);
    if (!peer) throw new Error('unsupported_peer');
    const req = new Request(`http://${peerBaseUrl}.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return peer.app.fetch(req);
  };
  const deliverToPeer: DeliverToPeer = wrap ? wrap(baseDeliver) : baseDeliver;

  function makeTenant(label: string): Tenant {
    const db = openDb(':memory:');
    migrate(db);
    ensureServerTables(db);
    ensureNoticeTables(db);
    ensureFederationTables(db);
    ensureGovernanceTables(db);
    const deviceId = ensureDeviceId(db);

    const sessionAuth = basicAuth(db, false);

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
        const id = u ? u.id : createUserRow(db, username);
        setPassword(db, id, hashPassword(password));
        return { id, token: createSession(db, id) };
      },
    };
    tenants.set(label, t);
    return t;
  }

  return { tenants, makeTenant };
}

function seedRoadmap(acme: Tenant, aliceId: string): { roadmap: string } {
  const roadmap = createItem(acme.db, acme.deviceId, {
    type: 'project',
    parentId: null,
    ownerId: aliceId,
    title: 'Roadmap',
  });
  createItem(acme.db, acme.deviceId, {
    type: 'task',
    parentId: roadmap.id,
    ownerId: aliceId,
    title: 'Ship v1',
  });
  return { roadmap: roadmap.id };
}

async function offer(
  acme: Tenant,
  aliceToken: string,
  to: string,
  rootItemId: string,
): Promise<Response> {
  return acme.app.fetch(
    new Request('http://acme.test/api/federation/offers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ to, root_item_id: rootItemId, permission: 'read' }),
    }),
  );
}

async function declineNotice(globex: Tenant, bobToken: string, notice: SystemNotice) {
  return globex.app.fetch(
    new Request(`http://globex.test/api/notices/${notice.id}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ action: 'decline' }),
    }),
  );
}

// ─── 1. decline write-back: both sides torn down + issuer notified ───────────────

describe('federation Phase 3b — decline notifies the issuer + clears dangling links', () => {
  test('bob declines → acme + globex pending links tombstoned with no dangling roots; alice gets a federation_declined notice naming bob + Roadmap', async () => {
    const modes: Record<string, FederationMode> = { acme: 'intra_server', globex: 'intra_server' };
    const world = makeWorld(() => modes);
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    setFederationPolicy(acme.db, 'user_open');
    setFederationPolicy(globex.db, 'user_open');

    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = seedRoadmap(acme, alice.id);

    // Offer → pending on both sides.
    const res = await offer(acme, alice.token, 'bob@globex', roadmap);
    assert.equal(res.status, 200, await res.text().catch(() => ''));
    const acmeLink = listLinks(acme.db)[0]!;
    const globexLink = listLinks(globex.db)[0]!;
    assert.equal(acmeLink.status, 'pending');
    assert.equal(globexLink.status, 'pending');
    assert.equal(listLinkRoots(acme.db, acmeLink.id).length, 1, 'issuer has the granted root');

    // bob declines.
    const notice = listOpenNotices(globex.db, bob.id)[0]!;
    assert.equal(notice.kind, 'federation_offer');
    const act = await declineNotice(globex, bob.token, notice);
    const actBody = (await act.json()) as { notice: { state: string } };
    assert.equal(act.status, 200, JSON.stringify(actBody));
    assert.equal(actBody.notice.state, 'declined');

    // Recipient (globex) link tombstoned, no dangling roots.
    assert.equal(getLink(globex.db, globexLink.id)!.status, 'revoked', 'recipient link revoked');
    assert.equal(
      listLinkRoots(globex.db, globexLink.id).length,
      0,
      'recipient roots cleaned',
    );

    // Issuer (acme) link tombstoned by the callback, no dangling roots, and the
    // offer-correlation row is gone.
    assert.equal(getLink(acme.db, acmeLink.id)!.status, 'revoked', 'issuer link revoked');
    assert.equal(
      listLinkRoots(acme.db, acmeLink.id).length,
      0,
      'issuer roots cleaned (no dangling link/root)',
    );
    const offerRow = acme.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM federation_offers')!;
    assert.equal(offerRow.n, 0, 'issuer offer-correlation row deleted');

    // alice has a federation_declined notice naming bob + Roadmap.
    const aliceNotices = listOpenNotices(acme.db, alice.id);
    const declined = aliceNotices.find((n) => n.kind === 'federation_declined');
    assert.ok(declined, 'alice has a federation_declined notice');
    assert.equal(declined!.state, 'pending', 'informational notice awaits dismiss');
    const item = acme.db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', [
      declined!.item_id,
    ])!;
    assert.ok(item.title.includes('Roadmap'), 'title names the shared root');
    assert.ok(
      item.title.toLowerCase().includes('globex') || item.title.toLowerCase().includes('bob'),
      'title names the recipient',
    );

    // The generic Dismiss resolves the informational notice (no dedicated handler).
    const dismissed = await acme.app.fetch(
      new Request(`http://acme.test/api/notices/${declined!.id}/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ action: 'dismiss' }),
      }),
    );
    assert.equal(dismissed.status, 200, 'declined notice dismissible via generic path');
    assert.equal(
      listOpenNotices(acme.db, alice.id).some((n) => n.kind === 'federation_declined'),
      false,
      'declined notice leaves the inbox after dismiss',
    );
  });

  // ─── 2. best-effort: an unreachable issuer must not break the local decline ─────

  test('issuer callback throws → recipient still tombstones its link; no exception escapes', async () => {
    const modes: Record<string, FederationMode> = { acme: 'intra_server', globex: 'intra_server' };
    // Fail ONLY the declined callback; the inbound offer + everything else works.
    const wrap = (base: DeliverToPeer): DeliverToPeer => async (peerBaseUrl, path, body) => {
      if (path === '/api/federation/offers/declined') {
        throw new Error('issuer unreachable');
      }
      return base(peerBaseUrl, path, body);
    };
    const world = makeWorld(() => modes, wrap);
    const acme = world.makeTenant('acme');
    const globex = world.makeTenant('globex');
    setFederationPolicy(acme.db, 'user_open');
    setFederationPolicy(globex.db, 'user_open');

    const alice = acme.addUser('alice', 'pw');
    const bob = globex.addUser('bob', 'pw');
    const { roadmap } = seedRoadmap(acme, alice.id);

    const res = await offer(acme, alice.token, 'bob@globex', roadmap);
    assert.equal(res.status, 200, await res.text().catch(() => ''));
    const globexLink = listLinks(globex.db)[0]!;

    const notice = listOpenNotices(globex.db, bob.id)[0]!;
    const act = await declineNotice(globex, bob.token, notice);
    const actBody = (await act.json()) as { notice: { state: string } };
    // No exception escaped: the act route returned 200 and the notice is declined.
    assert.equal(act.status, 200, JSON.stringify(actBody));
    assert.equal(actBody.notice.state, 'declined');

    // The recipient's local decline stands despite the failed callback.
    assert.equal(getLink(globex.db, globexLink.id)!.status, 'revoked', 'recipient link revoked');
    assert.equal(listLinkRoots(globex.db, globexLink.id).length, 0, 'recipient roots cleaned');

    // The issuer never heard about it (callback failed): its link still dangles and
    // alice got NO notice — that's the acceptable best-effort trade-off.
    assert.equal(listLinks(acme.db)[0]!.status, 'pending', 'issuer link untouched (callback failed)');
    assert.equal(
      listOpenNotices(acme.db, alice.id).some((n) => n.kind === 'federation_declined'),
      false,
      'no declined notice on the issuer when the callback fails',
    );
  });
});
