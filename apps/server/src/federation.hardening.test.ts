/**
 * Federation hardening: one-shot offer confirm (B), paged incremental pull (F),
 * inbound-offer gating/rate limits/callback validation (G), and pending-link bounds +
 * hashed secret lookup (H). Same two-tenant loopback harness as the phase tests.
 */
import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { Hono } from 'hono';
import {
  createItem,
  getItem,
  getUserByUsername,
  migrate,
  ensureDeviceId,
  createUser as coreCreateUser,
} from '@carbon/core';
import { openDb } from './sqlite';
import { ensureServerTables, basicAuth, hashPassword, setPassword, createSession, type AuthVars } from './auth';
import { ensureNoticeTables, getNotice, actOnNotice, listOpenNotices } from './notices';
import {
  ensureFederationTables,
  ensureGovernanceTables,
  federationRoutes,
  setFederationPolicy,
  addPeer,
  listLinks,
  getLink,
  memBlobStore,
  buildIncrementalPullPayload,
  findActiveLinkBySecret,
  expireStalePendingLinks,
  isValidCallbackBase,
  runFederationExchange,
  resetFederationRateLimits,
  FEDERATION_INBOUND_PER_IP_HOUR,
  FEDERATION_MAX_PENDING_PER_ADDRESSEE,
  FEDERATION_PENDING_TTL_MS,
  createLink,
  type FederationMode,
  type DeliverToPeer,
  type FederationSyncLimits,
} from './federation';

type Db = ReturnType<typeof openDb>;

interface Tenant {
  label: string;
  db: Db;
  deviceId: string;
  app: Hono<{ Variables: AuthVars }>;
  addUser(username: string): { id: string; token: string };
}

