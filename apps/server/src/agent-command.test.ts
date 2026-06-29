/**
 * Tests for the in-app NL command tool-loop (agent-command.ts) and the NL settings/usage
 * helpers. The LLM provider is stubbed via globalThis.fetch (scripted OpenAI responses), so
 * no network. allowPrivate=true short-circuits the SSRF DNS check in safeFetch.
 */
import assert from 'node:assert/strict';
import { test, describe, afterEach } from 'node:test';
import { createItem, getProjects, getChildren, getItem, visibleItemIds, listAssigneesForItem } from '@carbon/core';
import { createAgent, getAgent, getNlSettings, setNlSettings, getAgentUsage, DEFAULT_NL_KEYWORDS } from './agents';
import { runAgentCommand } from './agent-command';
import { requireScope } from './auth';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A queue of scripted chat-completion responses; the last one repeats.
function stubLLM(responses: unknown[]) {
  let i = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}
const toolResp = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        content: '',
        tool_calls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
});
const doneResp = (text = '') => ({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 8, completion_tokens: 2 },
});

function deps(db: TestDb, deviceId: string) {
  const isBot = (userId: string) =>
    !!db.get<{ is_bot: number }>('SELECT is_bot FROM users WHERE id = ?', [userId])?.is_bot;
  return {
    db,
    deviceId,
    isBot,
    canSee: (u: string, id: string) => isBot(u) || visibleItemIds(db, u).has(id),
    botAssigned: (u: string, id: string) => listAssigneesForItem(db, id).some((a) => a.user_id === u),
    geocode: null,
  };
}

function makeAgent(db: TestDb) {
  const a = createAgent(db, {
    name: 'NL',
    username: 'nlbot',
    kind: 'openai',
    endpoint: 'http://llm.test/v1',
    apiKey: 'k',
    model: 'm',
  });
  return getAgent(db, a.id)!;
}

describe('runAgentCommand tool loop', () => {
  test('add: model calls add_tasks, server creates tasks + builds reply + records usage', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);
    stubLLM([toolResp('add_tasks', { list: 'shopping list', titles: ['milk', 'eggs'] }), doneResp('done')]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'add milk and eggs to my shopping list', true);

    assert.match(r.reply, /Added.*"shopping list".*Milk, Eggs/);
    const proj = getProjects(db).find((p) => p.title === 'shopping list')!;
    assert.equal(getChildren(db, proj.id).filter((t) => t.type === 'task').length, 2);
    // Items owned by the user → visible to them.
    assert.equal(getItem(db, getChildren(db, proj.id)[0].id)?.owner_id, uid);
    // Usage is summed across the two turns into one row.
    const usage = getAgentUsage(db);
    assert.equal(usage.byKind.nl_command.calls, 1);
    assert.equal(usage.byKind.nl_command.input_tokens, 18);
    assert.equal(usage.byKind.nl_command.output_tokens, 6);
  });

  test('complete: reports matched and missing', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    createItem(db, deviceId, { type: 'task', title: 'Milk', parentId: proj.id, ownerId: uid });
    stubLLM([toolResp('complete', { queries: ['milk', 'bread'], list: 'shopping' }), doneResp()]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'mark off milk and bread', true);
    assert.match(r.reply, /Marked off: Milk/);
    assert.match(r.reply, /Couldn't find: bread/);
  });

  test('tolerant fallback: a JSON action in plain text (no native tool calls) still executes', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);
    stubLLM([doneResp('Sure! {"op":"add","list":"groceries","titles":["bananas"]}')]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'add bananas to groceries', true);
    assert.match(r.reply, /Added.*Bananas/);
    assert.ok(getProjects(db).some((p) => p.title === 'groceries'));
  });

  test('remind-at-PLACE: geocodes the nearest place to the user and pins the tag', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { saveDeviceLocation, listTags, parseGeo } = {
      ...(await import('./auth')),
      ...(await import('@carbon/core')),
    } as typeof import('./auth') & typeof import('@carbon/core');
    // fresh, precise fix → usable anchor (freshest across the user's devices)
    saveDeviceLocation(db, { userId: uid, deviceId: 'phone', lat: -37.8, lng: 145.0, accuracy: 30, source: 'device' });
    const agent = makeAgent(db);
    const geocode = {
      async search(q: string) {
        return [{ point: { lat: -37.81, lng: 145.01 }, label: `${q} Camberwell` }];
      },
      async nearestBrand(q: string) {
        return { point: { lat: -37.81, lng: 145.01 }, label: `${q} Camberwell` };
      },
    };
    const d = { ...deps(db, deviceId), geocode };
    stubLLM([
      toolResp('add_tasks', { list: 'shopping list', titles: ['eggs'], tags: ['coles'] }),
      toolResp('set_tag_geo', { tag: 'coles', near_name: 'coles' }), // no coords — code supplies them
      doneResp(),
    ]);

    const r = await runAgentCommand(d, agent, uid, 'add eggs to shopping, remind me at coles', true);
    assert.match(r.reply, /Set coles location/);
    const tag = listTags(db).find((t) => t.name === 'coles')!;
    assert.ok(parseGeo(tag.geo), 'coles tag has a geofence');
  });

  test('remind-at-PLACE with no usable location: tasks still land, geo is soft-failed', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db); // no GPS recorded → anchor null
    const geocode = { async search() { return []; }, async nearestBrand() { return null; } };
    const d = { ...deps(db, deviceId), geocode };
    stubLLM([
      toolResp('add_tasks', { list: 'shopping list', titles: ['eggs'], tags: ['coles'] }),
      toolResp('set_tag_geo', { tag: 'coles', near_name: 'coles' }),
      doneResp(),
    ]);
    const r = await runAgentCommand(d, agent, uid, 'add eggs, remind me at coles', true);
    assert.match(r.reply, /Added.*Eggs/);
    assert.match(r.reply, /Couldn't pin coles/);
  });

  test('tag_items: bulk-tags every task in a list (no enumeration needed)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { getItemTags } = await import('@carbon/core');
    const agent = makeAgent(db);
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    createItem(db, deviceId, { type: 'task', title: 'Milk', parentId: proj.id, ownerId: uid });
    createItem(db, deviceId, { type: 'task', title: 'Eggs', parentId: proj.id, ownerId: uid });
    stubLLM([toolResp('tag_items', { list: 'shopping', add: ['woolworths'] }), doneResp()]);

    const r = await runAgentCommand(
      deps(db, deviceId),
      agent,
      uid,
      'add the woolworths tag to all items in the shopping list',
      true,
    );
    assert.match(r.reply, /Tagged 2 tasks with woolworths/);
    for (const t of getChildren(db, proj.id)) {
      assert.ok(getItemTags(db, t.id).some((tg) => tg.name === 'woolworths'), `${t.title} tagged`);
    }
  });

  test('query: nearby answer is summarised', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    // tag a task; nearby by tag finds active tagged tasks
    const { createTag, setItemTagLink } = await import('@carbon/core');
    const task = createItem(db, deviceId, { type: 'task', title: 'Bread', parentId: proj.id, ownerId: uid });
    const tag = createTag(db, deviceId, 'coles');
    setItemTagLink(db, deviceId, task.id, tag.id, false);
    stubLLM([toolResp('nearby', { tag: 'coles' }), doneResp()]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'what do I need at coles', true);
    assert.match(r.reply, /At coles: Bread/);
  });
});

