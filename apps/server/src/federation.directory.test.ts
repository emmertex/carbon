/**
 * Federation same-host (L2) user discovery: `GET /api/federation/directory` and
 * `GET /api/federation/peer-status`. Two same-host tenants A (alice) and B (bob),
 * each with a real `api` app (basicAuth + requireSession) and the config routes wired
 * with an in-process `sameHostPeer` that reads the OTHER tenant's whitelist + roster —
 * the same registry-backed capability index.ts threads in production, minus the network.
 *
 * The gate proven here: discovery is allowed ONLY when the two workspaces have MUTUALLY
 * whitelisted each other (and the host ceiling + policy permit intra-server). Otherwise a
 * uniform 403 that never leaks whether the peer exists. A dotted/remote peer gets an
 * explicit cross-server-unavailable error (L3 discovery is designed separately).
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  createUser as coreCreateUser,
  listUsers,
  upsertUser,
  migrate,
  ensureDeviceId,
  getUser,
  type Db,
  type User,
} from '@carbon/core';
import { openDb } from './sqlite';
import {
  ensureServerTables,
  basicAuth,
  hashPassword,
  setPassword,
  createSession,
  createToken,
  publicUser,
  type AuthVars,
} from './auth';
import { ensureNoticeTables } from './notices';
import {
  ensureFederationTables,
  ensureGovernanceTables,
  registerFederationConfigRoutes,
  addPeer,
  setFederationPolicy,
  listPeers,
  type FederationMode,
  type FederationPolicy,
  type SameHostPeer,
} from './federation';

// ─── a two-tenant, same-host world with cross-tenant in-process peer access ─────

type Env = { Variables: AuthVars };

interface Tenant {
  label: string;
  db: Db;
  deviceId: string;
  app: Hono<Env>;
  mode: FederationMode;
  addUser(username: string, role?: 'admin' | 'member'): { id: string; token: string };
  addApiToken(userId: string): string;
}

/** Build a world of same-host tenants keyed by subdomain label. `sameHostPeer(label)`
 *  resolves to the OTHER tenant's whitelist + roster (registry-backed in production). */
function makeWorld(mode: () => Record<string, FederationMode>) {
  const tenants = new Map<string, Tenant>();

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

  // In-process peer access: read the peer tenant's whitelist + roster directly (the
  // registry.getCtx(peer)?.db path in index.ts, minus the network hop).
  const sameHostPeer = (peerSubdomain: string): SameHostPeer | null => {
    const peer = tenants.get(peerSubdomain);
    if (!peer) return null;
    return {
      hasWhitelisted: (myBaseUrl, myLabel) =>
        listPeers(peer.db).some(
          (p) =>
            p.subdomain === myLabel ||
            p.subdomain === myBaseUrl ||
            p.base_url === myBaseUrl ||
            p.base_url === myLabel,
        ),
      roster: () =>
        listUsers(peer.db)
          .filter((u) => !u.is_bot && !u.is_remote)
          .map(publicUser),
    };
  };

  function makeTenant(label: string): Tenant {
    const db = openDb(':memory:');
    migrate(db);
    ensureServerTables(db);
    ensureNoticeTables(db);
    ensureFederationTables(db);
    ensureGovernanceTables(db);
    const deviceId = ensureDeviceId(db);

    const app = new Hono<Env>();
    app.use('/api/*', basicAuth(db, false));
    const api = new Hono<Env>();
    registerFederationConfigRoutes(api, {
      db,
      resolveMode: () => mode()[label] ?? 'off',
      sessionAuth: requireSession,
      adminAuth: requireAdmin,
      myLabel: label,
      sameHostPeer,
    });
    app.route('/api', api);

    const t: Tenant = {
      label,
      db,
      deviceId,
      app,
      mode: 'intra_server',
      addUser(username, role = 'member') {
        const u = coreCreateUser(db, { username, displayName: username, role });
        setPassword(db, u.id, hashPassword('pw'));
        return { id: u.id, token: createSession(db, u.id) };
      },
      addApiToken(userId) {
        return createToken(db, { userId, name: 't', scopes: ['read', 'write'] }).token;
      },
    };
    tenants.set(label, t);
    return t;
  }

  return { tenants, makeTenant };
}

/** Add a bot user to a tenant (excluded from the roster). */
function addBot(t: Tenant, username: string): string {
  const u = coreCreateUser(t.db, { username, displayName: username, role: 'member' });
  const bot: User = { ...getUser(t.db, u.id)!, is_bot: true };
  upsertUser(t.db, bot);
  return u.id;
}