function makeWorld(opts: { limits?: Record<string, Partial<FederationSyncLimits>> } = {}) {
  const tenants = new Map<string, Tenant>();
  const calls: { peer: string; path: string }[] = [];
  const deliverToPeer: DeliverToPeer = async (peerBaseUrl, path, body) => {
    calls.push({ peer: peerBaseUrl, path });
    const peer = tenants.get(peerBaseUrl);
    if (!peer) throw new Error('unsupported_peer');
    return peer.app.fetch(
      new Request(`http://${peerBaseUrl}.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    );
  };
  function makeTenant(label: string, mode: FederationMode = 'intra_server'): Tenant {
    const db = openDb(':memory:');
    migrate(db);
    ensureServerTables(db);
    ensureNoticeTables(db);
    ensureFederationTables(db);
    ensureGovernanceTables(db);
    setFederationPolicy(db, 'user_open');
    const deviceId = ensureDeviceId(db);
    const sessionAuth = basicAuth(db, false);
    const app = new Hono<{ Variables: AuthVars }>();
    app.post('/api/notices/:id/act', sessionAuth, async (c) => {
      const notice = getNotice(db, c.req.param('id'));
      if (!notice || notice.user_id !== c.get('userId')) return c.json({ error: 'nope' }, 403);
      const b = (await c.req.json().catch(() => ({}))) as { action?: string };
      return c.json({ notice: await actOnNotice(db, deviceId, notice, b.action ?? 'dismiss') });
    });
    app.route(
      '/api/federation',
      federationRoutes({
        db,
        serverDeviceId: deviceId,
        myLabel: label,
        resolveMode: () => mode,
        deliverToPeer,
        blobStore: memBlobStore(),
        sessionAuth,
        syncLimits: opts.limits?.[label],
      }),
    );
    const t: Tenant = {
      label,
      db,
      deviceId,
      app,
      addUser(username) {
        const u = getUserByUsername(db, username);
        const id = u ? u.id : coreCreateUser(db, { username, displayName: username, role: 'admin' }).id;
        setPassword(db, id, hashPassword('pw'));
        return { id, token: createSession(db, id) };
      },
    };
    tenants.set(label, t);
    return t;
  }
  return { tenants, calls, deliverToPeer, makeTenant };
}

function post(t: Tenant, path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return Promise.resolve(
    t.app.fetch(
      new Request(`http://${t.label}.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    ),
  );
}

function seed(t: Tenant, ownerId: string, children = 1): { root: string; kids: string[] } {
  const root = createItem(t.db, t.deviceId, { type: 'project', parentId: null, ownerId, title: 'Roadmap' });
  const kids: string[] = [];
  for (let i = 0; i < children; i++) {
    kids.push(createItem(t.db, t.deviceId, { type: 'task', parentId: root.id, ownerId, title: `k${i}` }).id);
  }
  return { root: root.id, kids };
}

/** Run a full offer → accept between acme(alice) and globex(bob). */
async function offerAndAccept(acme: Tenant, globex: Tenant, alice: { token: string }, bob: { id: string; token: string }, root: string) {
  const r = await post(acme, '/api/federation/offers', { to: 'bob@globex', root_item_id: root }, alice.token);
  assert.equal(r.status, 200, await r.text());
  const notice = listOpenNotices(globex.db, bob.id)[0]!;
  const act = await post(globex, `/api/notices/${notice.id}/act`, { action: 'accept' }, bob.token);
  assert.equal(act.status, 200);
  return notice;
}

function offerSecretFor(db: Db, linkId: string): string | undefined {
  return db.get<{ offer_secret: string }>('SELECT offer_secret FROM federation_offers WHERE link_id = ?', [linkId])
    ?.offer_secret;
}

beforeEach(() => resetFederationRateLimits());

// ─── B: one-shot confirm ───────────────────────────────────────────────────────

describe('federation hardening B — /offers/confirm is one-shot and pending-only', () => {
  test('confirm consumes the offer row; a replay is rejected', async () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    const globex = w.makeTenant('globex');
    const alice = acme.addUser('alice');
    const bob = globex.addUser('bob');
    const { root } = seed(acme, alice.id);
    const r = await post(acme, '/api/federation/offers', { to: 'bob@globex', root_item_id: root }, alice.token);
    assert.equal(r.status, 200);
    const link = listLinks(acme.db)[0]!;
    const secret = offerSecretFor(acme.db, link.id)!;
    assert.ok(secret);

    const ok = await post(acme, '/api/federation/offers/confirm', {
      offer_secret: secret,
      addressee_id: bob.id,
      addressee_username: 'bob',
    });
    assert.equal(ok.status, 200);
    assert.equal(getLink(acme.db, link.id)!.status, 'active');
    assert.equal(offerSecretFor(acme.db, link.id), undefined, 'offer row deleted on confirm');

    const replay = await post(acme, '/api/federation/offers/confirm', {
      offer_secret: secret,
      addressee_id: 'someone-else',
      addressee_username: 'bob',
    });
    assert.equal(replay.status, 401);
    const shares = acme.db.all<{ user_id: string }>('SELECT user_id FROM shares WHERE item_id = ? AND deleted = 0', [root]);
    assert.deepEqual(
      shares.map((s) => s.user_id).filter((u) => u.startsWith('remote:')),
      [`remote:globex:${bob.id}`],
    );
  });

  test('a revoked pending link cannot be reactivated (409), and revoke drops the offer row', async () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    w.makeTenant('globex').addUser('bob');
    const alice = acme.addUser('alice');
    const { root } = seed(acme, alice.id);
    await post(acme, '/api/federation/offers', { to: 'bob@globex', root_item_id: root }, alice.token);
    const link = listLinks(acme.db)[0]!;
    const secret = offerSecretFor(acme.db, link.id)!;

    // Status flipped to revoked while the offer row still exists (e.g. older data).
    acme.db.run("UPDATE federation_links SET status = 'revoked' WHERE id = ?", [link.id]);
    const res = await post(acme, '/api/federation/offers/confirm', { offer_secret: secret, addressee_username: 'bob' });
    assert.equal(res.status, 409);
    assert.equal(getLink(acme.db, link.id)!.status, 'revoked');
  });

  test('confirm bound to the offered addressee; a shadow-ref-smuggling id is refused', async () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    w.makeTenant('globex').addUser('bob');
    const alice = acme.addUser('alice');
    const { root } = seed(acme, alice.id);
    await post(acme, '/api/federation/offers', { to: 'bob@globex', root_item_id: root }, alice.token);
    const link = listLinks(acme.db)[0]!;
    const secret = offerSecretFor(acme.db, link.id)!;

    const wrongUser = await post(acme, '/api/federation/offers/confirm', {
      offer_secret: secret,
      addressee_id: 'x',
      addressee_username: 'mallory',
    });
    assert.equal(wrongUser.status, 409);
    const smuggle = await post(acme, '/api/federation/offers/confirm', {
      offer_secret: secret,
      addressee_id: 'x:remote:evil',
      addressee_username: 'bob',
    });
    assert.equal(smuggle.status, 400);
    assert.equal(getLink(acme.db, link.id)!.status, 'pending');
  });

  test('confirm on an inbound link is 409', async () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    const link = createLink(acme.db, { peerBaseUrl: 'globex', peerLabel: 'globex', direction: 'inbound' });
    // Touch a route that creates the offer table, then plant an offer row for the inbound link.
    await post(acme, '/api/federation/offers/verify', { offer_secret: 'none' });
    acme.db.run(
      "INSERT INTO federation_offers (link_id, offer_secret, created_at) VALUES (?, 'sek', ?)",
      [link.id, new Date().toISOString()],
    );
    const res = await post(acme, '/api/federation/offers/confirm', { offer_secret: 'sek' });
    assert.equal(res.status, 409);
  });
});

