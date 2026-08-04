import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  hashPassword,
  verifyPassword,
  sha256Hex,
  createToken,
  listTokens,
  revokeToken,
  revokeAllTokens,
  createSession,
  revokeSession,
  revokeAllSessions,
  publicUser,
  requireAdmin,
  setPassword,
  basicAuth,
  LOGIN_FAIL_MAX,
  LOGIN_FAIL_IP_MAX,
  LOGIN_FAIL_WINDOW_MS,
  type AuthVars,
} from './auth';
import { CARBON_REAL_IP_HEADER } from './client-ip';
import {
  createUser,
  getUser,
  getUserByUsername,
  listUsers,
  updateUser,
  softDeleteUser,
} from '@carbon/core';
import { makeTestDb, makeHono, appFetch } from './test-app';
import { Hono } from 'hono';

// ─── pure crypto functions ───────────────────────────────────────────────────

describe('hashPassword / verifyPassword', () => {
  test('scrypt hash verifies correctly', () => {
    const h = hashPassword('secret');
    assert.ok(h.startsWith('scrypt$'), 'uses scrypt format');
    assert.ok(verifyPassword(h, 'secret'));
    assert.ok(!verifyPassword(h, 'wrong'));
  });

  test('two hashes of the same password differ (salted)', () => {
    const h1 = hashPassword('abc');
    const h2 = hashPassword('abc');
    assert.notEqual(h1, h2);
  });

  test('legacy sha256-hex hash still verifies', () => {
    const h = sha256Hex('legacy');
    assert.ok(verifyPassword(h, 'legacy'));
    assert.ok(!verifyPassword(h, 'not-legacy'));
  });
});

// ─── API tokens ──────────────────────────────────────────────────────────────

describe('API tokens', () => {
  test('createToken / listTokens / revokeToken lifecycle', () => {
    const { db, addUser } = makeTestDb();
    const { id: userId } = addUser('alice', 'pw', 'admin');

    const { token, row } = createToken(db, { userId, name: 'test', scopes: ['tasks:read'] });
    assert.ok(token.startsWith('carbon_'), 'token has prefix');
    assert.equal(row.name, 'test');
    assert.deepEqual(row.scopes, ['tasks:read']);

    const list = listTokens(db);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, row.id);

    revokeToken(db, row.id);
    assert.equal(listTokens(db).length, 0);
  });

  test('revokeAllTokens revokes every token for that user only', () => {
    const { db, addUser } = makeTestDb();
    const alice = addUser('alice', 'pw', 'admin');
    const bob = addUser('bob', 'pw', 'member');
    createToken(db, { userId: alice.id, name: 'a1', scopes: ['tasks:read'] });
    createToken(db, { userId: alice.id, name: 'a2', scopes: ['tasks:write'] });
    createToken(db, { userId: bob.id, name: 'b1', scopes: ['tasks:read'] });
    assert.equal(revokeAllTokens(db, alice.id), 2);
    assert.equal(listTokens(db).length, 1);
    assert.equal(listTokens(db)[0]!.user_id, bob.id);
  });
});

// ─── sessions ────────────────────────────────────────────────────────────────

describe('sessions', () => {
  test('createSession / revokeSession lifecycle', () => {
    const { db, addUser } = makeTestDb();
    const { id: userId } = addUser('bob', 'pw');
    const secret = createSession(db, userId);
    assert.ok(secret.startsWith('carbons_'));
    revokeSession(db, secret);
    // After revocation, reusing the token should fail — verified indirectly below via HTTP
  });
});

// ─── HTTP routes ─────────────────────────────────────────────────────────────

