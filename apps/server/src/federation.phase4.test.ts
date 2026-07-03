/**
 * Federation Phase-4: the REST config surface the Settings → Federation web panel
 * drives (`registerFederationConfigRoutes`). These are thin session/admin-authed
 * wrappers over the Phase-1 storage helpers; the tests here assert the AUTH posture
 * (admin-only vs session vs token-rejected) and the round-trips (policy get/set,
 * peers add/list/remove, links list, revoke), NOT the governance gate logic (proven
 * in phase2/phase3) — the gates are not re-implemented in this surface.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  createItem,
  createUser as coreCreateUser,
  migrate,
  ensureDeviceId,
  type Db,
} from '@carbon/core';
import { openDb } from './sqlite';
import {
  ensureServerTables,
  basicAuth,
  hashPassword,
  setPassword,
  createSession,
  createToken,
  type AuthVars,
} from './auth';
import { ensureNoticeTables } from './notices';
import {
  ensureFederationTables,
  ensureGovernanceTables,
  registerFederationConfigRoutes,
  createLink,
  addLinkRoot,
  getLink,
  getFederationPolicy,
  listPeers,
  type FederationMode,
} from './federation';

// ─── a single-tenant harness with a real `api` app (basicAuth + guards) ─────────

type Env = { Variables: AuthVars };

interface Harness {
  db: Db;
  deviceId: string;
  app: Hono<Env>;
  mode: FederationMode;
  admin: { id: string; token: string };
  member: { id: string; token: string };
  apiToken: string;
}

function makeHarness(mode: FederationMode = 'intra_server'): Harness {
  const db = openDb(':memory:');
  migrate(db);
  ensureServerTables(db);
  ensureNoticeTables(db);
  ensureFederationTables(db);
  ensureGovernanceTables(db);
  const deviceId = ensureDeviceId(db);

  const admin = coreCreateUser(db, { username: 'admin', displayName: 'Admin', role: 'admin' });
  setPassword(db, admin.id, hashPassword('pw'));
  const member = coreCreateUser(db, { username: 'member', displayName: 'Member', role: 'member' });
  setPassword(db, member.id, hashPassword('pw'));
  const { token: apiToken } = createToken(db, {
    userId: admin.id,
    name: 't',
    scopes: ['read', 'write'],
  });

  const h: Harness = {
    db,
    deviceId,
    mode,
    app: new Hono<Env>(),
    admin: { id: admin.id, token: createSession(db, admin.id) },
    member: { id: member.id, token: createSession(db, member.id) },
    apiToken,
  };

  // Mirror index.ts: global basicAuth, then the two human-only guards, then routes.
  h.app.use('/api/*', basicAuth(db, false));
  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('authMethod') === 'token') return c.json({ error: 'forbidden' }, 403);
    return next();
  };
  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('authMethod') === 'token' || c.get('role') !== 'admin') {
      return c.json({ error: 'forbidden' }, 403);
    }
    return next();
  };
  const api = new Hono<Env>();
  registerFederationConfigRoutes(api, {
    db,
    resolveMode: () => h.mode,
    sessionAuth: requireSession,
    adminAuth: requireAdmin,
  });
  h.app.route('/api', api);
  return h;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
function req(
  h: Harness,
  method: Method,
  path: string,
  auth?: { token?: string } | { bearer: string },
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth && 'token' in auth && auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth && 'bearer' in auth) headers.authorization = `Bearer ${auth.bearer}`;
  return Promise.resolve(
    h.app.fetch(
      new Request(`http://t.test/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ),
  );
}

const asAdmin = (h: Harness) => ({ token: h.admin.token });
const asMember = (h: Harness) => ({ token: h.member.token });
const asToken = (h: Harness) => ({ bearer: h.apiToken });

// ─── GET /config — session (any signed-in user); token rejected ─────────────────

describe('federation Phase 4 — GET /config', () => {
  test('member (session) may read config; token is 403', async () => {
    const h = makeHarness('intra_server');
    const res = await req(h, 'GET', '/federation/config', asMember(h));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      policy: string;
      ceiling: string;
      allow: unknown[];
      deny: unknown[];
      canOfferCrossServer: boolean;
    };
    assert.equal(body.policy, 'workspace_only', 'defaults to strictest policy');
    assert.equal(body.ceiling, 'intra_server', 'reports the effective host ceiling');
    assert.deepEqual(body.allow, [], 'allow list empty by default');
    assert.deepEqual(body.deny, [], 'deny list empty by default');
    // intra_server ceiling ⇒ no cross-server capability, and workspace_only ⇒ none anyway.
    assert.equal(body.canOfferCrossServer, false);

    const tok = await req(h, 'GET', '/federation/config', asToken(h));
    assert.equal(tok.status, 403, 'token auth rejected on session route');
  });

  test('canOfferCrossServer true only when ceiling is cross_server AND policy allows', async () => {
    const h = makeHarness('cross_server');
    // workspace_only still blocks it.
    let body = (await (await req(h, 'GET', '/federation/config', asAdmin(h))).json()) as {
      canOfferCrossServer: boolean;
    };
    assert.equal(body.canOfferCrossServer, false, 'workspace_only ⇒ no cross-server');
    // Open the policy → now cross-server is offered.
    await req(h, 'PATCH', '/federation/policy', asAdmin(h), { policy: 'user_open' });
    body = (await (await req(h, 'GET', '/federation/config', asAdmin(h))).json()) as {
      canOfferCrossServer: boolean;
    };
    assert.equal(body.canOfferCrossServer, true, 'cross_server ceiling + user_open ⇒ offered');
  });
});

// ─── PATCH /policy — admin only; validates; round-trips ─────────────────────────

describe('federation Phase 4 — PATCH /policy', () => {
  test('admin sets policy (round-trip); member/token 403; bad value 400', async () => {
    const h = makeHarness();

    // Member (session, non-admin) → 403.
    assert.equal(
      (await req(h, 'PATCH', '/federation/policy', asMember(h), { policy: 'user_open' })).status,
      403,
      'member cannot change policy',
    );
    // Token → 403.
    assert.equal(
      (await req(h, 'PATCH', '/federation/policy', asToken(h), { policy: 'user_open' })).status,
      403,
      'token cannot change policy',
    );
    assert.equal(getFederationPolicy(h.db), 'workspace_only', 'unchanged after rejected writes');

    // Admin sets a valid policy → persisted.
    const ok = await req(h, 'PATCH', '/federation/policy', asAdmin(h), { policy: 'admin_whitelist' });
    assert.equal(ok.status, 200);
    assert.equal(getFederationPolicy(h.db), 'admin_whitelist', 'policy round-trips to storage');

    // Admin sends garbage → 400, policy unchanged.
    const bad = await req(h, 'PATCH', '/federation/policy', asAdmin(h), { policy: 'nope' });
    assert.equal(bad.status, 400, 'invalid policy rejected');
    assert.equal(getFederationPolicy(h.db), 'admin_whitelist', 'unchanged after bad value');
  });
});

// ─── peers add / list / remove — admin only ─────────────────────────────────────

describe('federation Phase 4 — peers', () => {
  test('admin adds/lists/removes peers; member/token 403; base_url required', async () => {
    const h = makeHarness();

    // Member and token cannot add.
    assert.equal(
      (await req(h, 'POST', '/federation/peers', asMember(h), { base_url: 'globex' })).status,
      403,
    );
    assert.equal(
      (await req(h, 'POST', '/federation/peers', asToken(h), { base_url: 'globex' })).status,
      403,
    );
    assert.equal(listPeers(h.db).length, 0, 'nothing added by rejected callers');

    // Admin: missing base_url → 400.
    assert.equal(
      (await req(h, 'POST', '/federation/peers', asAdmin(h), { label: 'x' })).status,
      400,
      'base_url required',
    );

    // Admin adds a peer → 200, appears in listPeers with approved_by = admin.
    const add = await req(h, 'POST', '/federation/peers', asAdmin(h), {
      base_url: 'globex',
      subdomain: 'globex',
      label: 'Globex',
    });
    assert.equal(add.status, 200);
    const peers = listPeers(h.db);
    assert.equal(peers.length, 1);
    assert.equal(peers[0]!.base_url, 'globex');
    assert.equal(peers[0]!.subdomain, 'globex');
    assert.equal(peers[0]!.label, 'Globex');
    assert.equal(peers[0]!.approved_by, h.admin.id, 'records the approving admin');

    // It surfaces in GET /config's `allow` list for a member (read-only view).
    const cfg = (await (await req(h, 'GET', '/federation/config', asMember(h))).json()) as {
      allow: { id: string }[];
      deny: { id: string }[];
    };
    assert.equal(cfg.allow.length, 1, 'peer is on the allow list');
    assert.equal(cfg.deny.length, 0, 'nothing on the deny list');

    // Member/token cannot remove.
    assert.equal(
      (await req(h, 'DELETE', `/federation/peers/${peers[0]!.id}`, asMember(h))).status,
      403,
    );
    assert.equal(listPeers(h.db).length, 1, 'peer not removed by member');

    // Admin removes → tombstoned (gone from live list).
    const del = await req(h, 'DELETE', `/federation/peers/${peers[0]!.id}`, asAdmin(h));
    assert.equal(del.status, 200);
    assert.equal(listPeers(h.db).length, 0, 'peer removed');
  });

  test('admin adds a deny-list peer via list_type; it lands on config.deny only', async () => {
    const h = makeHarness();
    const add = await req(h, 'POST', '/federation/peers', asAdmin(h), {
      base_url: 'blocked',
      subdomain: 'blocked',
      label: 'Blocked Corp',
      list_type: 'deny',
    });
    assert.equal(add.status, 200);
    const peer = ((await add.json()) as { peer: { list_type: string } }).peer;
    assert.equal(peer.list_type, 'deny', 'REST persists list_type=deny');

    const cfg = (await (await req(h, 'GET', '/federation/config', asAdmin(h))).json()) as {
      allow: { id: string }[];
      deny: { id: string; subdomain: string }[];
    };
    assert.equal(cfg.allow.length, 0, 'not on the allow list');
    assert.equal(cfg.deny.length, 1, 'on the deny list');
    assert.equal(cfg.deny[0]!.subdomain, 'blocked');
  });
});

// ─── links list + revoke ────────────────────────────────────────────────────────

describe('federation Phase 4 — links list + revoke', () => {
  function seedLink(h: Harness): { linkId: string; rootId: string } {
    const root = createItem(h.db, h.deviceId, {
      type: 'project',
      parentId: null,
      ownerId: h.admin.id,
      title: 'Roadmap',
    });
    const link = createLink(h.db, {
      peerBaseUrl: 'globex',
      peerLabel: 'globex',
      direction: 'outbound',
      status: 'active',
    });
    addLinkRoot(h.db, link.id, root.id, 'write');
    return { linkId: link.id, rootId: root.id };
  }

  test('GET /links returns links with granted-root titles (session); token 403', async () => {
    const h = makeHarness();
    const { linkId, rootId } = seedLink(h);

    // Token cannot read the session route.
    assert.equal((await req(h, 'GET', '/federation/links', asToken(h))).status, 403);

    const res = await req(h, 'GET', '/federation/links', asMember(h));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      links: {
        id: string;
        direction: string;
        status: string;
        peer_label: string;
        roots: { root_item_id: string; permission: string; title: string | null }[];
      }[];
    };
    assert.equal(body.links.length, 1);
    const link = body.links[0]!;
    assert.equal(link.id, linkId);
    assert.equal(link.direction, 'outbound');
    assert.equal(link.status, 'active');
    assert.equal(link.peer_label, 'globex');
    assert.equal(link.roots.length, 1);
    assert.equal(link.roots[0]!.root_item_id, rootId);
    assert.equal(link.roots[0]!.permission, 'write');
    assert.equal(link.roots[0]!.title, 'Roadmap', 'granted-root item title resolved');
  });

  test('POST /links/:id/revoke flips status to revoked (admin); member/token 403; 404 unknown', async () => {
    const h = makeHarness();
    const { linkId } = seedLink(h);

    // Member and token cannot revoke.
    assert.equal((await req(h, 'POST', `/federation/links/${linkId}/revoke`, asMember(h))).status, 403);
    assert.equal((await req(h, 'POST', `/federation/links/${linkId}/revoke`, asToken(h))).status, 403);
    assert.equal(getLink(h.db, linkId)!.status, 'active', 'unchanged by rejected callers');

    // Unknown id → 404.
    assert.equal(
      (await req(h, 'POST', '/federation/links/does-not-exist/revoke', asAdmin(h))).status,
      404,
    );

    // Admin revokes → status flips.
    const ok = await req(h, 'POST', `/federation/links/${linkId}/revoke`, asAdmin(h));
    assert.equal(ok.status, 200);
    assert.equal(getLink(h.db, linkId)!.status, 'revoked', 'link revoked in storage');
  });
});