// ─── F: paged incremental pull ─────────────────────────────────────────────────

describe('federation hardening F — incremental pull is capped and paged', () => {
  test('pages under maxOps concatenate to the full uncapped result', () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    const alice = acme.addUser('alice');
    const { root } = seed(acme, alice.id, 9);
    const full = buildIncrementalPullPayload(acme.db, [root], 0, 0);
    assert.equal(full.truncated, false);

    const got: string[] = [];
    let since = 0;
    let rsince = 0;
    let pages = 0;
    for (;;) {
      const pg = buildIncrementalPullPayload(acme.db, [root], since, rsince, undefined, undefined, { maxOps: 3 });
      assert.ok(pg.payload.ops.length + pg.payload.records.length <= 3);
      got.push(...pg.payload.ops.map((o) => o.id));
      since = pg.since;
      rsince = pg.rsince;
      pages++;
      if (!pg.truncated) break;
      assert.ok(pages < 50);
    }
    assert.ok(pages > 1, 'backlog arrived in several pages');
    assert.deepEqual(got.sort(), full.payload.ops.map((o) => o.id).sort());
    assert.equal(since, full.since);
  });

  test('maxScan bounds the SQL scan and marks the page truncated', () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    const alice = acme.addUser('alice');
    const { root } = seed(acme, alice.id, 4);
    const pg = buildIncrementalPullPayload(acme.db, [root], 0, 0, undefined, undefined, { maxScan: 2 });
    assert.equal(pg.truncated, true);
    assert.ok(pg.payload.ops.length <= 2);
    assert.equal(pg.rsince, 0, 'records deferred while ops are truncated');
  });

  test('initial pull and the exchange loop follow `truncated` until the backlog is through', async () => {
    const limits = { maxOps: 2 };
    const w = makeWorld({ limits: { acme: limits, globex: limits } });
    const acme = w.makeTenant('acme');
    const globex = w.makeTenant('globex');
    const alice = acme.addUser('alice');
    const bob = globex.addUser('bob');
    const { root, kids } = seed(acme, alice.id, 7);
    await offerAndAccept(acme, globex, alice, bob, root);
    for (const id of [root, ...kids]) assert.ok(getItem(globex.db, id), `initial pull delivered ${id}`);

    // A further backlog on the owner arrives via paged exchange rounds.
    const more: string[] = [];
    for (let i = 0; i < 9; i++) {
      more.push(createItem(acme.db, acme.deviceId, { type: 'task', parentId: root, ownerId: alice.id, title: `m${i}` }).id);
    }
    const gLink = listLinks(globex.db)[0]!;
    await runFederationExchange(globex.db, gLink, w.deliverToPeer, 'globex', limits);
    for (const id of more) assert.ok(getItem(globex.db, id), `exchange delivered ${id}`);
  });
});

// ─── G: inbound-offer gating ───────────────────────────────────────────────────

describe('federation hardening G — /offers/inbound gates before I/O', () => {
  const inbound = (cb: string, from = 'bob', extra: Record<string, unknown> = {}) => ({
    from,
    callback_base_url: cb,
    link_secret: 'l'.repeat(48),
    offer_secret: 'o'.repeat(48),
    ...extra,
  });

  test('a denied peer / disabled mode gets 403 with no outbound challenge', async () => {
    const w = makeWorld();
    const globex = w.makeTenant('globex');
    globex.addUser('bob');
    addPeer(globex.db, { baseUrl: 'evil', subdomain: 'evil', listType: 'deny' });
    const res = await post(globex, '/api/federation/offers/inbound', inbound('evil'));
    assert.equal(res.status, 403);
    assert.equal(w.calls.length, 0, 'no outbound request for a denied peer');

    const off = w.makeTenant('offhost', 'off');
    const r2 = await post(off, '/api/federation/offers/inbound', inbound('acme'));
    assert.equal(r2.status, 403);
    assert.equal(w.calls.length, 0);
  });

  test('callback_base_url must be a label, host or https origin', async () => {
    for (const ok of ['acme', 'acme.example.com', 'acme.example.com:8443', 'https://acme.example.com', 'https://acme.example.com/']) {
      assert.equal(isValidCallbackBase(ok), true, ok);
    }
    for (const bad of [
      'http://acme.example.com',
      'https://acme.example.com/evil/path',
      'https://user@acme.example.com',
      'acme.example.com/api',
      'acme..com',
      'https://acme.example.com?x=1',
      'acme example',
      'file:///etc/passwd',
      '',
    ]) {
      assert.equal(isValidCallbackBase(bad), false, bad);
    }
    const w = makeWorld();
    const globex = w.makeTenant('globex');
    const res = await post(globex, '/api/federation/offers/inbound', inbound('https://acme.example.com/x/y'));
    assert.equal(res.status, 400);
    assert.equal(w.calls.length, 0);
  });

  test('per-IP rate limit returns 429', async () => {
    const w = makeWorld();
    const globex = w.makeTenant('globex');
    let last = 0;
    for (let i = 0; i <= FEDERATION_INBOUND_PER_IP_HOUR; i++) {
      last = (await post(globex, '/api/federation/offers/inbound', inbound('ghost'))).status;
    }
    assert.equal(last, 429);
  });
});