/** Add a shadow (is_remote) user to a tenant (excluded from the roster). */
function addShadow(t: Tenant, homeServer: string, remoteId: string): string {
  const id = `remote:${homeServer}:${remoteId}`;
  const now = new Date().toISOString();
  const shadow: User = {
    id,
    username: `${remoteId}@${homeServer}`,
    display_name: `Shadow ${remoteId}`,
    role: 'member',
    is_bot: false,
    avatar_color: null,
    avatar_initial: null,
    plan_startup_min: null,
    plan_default_estimate_min: null,
    is_remote: true,
    home_server: homeServer,
    created_at: now,
    updated_at: now,
    deleted: false,
  };
  upsertUser(t.db, shadow);
  return id;
}

function directory(t: Tenant, token: string, peer: string): Promise<Response> {
  return Promise.resolve(
    t.app.fetch(
      new Request(
        `http://${t.label}.test/api/federation/directory?peer=${encodeURIComponent(peer)}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    ),
  );
}

function peerStatus(t: Tenant, token: string, peer: string): Promise<Response> {
  return Promise.resolve(
    t.app.fetch(
      new Request(
        `http://${t.label}.test/api/federation/peer-status?peer=${encodeURIComponent(peer)}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    ),
  );
}

/** Stand up A (alice) + B (bob) with the given whitelist wiring and policies. */
function setup(opts: {
  aWhitelistsB?: boolean;
  bWhitelistsA?: boolean;
  /** A puts B on its DENY list (deny wins over mutual whitelist for A's discovery). */
  aDeniesB?: boolean;
  aPolicy?: FederationPolicy;
  bPolicy?: FederationPolicy;
  modes?: Record<string, FederationMode>;
}) {
  const modes = opts.modes ?? { A: 'intra_server', B: 'intra_server' };
  const world = makeWorld(() => modes);
  const A = world.makeTenant('A');
  const B = world.makeTenant('B');
  setFederationPolicy(A.db, opts.aPolicy ?? 'user_open');
  setFederationPolicy(B.db, opts.bPolicy ?? 'user_open');
  const alice = A.addUser('alice', 'admin');
  const bob = B.addUser('bob', 'admin');
  if (opts.aWhitelistsB) addPeer(A.db, { baseUrl: 'B', subdomain: 'B', label: 'B' });
  if (opts.bWhitelistsA) addPeer(B.db, { baseUrl: 'A', subdomain: 'A', label: 'A' });
  if (opts.aDeniesB) addPeer(A.db, { baseUrl: 'B', subdomain: 'B', label: 'B', listType: 'deny' });
  return { world, A, B, alice, bob };
}

// ─── 1. neither whitelists → 403 ───────────────────────────────────────────────

describe('federation directory — L2 mutual-whitelist discovery', () => {
  test('1. neither whitelists the other → directory is 403 (no roster)', async () => {
    const { A, alice } = setup({ aWhitelistsB: false, bWhitelistsA: false });
    const res = await directory(A, alice.token, 'B');
    assert.equal(res.status, 403);
    const body = (await res.json()) as { users?: unknown };
    assert.equal(body.users, undefined, 'no roster leaked');
  });

  // ─── 2. one-sided → 403 ──────────────────────────────────────────────────────

  test('2. only A whitelists B (one-sided) → still 403', async () => {
    const { A, alice } = setup({ aWhitelistsB: true, bWhitelistsA: false });
    const res = await directory(A, alice.token, 'B');
    assert.equal(res.status, 403, 'mutuality required — a one-sided whitelist is not enough');
    const body = (await res.json()) as { users?: unknown };
    assert.equal(body.users, undefined);
  });

  test('2b. only B whitelists A (other side) → still 403', async () => {
    const { A, alice } = setup({ aWhitelistsB: false, bWhitelistsA: true });
    assert.equal((await directory(A, alice.token, 'B')).status, 403);
  });

  // ─── 3. mutual → A gets B's roster; bots + shadows excluded; addressable form ──

  test('3. both whitelist → A gets B roster incl. bob + address; bot + shadow excluded', async () => {
    const { A, B, alice, bob } = setup({ aWhitelistsB: true, bWhitelistsA: true });
    const botId = addBot(B, 'b-bot');
    const shadowId = addShadow(B, 'A', 'someone');

    const res = await directory(A, alice.token, 'B');
    const body = (await res.json()) as {
      users: { id: string; username: string; display_name: string | null; address: string }[];
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    const bobRow = body.users.find((u) => u.id === bob.id);
    assert.ok(bobRow, "B's roster includes bob");
    assert.equal(bobRow!.username, 'bob');
    assert.equal(bobRow!.display_name, 'bob');
    assert.equal(bobRow!.address, 'bob@B', 'addressable <user>@<peer> form included');
    assert.ok(!body.users.some((u) => u.id === botId), 'bot excluded');
    assert.ok(!body.users.some((u) => u.id === shadowId), 'shadow (is_remote) excluded');
  });

  // ─── 4. workspace_only → 403 even when mutual ────────────────────────────────

  test('4. A policy workspace_only → 403 even with mutual whitelist', async () => {
    const { A, alice } = setup({
      aWhitelistsB: true,
      bWhitelistsA: true,
      aPolicy: 'workspace_only',
    });
    const res = await directory(A, alice.token, 'B');
    assert.equal(res.status, 403, 'a workspace_only workspace does no discovery');
    const body = (await res.json()) as { users?: unknown };
    assert.equal(body.users, undefined);
  });

  // ─── 5. host ceiling off → 403 even when mutual ──────────────────────────────

  test('5. host ceiling off → 403 even with mutual whitelist', async () => {
    const { A, alice } = setup({
      aWhitelistsB: true,
      bWhitelistsA: true,
      modes: { A: 'off', B: 'intra_server' },
    });
    const res = await directory(A, alice.token, 'B');
    assert.equal(res.status, 403, 'off ceiling blocks all discovery');
  });

  // ─── 6. dotted/remote peer → cross-server unavailable (not a roster) ──────────

  test('6. dotted/remote peer → cross_server_discovery_unavailable, not a roster', async () => {
    const { A, alice } = setup({ aWhitelistsB: true, bWhitelistsA: true });
    const res = await directory(A, alice.token, 'peer.example.com');
    assert.notEqual(res.status, 200);
    const body = (await res.json()) as { error?: string; users?: unknown };
    assert.equal(body.error, 'cross_server_discovery_unavailable');
    assert.equal(body.users, undefined, 'no roster for a remote peer');
  });

  // ─── 7. peer-status reflects mutuality only in the mutual case ───────────────

  test('7. peer-status { mutual:true } only when mutual', async () => {
    // Mutual.
    {
      const { A, alice } = setup({ aWhitelistsB: true, bWhitelistsA: true });
      const body = (await (await peerStatus(A, alice.token, 'B')).json()) as {
        mutual: boolean;
        sameHost: boolean;
      };
      assert.equal(body.mutual, true);
      assert.equal(body.sameHost, true);
    }
    // One-sided → sameHost true (B is a live tenant) but not mutual.
    {
      const { A, alice } = setup({ aWhitelistsB: true, bWhitelistsA: false });
      const body = (await (await peerStatus(A, alice.token, 'B')).json()) as {
        mutual: boolean;
        sameHost: boolean;
      };
      assert.equal(body.mutual, false);
      assert.equal(body.sameHost, true);
    }
    // Remote peer → neither.
    {
      const { A, alice } = setup({ aWhitelistsB: true, bWhitelistsA: true });
      const body = (await (await peerStatus(A, alice.token, 'peer.example.com')).json()) as {
        mutual: boolean;
        sameHost: boolean;
      };
      assert.equal(body.mutual, false);
      assert.equal(body.sameHost, false);
    }
  });

  // ─── 8. token auth → 403 (session only) ──────────────────────────────────────

  test('8. token auth → 403 on both directory and peer-status', async () => {
    const { A, alice } = setup({ aWhitelistsB: true, bWhitelistsA: true });
    const apiToken = A.addApiToken(alice.id);
    assert.equal((await directory(A, apiToken, 'B')).status, 403, 'directory rejects token');
    assert.equal((await peerStatus(A, apiToken, 'B')).status, 403, 'peer-status rejects token');
  });

  // ─── 9. deny wins: a denied peer is not discoverable even when mutually whitelisted ─

  test('9. A denies B → directory 403 + peer-status mutual:false, even though mutual', async () => {
    // Fully mutual (both whitelist each other) so ONLY the deny can block discovery.
    const { A, alice } = setup({ aWhitelistsB: true, bWhitelistsA: true, aDeniesB: true });

    const dir = await directory(A, alice.token, 'B');
    assert.equal(dir.status, 403, 'a denied peer is not discoverable (deny wins over mutual)');
    const dirBody = (await dir.json()) as { users?: unknown };
    assert.equal(dirBody.users, undefined, 'no roster leaked for a denied peer');

    const stat = (await (await peerStatus(A, alice.token, 'B')).json()) as {
      mutual: boolean;
      sameHost: boolean;
    };
    assert.equal(stat.mutual, false, 'peer-status reports not-mutual for a denied peer');
    assert.equal(stat.sameHost, true, 'B is still a live same-host tenant');
  });
});
