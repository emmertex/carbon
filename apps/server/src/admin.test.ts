import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';
import {
  requireAdmin,
  listTokens,
  createToken,
  revokeToken,
} from './auth';
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  recordAgentUsage,
} from './agents';
import { getUserByUsername } from '@carbon/core';

function buildAdminApp(db: TestDb) {
  const app = makeHono(db, false); // require auth

  // ── tokens ──────────────────────────────────────────────────────────────────
  app.get('/admin/tokens', requireAdmin, (c) => c.json({ tokens: listTokens(db) }));

  app.post('/admin/tokens', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      scopes?: string[];
      userId?: string;
    };
    if (!b.name) return c.json({ error: 'name required' }, 400);
    const scopes =
      Array.isArray(b.scopes) && b.scopes.length
        ? b.scopes
        : ['tasks:read', 'tasks:write', 'inbox:write'];
    const result = createToken(db, { userId: b.userId || c.get('userId'), name: b.name, scopes });
    return c.json({ token: result.token, ...result.row }, 201);
  });

  app.delete('/admin/tokens/:id', requireAdmin, (c) => {
    revokeToken(db, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── agents ───────────────────────────────────────────────────────────────────
  app.get('/admin/agents', requireAdmin, (c) => c.json({ agents: listAgents(db) }));

  app.post('/admin/agents', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      username?: string;
      kind?: 'openai' | 'anthropic' | 'webhook';
      endpoint?: string;
      apiKey?: string;
      model?: string;
      systemPrompt?: string;
    };
    if (!b.name || !b.username || !b.kind) {
      return c.json({ error: 'name, username, kind required' }, 400);
    }
    if (getUserByUsername(db, b.username)) return c.json({ error: 'username already exists' }, 409);
    const agent = createAgent(db, {
      name: b.name,
      username: b.username,
      kind: b.kind,
      endpoint: b.endpoint,
      apiKey: b.apiKey,
      model: b.model,
      systemPrompt: b.systemPrompt,
    });
    let token: string | undefined;
    if (b.kind === 'webhook') {
      token = createToken(db, {
        userId: agent.user_id,
        name: `${b.name} (agent)`,
        scopes: ['tasks:read', 'tasks:write', 'inbox:write'],
      }).token;
    }
    return c.json({ ...agent, token }, 201);
  });

  app.patch('/admin/agents/:id', requireAdmin, async (c) => {
    const id = c.req.param('id');
    if (!getAgent(db, id)) return c.json({ error: 'not found' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    updateAgent(db, id, b);
    return c.json(listAgents(db).find((a) => a.id === id) ?? {});
  });

  app.delete('/admin/agents/:id', requireAdmin, (c) => {
    deleteAgent(db, c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}

// ─── tokens ──────────────────────────────────────────────────────────────────

describe('admin token management', () => {
  test('GET /admin/tokens returns empty list initially', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/tokens', { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const body = await res.json() as { tokens: unknown[] };
    assert.ok(Array.isArray(body.tokens));
  });

  test('POST /admin/tokens creates a token with default scopes', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/tokens', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI Bot' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { token: string; name: string; scopes: string[] };
    assert.ok(body.token, 'plaintext token returned');
    assert.equal(body.name, 'CI Bot');
    assert.ok(body.scopes.includes('tasks:read'));
    assert.ok(body.scopes.includes('tasks:write'));
  });

  test('POST /admin/tokens with custom scopes', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/tokens', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Read Only', scopes: ['tasks:read'] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { scopes: string[] };
    assert.deepEqual(body.scopes, ['tasks:read']);
  });

  test('POST /admin/tokens returns 400 when name missing', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/tokens', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test('DELETE /admin/tokens/:id revokes a token', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);

    // Create
    const createRes = await appFetch(app, '/admin/tokens', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temp' }),
    });
    const { id } = await createRes.json() as { id: string };

    // Delete
    const delRes = await appFetch(app, `/admin/tokens/${id}`, {
      method: 'DELETE',
      headers: { Authorization: basic },
    });
    assert.equal(delRes.status, 200);
    const tokens = listTokens(db);
    assert.ok(!tokens.find((t) => t.id === id), 'token removed from list');
  });

  test('non-admin cannot access token management', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('user', 'pw', 'member');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/tokens', { headers: { Authorization: basic } });
    assert.equal(res.status, 403);
  });

  test('GET /admin/tokens lists multiple tokens', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    await appFetch(app, '/admin/tokens', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A' }),
    });
    await appFetch(app, '/admin/tokens', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B' }),
    });
    const res = await appFetch(app, '/admin/tokens', { headers: { Authorization: basic } });
    const body = await res.json() as { tokens: { name: string }[] };
    assert.equal(body.tokens.length, 2);
  });
});