// ─── H: pending bounds, enumeration, expiry, hashed lookup ─────────────────────

describe('federation hardening H — pending links are bounded and expire', () => {
  test('unknown addressee gets the same 200 as a real one (no enumeration), and no link', async () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    const globex = w.makeTenant('globex');
    const alice = acme.addUser('alice');
    globex.addUser('bob');
    const { root } = seed(acme, alice.id);
    const real = await post(acme, '/api/federation/offers', { to: 'bob@globex', root_item_id: root }, alice.token);
    const ghost = await post(acme, '/api/federation/offers', { to: 'nobody@globex', root_item_id: root }, alice.token);
    assert.equal(real.status, 200);
    assert.equal(ghost.status, 200);
    assert.equal(listLinks(globex.db).length, 1, 'only the real addressee got a pending link');
  });

  test('per-addressee pending cap stops minting links (silently)', async () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    const globex = w.makeTenant('globex');
    const alice = acme.addUser('alice');
    globex.addUser('bob');
    const { root } = seed(acme, alice.id);
    for (let i = 0; i < FEDERATION_MAX_PENDING_PER_ADDRESSEE + 3; i++) {
      const r = await post(acme, '/api/federation/offers', { to: 'bob@globex', root_item_id: root }, alice.token);
      assert.equal(r.status, 200);
    }
    assert.equal(
      listLinks(globex.db).filter((l) => l.status === 'pending').length,
      FEDERATION_MAX_PENDING_PER_ADDRESSEE,
    );
  });

  test('stale pending links expire (link revoked, offer row gone, notice expired, accept is inert)', async () => {
    const w = makeWorld();
    const acme = w.makeTenant('acme');
    const globex = w.makeTenant('globex');
    const alice = acme.addUser('alice');
    const bob = globex.addUser('bob');
    const { root } = seed(acme, alice.id);
    await post(acme, '/api/federation/offers', { to: 'bob@globex', root_item_id: root }, alice.token);
    const notice = listOpenNotices(globex.db, bob.id)[0]!;
    const aLink = listLinks(acme.db)[0]!;
    const later = Date.now() + FEDERATION_PENDING_TTL_MS + 60_000;
    assert.equal(expireStalePendingLinks(acme.db, later), 1);
    assert.equal(expireStalePendingLinks(globex.db, later), 1);
    assert.equal(getLink(acme.db, aLink.id)!.status, 'revoked');
    assert.equal(offerSecretFor(acme.db, aLink.id), undefined);
    assert.equal(getNotice(globex.db, notice.id)!.state, 'expired');
    // Acting on the stale notice must not reactivate the inbound link.
    const act = await post(globex, `/api/notices/${notice.id}/act`, { action: 'accept' }, bob.token);
    assert.equal(act.status, 200);
    assert.equal(listLinks(globex.db)[0]!.status, 'revoked');
  });

  test('findActiveLinkBySecret: indexed hash lookup, legacy rows backfilled by migration', () => {
    const db = openDb(':memory:');
    migrate(db);
    ensureFederationTables(db);
    const link = createLink(db, { peerBaseUrl: 'acme', direction: 'inbound', secret: 'abc123', status: 'active' });
    assert.equal(findActiveLinkBySecret(db, 'abc123')?.id, link.id);
    assert.equal(findActiveLinkBySecret(db, 'abc124'), undefined);
    assert.equal(findActiveLinkBySecret(db, 'abc12'), undefined);
    // Simulate a pre-migration row: no hash → re-running the migration backfills it.
    db.run('UPDATE federation_links SET secret_hash = NULL');
    assert.equal(findActiveLinkBySecret(db, 'abc123'), undefined);
    ensureFederationTables(db);
    assert.equal(findActiveLinkBySecret(db, 'abc123')?.id, link.id);
    const plan = db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM federation_links WHERE secret_hash = 'x' AND status = 'active'",
    );
    assert.ok(plan.some((p) => p.detail.includes('idx_fed_links_secret_hash')), JSON.stringify(plan));
  });
});