describe('NL settings + usage helpers', () => {
  test('defaults, round-trip, and enabled requires an agent', () => {
    const { db } = makeTestDb();
    assert.deepEqual(getNlSettings(db).keywords, DEFAULT_NL_KEYWORDS);
    assert.equal(getNlSettings(db).enabled, false);

    const agent = makeAgent(db);
    setNlSettings(db, { enabled: true }); // no agent yet → still not enabled
    assert.equal(getNlSettings(db).enabled, false);

    setNlSettings(db, { agentId: agent.id, enabled: true, keywords: ['add', 'do'] });
    const nl = getNlSettings(db);
    assert.equal(nl.enabled, true);
    assert.equal(nl.agentId, agent.id);
    assert.deepEqual(nl.keywords, ['add', 'do']);

    setNlSettings(db, { enabled: false });
    assert.equal(getNlSettings(db).enabled, false);
  });
});

// Minimal app exercising the two non-admin routes' guard behaviour.
function buildCmdApp(db: TestDb, deviceId: string) {
  const app = makeHono(db, false);
  const d = deps(db, deviceId);
  app.get('/agent/config', requireScope('tasks:read'), (c) => {
    const nl = getNlSettings(db);
    return c.json({ enabled: nl.enabled, keywords: nl.keywords });
  });
  app.post('/agent/command', requireScope('inbox:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = (b.text ?? '').trim();
    if (!text) return c.json({ error: 'text required' }, 400);
    const nl = getNlSettings(db);
    const agent = nl.enabled && nl.agentId ? getAgent(db, nl.agentId) : undefined;
    if (!agent || !agent.enabled || agent.kind === 'webhook') return c.json({ error: 'nl_not_configured' }, 503);
    return c.json(await runAgentCommand(d, agent, c.get('userId'), text, true));
  });
  return app;
}

describe('command/config routes', () => {
  test('config is readable by a normal user', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    const res = await appFetch(buildCmdApp(db, deviceId), '/agent/config', { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { enabled: boolean; keywords: string[] };
    assert.equal(body.enabled, false);
    assert.ok(body.keywords.includes('add'));
  });

  test('command returns 503 when NL is not configured', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    const res = await appFetch(buildCmdApp(db, deviceId), '/agent/command', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'add milk' }),
    });
    assert.equal(res.status, 503);
  });

  test('command runs end-to-end once configured', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    const agent = makeAgent(db);
    setNlSettings(db, { agentId: agent.id, enabled: true });
    stubLLM([toolResp('add_tasks', { list: 'shopping', titles: ['milk'] }), doneResp()]);
    const res = await appFetch(buildCmdApp(db, deviceId), '/agent/command', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'add milk to shopping' }),
    });
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { reply: string }).reply, /Added.*Milk/);
  });
});