function buildApp(allowOpen = false) {
  const ctx = makeTestDb();
  const { db, addUser } = ctx;
  const admin = addUser('admin', 'pass', 'admin');
  const member = addUser('member', 'pass', 'member');

  const app = makeHono(db, allowOpen);

  app.get('/me', (c) => {
    const id = c.get('userId');
    const user = getUser(db, id);
    if (!user) return c.json({ id, username: c.get('username'), role: c.get('role') });
    return c.json({ ...publicUser(user) });
  });

  app.post('/login', (c) => {
    const method = c.get('authMethod');
    if (method === 'open') return c.json({ open: true });
    if (method !== 'basic') return c.json({ error: 'password auth required' }, 400);
    const id = c.get('userId');
    const user = getUser(db, id);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ token: createSession(db, id), user: publicUser(user) });
  });

  app.post('/logout', (c) => {
    const header = c.req.header('Authorization');
    if (header?.startsWith('Bearer ')) revokeSession(db, header.slice(7).trim());
    return c.json({ ok: true });
  });

  app.get('/users', (c) => c.json({ users: listUsers(db).map(publicUser) }));

  app.post('/admin/users', requireAdmin, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      role?: 'admin' | 'member';
    };
    if (!body.username || !body.password)
      return c.json({ error: 'username and password required' }, 400);
    if (getUserByUsername(db, body.username))
      return c.json({ error: 'username already exists' }, 409);
    const user = createUser(db, {
      username: body.username,
      displayName: body.username,
      role: body.role ?? 'member',
    });
    setPassword(db, user.id, hashPassword(body.password));
    return c.json(publicUser(user), 201);
  });

  app.delete('/admin/users/:id', requireAdmin, (c) => {
    const id = c.req.param('id');
    if (id === c.get('userId')) return c.json({ error: 'cannot delete yourself' }, 400);
    const target = getUser(db, id);
    if (!target) return c.json({ error: 'not found' }, 404);
    if (target.role === 'admin') {
      const admins = listUsers(db).filter((u) => u.role === 'admin' && !u.deleted).length;
      if (admins <= 1) return c.json({ error: 'cannot delete the last admin' }, 400);
    }
    softDeleteUser(db, id);
    revokeAllSessions(db, id);
    revokeAllTokens(db, id);
    return c.json({ ok: true });
  });

  app.patch('/admin/users/:id', requireAdmin, async (c) => {
    const id = c.req.param('id');
    if (!getUser(db, id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { password?: string; role?: 'admin' | 'member' };
    if (body.role !== undefined) updateUser(db, id, { role: body.role });
    if (body.password) {
      setPassword(db, id, hashPassword(body.password));
      revokeAllSessions(db, id);
    }
    return c.json(publicUser(getUser(db, id)!));
  });

  return { app, db, admin, member, addUser };
}

describe('GET /me', () => {
  test('returns 401 without credentials', async () => {
    const { app } = buildApp();
    const res = await appFetch(app, '/me');
    assert.equal(res.status, 401);
  });

  test('returns current user with valid Basic auth (test harness allows Basic)', async () => {
    const { app, admin } = buildApp();
    const res = await appFetch(app, '/me', { headers: { Authorization: admin.basic } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { username: string };
    assert.equal(body.username, 'admin');
  });

  test('production posture: Basic on /me is rejected when basicPaths is /login only', async () => {
    const { db, addUser } = makeTestDb();
    const admin = addUser('admin2', 'pass', 'admin');
    const app = new Hono<{ Variables: AuthVars }>();
    app.use('*', basicAuth(db, { allowOpen: false, basicPaths: ['/login'] }));
    app.get('/me', (c) => c.json({ username: c.get('username') }));
    const res = await appFetch(app, '/me', { headers: { Authorization: admin.basic } });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /session required/);
  });

  test('returns current user with Bearer session token', async () => {
    const { app, member } = buildApp();
    const res = await appFetch(app, '/me', {
      headers: { Authorization: `Bearer ${member.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { username: string };
    assert.equal(body.username, 'member');
  });
});

describe('POST /login', () => {
  test('returns session token for valid Basic auth', async () => {
    const { app, admin } = buildApp();
    const res = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: admin.basic } });
    assert.equal(res.status, 200);
    const body = await res.json() as { token: string; user: { username: string } };
    assert.ok(body.token.startsWith('carbons_'));
    assert.equal(body.user.username, 'admin');
  });

  test('returns 401 with wrong password', async () => {
    const { app } = buildApp();
    const bad = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
    const res = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: bad } });
    assert.equal(res.status, 401);
  });
});

describe('basic-auth brute-force throttle', () => {
  // The throttle is module-level but partitioned per tenant DB, so each test still
  // uses its own never-reused username to avoid sharing buckets inside one DB.

  test('locks out after LOGIN_FAIL_MAX failures against the same username', async () => {
    const { app, addUser } = buildApp();
    addUser('throttle-lockout', 'correct-pw');
    const bad = 'Basic ' + Buffer.from('throttle-lockout:wrong').toString('base64');

    for (let i = 0; i < LOGIN_FAIL_MAX; i++) {
      const res = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: bad } });
      assert.equal(res.status, 401, `attempt ${i + 1} should be a plain 401`);
    }
    // The next attempt is throttled, even with the *correct* password now.
    const good = 'Basic ' + Buffer.from('throttle-lockout:correct-pw').toString('base64');
    const res = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: good } });
    assert.equal(res.status, 429);
    const body = await res.json() as { error: string };
    assert.match(body.error, /too many attempts/);
  });

  test('unknown usernames are throttled the same as wrong passwords (no oracle)', async () => {
    const { app } = buildApp();
    const bad = 'Basic ' + Buffer.from('throttle-unknown-user:whatever').toString('base64');

    for (let i = 0; i < LOGIN_FAIL_MAX; i++) {
      const res = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: bad } });
      assert.equal(res.status, 401);
    }
    const res = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: bad } });
    assert.equal(res.status, 429);
  });

  test('same username in a different tenant DB has its own throttle bucket', async () => {
    const tenantA = buildApp();
    const tenantB = buildApp();
    tenantA.addUser('shared-throttle-name', 'a-correct-pw');
    const bUser = tenantB.addUser('shared-throttle-name', 'b-correct-pw');
    const badA = 'Basic ' + Buffer.from('shared-throttle-name:wrong').toString('base64');

    for (let i = 0; i < LOGIN_FAIL_MAX; i++) {
      const res = await appFetch(tenantA.app, '/login', {
        method: 'POST',
        headers: { Authorization: badA },
      });
      assert.equal(res.status, 401);
    }
    assert.equal(
      (
        await appFetch(tenantA.app, '/login', { method: 'POST', headers: { Authorization: badA } })
      ).status,
      429,
      'tenant A should now be locked out',
    );

    const res = await appFetch(tenantB.app, '/login', {
      method: 'POST',
      headers: { Authorization: bUser.basic },
    });
    assert.equal(res.status, 200, 'tenant B should not inherit tenant A failures');
  });

  test('a successful auth resets the failure counter', async () => {
    const { app, addUser } = buildApp();
    const user = addUser('throttle-reset', 'correct-pw');
    const bad = 'Basic ' + Buffer.from('throttle-reset:wrong').toString('base64');

    for (let i = 0; i < LOGIN_FAIL_MAX - 1; i++) {
      const res = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: bad } });
      assert.equal(res.status, 401);
    }
    // One failure short of the cap — a correct login should still succeed and clear it.
    const okRes = await appFetch(app, '/login', {
      method: 'POST',
      headers: { Authorization: user.basic },
    });
    assert.equal(okRes.status, 200);

    // Counter reset: another full run of failures is needed before lockout kicks in.
    for (let i = 0; i < LOGIN_FAIL_MAX; i++) {
      const res = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: bad } });
      assert.equal(res.status, 401, `post-reset attempt ${i + 1} should not be throttled yet`);
    }
    const lockedRes = await appFetch(app, '/login', {
      method: 'POST',
      headers: { Authorization: bad },
    });
    assert.equal(lockedRes.status, 429);
  });

  test('lockout expires after the sliding window elapses', async (t) => {
    const { app } = buildApp();
    const bad = 'Basic ' + Buffer.from('throttle-expiry:wrong').toString('base64');

    t.mock.timers.enable({ apis: ['Date'] });
    try {
      for (let i = 0; i < LOGIN_FAIL_MAX; i++) {
        const res = await appFetch(app, '/login', {
          method: 'POST',
          headers: { Authorization: bad },
        });
        assert.equal(res.status, 401);
      }
      const lockedRes = await appFetch(app, '/login', {
        method: 'POST',
        headers: { Authorization: bad },
      });
      assert.equal(lockedRes.status, 429);

      // Jump past the window — the oldest failures should have aged out.
      t.mock.timers.tick(LOGIN_FAIL_WINDOW_MS + 1_000);

      const afterWindowRes = await appFetch(app, '/login', {
        method: 'POST',
        headers: { Authorization: bad },
      });
      assert.equal(afterWindowRes.status, 401, 'throttle should have reset after the window');
    } finally {
      t.mock.timers.reset();
    }
  });

  test('per-IP budget locks out across different usernames', async () => {
    const { app } = buildApp();
    const ip = '203.0.113.77';
    // Burn the IP budget with distinct unknown usernames (username buckets stay under cap).
    for (let i = 0; i < LOGIN_FAIL_IP_MAX; i++) {
      const bad =
        'Basic ' + Buffer.from(`ip-throttle-user-${i}:wrong`).toString('base64');
      const res = await appFetch(app, '/login', {
        method: 'POST',
        headers: { Authorization: bad, [CARBON_REAL_IP_HEADER]: ip },
      });
      assert.equal(res.status, 401, `attempt ${i + 1}`);
    }
    const next =
      'Basic ' + Buffer.from('ip-throttle-fresh:wrong').toString('base64');
    const res = await appFetch(app, '/login', {
      method: 'POST',
      headers: { Authorization: next, [CARBON_REAL_IP_HEADER]: ip },
    });
    assert.equal(res.status, 429);
  });
});

describe('open mode default deny', () => {
  test('empty tenant rejects unauthenticated requests unless allowOpen', async () => {
    const { db } = makeTestDb();
    const closed = new Hono<{ Variables: AuthVars }>();
    closed.use('*', basicAuth(db)); // default allowOpen=false
    closed.get('/me', (c) => c.json({ id: c.get('userId') }));
    assert.equal((await appFetch(closed, '/me')).status, 401);

    const open = new Hono<{ Variables: AuthVars }>();
    open.use('*', basicAuth(db, { allowOpen: true, basicPaths: null }));
    open.get('/me', (c) => c.json({ id: c.get('userId') }));
    const res = await appFetch(open, '/me');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { id: string }).id, 'local');
  });
});

describe('POST /logout', () => {
  test('revokes session token', async () => {
    const { app, admin } = buildApp();
    // /login to get a fresh token
    const loginRes = await appFetch(app, '/login', { method: 'POST', headers: { Authorization: admin.basic } });
    const { token } = await loginRes.json() as { token: string };

    // logout
    await appFetch(app, '/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    // using the revoked token now returns 401
    const meRes = await appFetch(app, '/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(meRes.status, 401);
  });
});

describe('POST /admin/users', () => {
  test('admin can create a new user', async () => {
    const { app, admin } = buildApp();
    const res = await appFetch(app, '/admin/users', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${admin.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'newbie', password: 'pw123' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { username: string };
    assert.equal(body.username, 'newbie');
  });

  test('member is forbidden from creating users', async () => {
    const { app, member } = buildApp();
    const res = await appFetch(app, '/admin/users', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${member.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'x', password: 'pw' }),
    });
    assert.equal(res.status, 403);
  });

  test('duplicate username returns 409', async () => {
    const { app, admin } = buildApp();
    // admin already exists
    const res = await appFetch(app, '/admin/users', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${admin.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'admin', password: 'pw' }),
    });
    assert.equal(res.status, 409);
  });

  test('missing password returns 400', async () => {
    const { app, admin } = buildApp();
    const res = await appFetch(app, '/admin/users', {
      method: 'POST',
      headers: { Authorization: admin.basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nopw' }),
    });
    assert.equal(res.status, 400);
  });
});

describe('DELETE /admin/users/:id', () => {
  test('admin can delete a member', async () => {
    const { app, admin, member } = buildApp();
    const res = await appFetch(app, `/admin/users/${member.id}`, {
      method: 'DELETE',
      headers: { Authorization: admin.basic },
    });
    assert.equal(res.status, 200);
  });

  test('admin cannot delete themselves', async () => {
    const { app, admin } = buildApp();
    const res = await appFetch(app, `/admin/users/${admin.id}`, {
      method: 'DELETE',
      headers: { Authorization: admin.basic },
    });
    assert.equal(res.status, 400);
  });

  test('cannot delete the last admin', async () => {
    const { app, admin, member } = buildApp();
    // delete the member first so only admin remains
    await appFetch(app, `/admin/users/${member.id}`, {
      method: 'DELETE',
      headers: { Authorization: admin.basic },
    });
    // now try a second admin-promoted user... actually, admin IS the only admin
    // Try deleting from a different user perspective to hit the last-admin guard
    const ctx2 = makeTestDb();
    const admin2 = ctx2.addUser('a2', 'pw', 'admin');
    const admin3 = ctx2.addUser('a3', 'pw', 'admin');
    const app2 = makeHono(ctx2.db);
    app2.delete('/admin/users/:id', requireAdmin, (c) => {
      const id = c.req.param('id');
      const target = getUser(ctx2.db, id);
      if (!target) return c.json({ error: 'not found' }, 404);
      if (target.role === 'admin') {
        const admins = listUsers(ctx2.db).filter((u) => u.role === 'admin' && !u.deleted).length;
        if (admins <= 1) return c.json({ error: 'cannot delete the last admin' }, 400);
      }
      softDeleteUser(ctx2.db, id);
      revokeAllSessions(ctx2.db, id);
      revokeAllTokens(ctx2.db, id);
      return c.json({ ok: true });
    });
    // delete a3 first → 2 admins left
    await appFetch(app2, `/admin/users/${admin3.id}`, { method: 'DELETE', headers: { Authorization: admin2.basic } });
    // now only admin2 — deleting them should be blocked
    const res = await appFetch(app2, `/admin/users/${admin2.id}`, {
      method: 'DELETE',
      headers: { Authorization: admin2.basic },
    });
    // hits "cannot delete yourself" first, which is also 400
    assert.equal(res.status, 400);
  });

  test('soft-delete revokes sessions and API tokens; lingering creds cannot auth', async () => {
    const { app, db, admin, addUser } = buildApp();
    const victim = addUser('victim', 'pass', 'member');
    const session = createSession(db, victim.id);
    const { token } = createToken(db, { userId: victim.id, name: 'ha', scopes: ['tasks:read'] });

    const del = await appFetch(app, `/admin/users/${victim.id}`, {
      method: 'DELETE',
      headers: { Authorization: admin.basic },
    });
    assert.equal(del.status, 200);
    assert.equal(getUser(db, victim.id), undefined, 'getUser hides soft-deleted users');
    assert.equal(listTokens(db).filter((t) => t.user_id === victim.id).length, 0);

    const viaSession = await appFetch(app, '/me', {
      headers: { Authorization: `Bearer ${session}` },
    });
    assert.equal(viaSession.status, 401);

    const viaToken = await appFetch(app, '/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(viaToken.status, 401);

    const viaBasic = await appFetch(app, '/me', {
      headers: { Authorization: victim.basic },
    });
    assert.equal(viaBasic.status, 401);
  });

  test('admin password reset revokes existing sessions', async () => {
    const { app, db, admin, member } = buildApp();
    const session = createSession(db, member.id);
    const before = await appFetch(app, '/me', {
      headers: { Authorization: `Bearer ${session}` },
    });
    assert.equal(before.status, 200);

    const patch = await appFetch(app, `/admin/users/${member.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: admin.basic,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: 'brand-new-secret' }),
    });
    assert.equal(patch.status, 200);

    const after = await appFetch(app, '/me', {
      headers: { Authorization: `Bearer ${session}` },
    });
    assert.equal(after.status, 401, 'old session invalidated after password reset');
  });
});

describe('GET /users', () => {
  test('any authenticated user can list users', async () => {
    const { app, member } = buildApp();
    const res = await appFetch(app, '/users', { headers: { Authorization: member.basic } });
    assert.equal(res.status, 200);
    const body = await res.json() as { users: Array<{ username: string }> };
    assert.ok(body.users.some((u) => u.username === 'admin'));
    assert.ok(body.users.some((u) => u.username === 'member'));
  });
});