// ─── agents ──────────────────────────────────────────────────────────────────

describe('admin agent management', () => {
  test('GET /admin/agents returns empty list initially', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/agents', { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const body = await res.json() as { agents: unknown[] };
    assert.deepEqual(body.agents, []);
  });

  test('POST /admin/agents creates an anthropic agent', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/agents', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Hermes',
        username: 'hermes',
        kind: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { id: string; name: string; kind: string; token?: string };
    assert.equal(body.name, 'Hermes');
    assert.equal(body.kind, 'anthropic');
    assert.equal(body.token, undefined, 'no token for non-webhook agent');
  });

  test('POST /admin/agents issues a token for webhook agents', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/agents', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'MyBot',
        username: 'mybot',
        kind: 'webhook',
        endpoint: 'https://bot.example.com/hook',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { token?: string };
    assert.ok(body.token, 'webhook agent gets a bearer token');
  });

  test('POST /admin/agents returns 409 for duplicate username', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const payload = { name: 'Bot', username: 'dupebot', kind: 'openai' };
    await appFetch(app, '/admin/agents', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const res = await appFetch(app, '/admin/agents', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 409);
  });

  test('POST /admin/agents returns 400 when required fields missing', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/agents', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NoKind' }),
    });
    assert.equal(res.status, 400);
  });

  test('PATCH /admin/agents/:id updates patchable fields', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);

    // Create with no model
    const createRes = await appFetch(app, '/admin/agents', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MyAgent', username: 'patchbot', kind: 'anthropic' }),
    });
    const { id } = await createRes.json() as { id: string };

    // Patch model
    const patchRes = await appFetch(app, `/admin/agents/${id}`, {
      method: 'PATCH',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    assert.equal(patchRes.status, 200);
    const updated = await patchRes.json() as { model: string | null };
    assert.equal(updated.model, 'claude-sonnet-4-6');
  });

  test('PATCH /admin/agents/:id returns 404 for unknown id', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/agents/nonexistent', {
      method: 'PATCH',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    assert.equal(res.status, 404);
  });

  test('DELETE /admin/agents/:id removes the agent', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);

    const createRes = await appFetch(app, '/admin/agents', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Goner', username: 'goner', kind: 'openai' }),
    });
    const { id } = await createRes.json() as { id: string };

    const delRes = await appFetch(app, `/admin/agents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: basic },
    });
    assert.equal(delRes.status, 200);
    assert.ok(!getAgent(db, id), 'agent removed');
  });

  test('DELETE /admin/agents/:id also removes its agent_usage rows', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('admin', 'pw', 'admin');
    const app = buildAdminApp(db);

    const createRes = await appFetch(app, '/admin/agents', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Chatty', username: 'chatty', kind: 'openai' }),
    });
    const { id } = (await createRes.json()) as { id: string };

    recordAgentUsage(db, id, { input: 10, output: 5 }, 'm', 'comment_reply');
    recordAgentUsage(db, id, { input: 20, output: 8 }, 'm', 'nl_command');
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_usage WHERE agent_id = ?', [id])!.n,
      2,
      'usage rows recorded before delete',
    );

    const delRes = await appFetch(app, `/admin/agents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: basic },
    });
    assert.equal(delRes.status, 200);
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_usage WHERE agent_id = ?', [id])!.n,
      0,
      'usage rows are cleaned up, not left orphaned',
    );
  });

  test('non-admin cannot manage agents', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('member', 'pw', 'member');
    const app = buildAdminApp(db);
    const res = await appFetch(app, '/admin/agents', { headers: { Authorization: basic } });
    assert.equal(res.status, 403);
  });
});
