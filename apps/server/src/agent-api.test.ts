/**
 * HTTP-level tests for the natural-language agent API (/agent/*).
 * Mirrors tasks-api.test.ts: builds an in-process Hono app, exercises auth/scope,
 * fuzzy resolution, batching, and the matched/unmatched envelopes.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  createItem,
  createTag,
  setItemTagLink,
  getItem,
  getItemTags,
  getChildren,
  listTags,
  setCompleted,
  shareItem,
  assignItem,
  updateTag,
  parseGeo,
  visibleItemIds,
  listAssigneesForItem,
  createUser,
  hasWriteAccess,
  updateItem,
  queryItems,
} from '@carbon/core';
import { createSession, createToken } from './auth';
import { registerAgentApi } from './agent-api';
import type { GeocodeProvider } from './geocode';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';

const stubGeo: GeocodeProvider = {
  async search(query) {
    return [{ point: { lat: -37.81, lng: 145.01 }, label: `${query} Camberwell` }];
  },
  async nearestBrand(query) {
    return { point: { lat: -37.81, lng: 145.01 }, label: `${query} Camberwell` };
  },
};

function buildAgentApp(db: TestDb, deviceId: string, geocode: GeocodeProvider | null = stubGeo) {
  const app = makeHono(db, false); // require auth
  const isBot = (userId: string) =>
    !!db.get<{ is_bot: number }>('SELECT is_bot FROM users WHERE id = ?', [userId])?.is_bot;
  const canSee = (userId: string, itemId: string) =>
    isBot(userId) || visibleItemIds(db, userId).has(itemId);
  const botAssigned = (userId: string, itemId: string) =>
    listAssigneesForItem(db, itemId).some((a) => a.user_id === userId);
  registerAgentApi(app, { db, deviceId, isBot, canSee, botAssigned, geocode });
  return app;
}

const json = (basic: string, body: unknown) => ({
  method: 'POST',
  headers: { Authorization: basic, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ─── READ shapes ────────────────────────────────────────────────────────────

describe('GET /agent/lists & /agent/tags & /agent/items', () => {
  test('lists returns minimal {id,name}', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    createItem(db, deviceId, { type: 'project', title: 'Shopping List', ownerId: uid });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/lists', { headers: { Authorization: basic } });
    const body = (await res.json()) as { lists: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(body.lists[0]).sort(), ['id', 'name']);
    assert.equal(body.lists[0].name, 'Shopping List');
  });

  test('items default shape is exactly {id,title,tags,done}', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    const task = createItem(db, deviceId, { type: 'task', title: 'Milk', parentId: proj.id, ownerId: uid });
    const tag = createTag(db, deviceId, 'Coles');
    setItemTagLink(db, deviceId, task.id, tag.id, false);
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, `/agent/items?list=${proj.id}`, { headers: { Authorization: basic } });
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(body.items[0]).sort(), ['done', 'id', 'tags', 'title']);
    assert.deepEqual(body.items[0].tags, ['Coles']);
  });

  test('tags exposes hasGeo flag', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    const plain = createTag(db, deviceId, 'Work');
    const geoTag = createTag(db, deviceId, 'Coles');
    updateTag(db, deviceId, geoTag.id, { geo: JSON.stringify({ lat: -37.8, lng: 145, radius: 150 }) });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/tags', { headers: { Authorization: basic } });
    const body = (await res.json()) as { tags: { name: string; hasGeo: boolean }[] };
    assert.equal(body.tags.find((t) => t.name === 'Coles')?.hasGeo, true);
    assert.equal(body.tags.find((t) => t.name === 'Work')?.hasGeo, false);
    void plain;
  });
});

// ─── resolve ────────────────────────────────────────────────────────────────

describe('POST /agent/resolve', () => {
  test('list kind resolves a typo confidently', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    createItem(db, deviceId, { type: 'project', title: 'Shopping List', ownerId: uid });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/resolve', json(basic, { kind: 'list', q: 'shoping list' }));
    const body = (await res.json()) as { candidates: { name: string }[]; best: { confident: boolean } };
    assert.equal(body.candidates[0].name, 'Shopping List');
    assert.equal(body.best.confident, true);
  });

  test('a single typo keyword resolves a multi-word list', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    createItem(db, deviceId, { type: 'project', title: 'Shopping List', ownerId: uid });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/resolve', json(basic, { kind: 'list', q: 'shoping' }));
    const body = (await res.json()) as { best: { confident: boolean } | null };
    assert.equal(body.best?.confident, true);
  });

  test('tag kind matches on the path leaf', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    createTag(db, deviceId, 'Shopping:Coles');
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/resolve', json(basic, { kind: 'tag', q: 'coles' }));
    const body = (await res.json()) as { candidates: { name: string }[] };
    assert.equal(body.candidates[0].name, 'Shopping:Coles');
  });
});

// ─── batch add ──────────────────────────────────────────────────────────────

describe('POST /agent/tasks/batch', () => {
  test('adds two tasks to an existing fuzzy-matched list', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping List', ownerId: uid });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(
      app,
      '/agent/tasks/batch',
      json(basic, { list: 'shopping list', titles: ['milk', 'eggs'] }),
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { list: { id: string; created: boolean }; created: unknown[] };
    assert.equal(body.list.id, proj.id);
    assert.equal(body.list.created, false);
    const kids = getChildren(db, proj.id).filter((t) => t.type === 'task');
    assert.deepEqual(kids.map((k) => k.title).sort(), ['eggs', 'milk']);
  });

  test('rejects an over-large batch (input cap)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    const app = buildAgentApp(db, deviceId);
    const titles = Array.from({ length: 101 }, (_, i) => `t${i}`);
    const res = await appFetch(app, '/agent/tasks/batch', json(basic, { titles }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /too many/);
  });

  test('attaches an existing tag (geo rides on the tag)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    createTag(db, deviceId, 'Coles');
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(
      app,
      '/agent/tasks/batch',
      json(basic, { list: 'shopping', tags: ['coles'], titles: ['milk'] }),
    );
    const body = (await res.json()) as { created: { id: string }[]; tags: { created: boolean }[] };
    assert.equal(body.tags[0].created, false);
    assert.deepEqual(getItemTags(db, body.created[0].id).map((t) => t.name), ['Coles']);
  });

  test('auto-creates a missing list and tag, flagged in the response', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(
      app,
      '/agent/tasks/batch',
      json(basic, { list: 'Camping', tags: ['Bunnings'], titles: ['rope'] }),
    );
    const body = (await res.json()) as { list: { created: boolean }; tags: { created: boolean }[] };
    assert.equal(body.list.created, true);
    assert.equal(body.tags[0].created, true);
    assert.ok(listTags(db).some((t) => t.name === 'Bunnings'));
  });
});

// ─── bulk tag ─────────────────────────────────────────────────────────────────

describe('POST /agent/tasks/tag', () => {
  test('adds a tag to every task in a list', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    const milk = createItem(db, deviceId, { type: 'task', title: 'Milk', parentId: proj.id, ownerId: uid });
    createItem(db, deviceId, { type: 'task', title: 'Eggs', parentId: proj.id, ownerId: uid });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/tasks/tag', json(basic, { list: 'shopping', add: ['woolworths'] }));
    const body = (await res.json()) as { updated: unknown[]; tags_added: string[] };
    assert.equal(body.updated.length, 2);
    assert.deepEqual(body.tags_added, ['woolworths']);
    assert.deepEqual(getItemTags(db, milk.id).map((t) => t.name), ['woolworths']);
  });

  test('a read-only target comes back as unmatched/forbidden, not tagged', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { id: bobId, basic: bobBasic } = addUser('bob', 'pw');
    const t = createItem(db, deviceId, { type: 'task', title: 'Shared RO', ownerId: aliceId });
    shareItem(db, deviceId, t.id, bobId, 'read'); // bob can see but not write
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/tasks/tag', json(bobBasic, { ids: [t.id], add: ['urgent'] }));
    const body = (await res.json()) as {
      updated: unknown[];
      unmatched: { query: string; reason: string }[];
    };
    assert.equal(body.updated.length, 0);
    assert.equal(body.unmatched[0].reason, 'forbidden');
    assert.deepEqual(getItemTags(db, t.id), []); // tag was not applied
  });
});

// ─── update ─────────────────────────────────────────────────────────────────

describe('POST /agent/tasks/update', () => {
  test('patches whitelisted fields, ignores unknown keys, reports a miss', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    const milk = createItem(db, deviceId, { type: 'task', title: 'Milk', parentId: proj.id, ownerId: uid });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(
      app,
      '/agent/tasks/update',
      json(basic, {
        updates: [
          { query: 'milk', list: 'shopping', patch: { flagged: true, priority: 3, bogus: 'x' } },
          { query: 'bread', list: 'shopping', patch: { flagged: true } },
        ],
      }),
    );
    const body = (await res.json()) as {
      matched: { title: string }[];
      unmatched: { query: string; reason: string }[];
    };
    assert.deepEqual(body.matched.map((m) => m.title), ['Milk']);
    assert.deepEqual(body.unmatched, [{ query: 'bread', reason: 'no_match' }]);
    const updated = getItem(db, milk.id)!;
    assert.ok(updated.flagged);
    assert.equal(updated.priority, 3);
    assert.ok(!('bogus' in updated)); // unknown patch key dropped by the whitelist
  });

  test('rejects an over-large update batch (input cap)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    const app = buildAgentApp(db, deviceId);
    const updates = Array.from({ length: 101 }, (_, i) => ({ query: `t${i}`, patch: { flagged: true } }));
    const res = await appFetch(app, '/agent/tasks/update', json(basic, { updates }));
    assert.equal(res.status, 400);
  });
});

// ─── fuzzy mark-off with a miss ───────────────────────────────────────────────

describe('POST /agent/tasks/complete', () => {
  test('completes a found task and reports the missing one', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    const milk = createItem(db, deviceId, { type: 'task', title: 'Milk', parentId: proj.id, ownerId: uid });
    createItem(db, deviceId, { type: 'task', title: 'Eggs', parentId: proj.id, ownerId: uid });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(
      app,
      '/agent/tasks/complete',
      json(basic, { queries: ['bread', 'milk'], list: 'shopping' }),
    );
    const body = (await res.json()) as {
      matched: { query: string; title: string }[];
      unmatched: { query: string; reason: string }[];
    };
    assert.deepEqual(body.matched.map((m) => m.title), ['Milk']);
    assert.deepEqual(body.unmatched, [{ query: 'bread', reason: 'no_match' }]);
    assert.equal(getItem(db, milk.id)?.status, 'done');
  });

  test('a bot not assigned to a task gets it back as forbidden, not a 403', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const bot = createUser(db, { username: 'bot', displayName: 'Bot', isBot: true });
    const botToken = `Bearer ${createSession(db, bot.id)}`;
    const task = createItem(db, deviceId, { type: 'task', title: 'Private', ownerId: uid });
    const app = buildAgentApp(db, deviceId);

    let res = await appFetch(app, '/agent/tasks/complete', {
      method: 'POST',
      headers: { Authorization: botToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [task.id] }),
    });
    assert.equal(res.status, 200);
    let body = (await res.json()) as { unmatched: { reason: string }[] };
    assert.equal(body.unmatched[0].reason, 'forbidden');
    assert.equal(getItem(db, task.id)?.status, 'active');

    // Once assigned, the same bot may complete it.
    assignItem(db, deviceId, task.id, bot.id);
    res = await appFetch(app, '/agent/tasks/complete', {
      method: 'POST',
      headers: { Authorization: botToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [task.id] }),
    });
    body = (await res.json()) as { unmatched: { reason: string }[] };
    assert.equal((body as unknown as { matched: unknown[] }).matched.length, 1);
    assert.equal(getItem(db, task.id)?.status, 'done');
  });
});

// ─── tag geo + nearby ─────────────────────────────────────────────────────────

describe('POST /agent/tags/geo & GET /agent/nearby', () => {
  test('sets explicit geo on a tag and finds tasks by that tag', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const proj = createItem(db, deviceId, { type: 'project', title: 'Shopping', ownerId: uid });
    const task = createItem(db, deviceId, { type: 'task', title: 'Milk', parentId: proj.id, ownerId: uid });
    const tag = createTag(db, deviceId, 'Coles');
    setItemTagLink(db, deviceId, task.id, tag.id, false);
    const app = buildAgentApp(db, deviceId);

    const geoRes = await appFetch(
      app,
      '/agent/tags/geo',
      json(basic, { tag: 'coles', geo: { lat: -37.81, lng: 145.01, radius: 200, label: 'Coles' } }),
    );
    const geoBody = (await geoRes.json()) as { geo: { lat: number }; source: string };
    assert.equal(geoBody.source, 'explicit');
    assert.ok(parseGeo(listTags(db).find((t) => t.name === 'Coles')!.geo));

    const nearRes = await appFetch(app, '/agent/nearby?tag=coles', { headers: { Authorization: basic } });
    const nearBody = (await nearRes.json()) as { items: { title: string }[] };
    assert.deepEqual(nearBody.items.map((i) => i.title), ['Milk']);
  });

  test('geocodes a place name via the provider', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    createTag(db, deviceId, 'Coles');
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(
      app,
      '/agent/tags/geo',
      json(basic, { tag: 'coles', near_name: 'coles', near: { lat: -37.8, lng: 145 } }),
    );
    const body = (await res.json()) as { geo: { lat: number; label: string }; source: string };
    assert.equal(body.source, 'geocoded');
    assert.equal(body.geo.lat, -37.81);
  });

  test('400 when geocoding is disabled and no coords supplied', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    createTag(db, deviceId, 'Coles');
    const app = buildAgentApp(db, deviceId, null); // geocoder disabled
    const res = await appFetch(
      app,
      '/agent/tags/geo',
      json(basic, { tag: 'coles', near_name: 'coles', near: { lat: -37.8, lng: 145 } }),
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'geocoding_disabled');
  });

  test('near_name without a near anchor → no_anchor_location (distinct from a geocode miss)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('a', 'pw');
    createTag(db, deviceId, 'Coles');
    const app = buildAgentApp(db, deviceId); // geocoder on, but no anchor point supplied
    const res = await appFetch(app, '/agent/tags/geo', json(basic, { tag: 'coles', near_name: 'coles' }));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'no_anchor_location');
  });

  test('nearby matches a task by point inside the tag geofence', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Milk', ownerId: uid });
    const tag = createTag(db, deviceId, 'Coles');
    updateTag(db, deviceId, tag.id, { geo: JSON.stringify({ lat: -37.81, lng: 145.01, radius: 300 }) });
    setItemTagLink(db, deviceId, task.id, tag.id, false);
    const app = buildAgentApp(db, deviceId);

    const inside = await appFetch(app, '/agent/nearby?lat=-37.81&lng=145.01', { headers: { Authorization: basic } });
    assert.deepEqual(((await inside.json()) as { items: { title: string }[] }).items.map((i) => i.title), ['Milk']);

    const outside = await appFetch(app, '/agent/nearby?lat=-37.9&lng=145.2', { headers: { Authorization: basic } });
    assert.deepEqual(((await outside.json()) as { items: unknown[] }).items, []);
  });
});

// ─── share & assign ───────────────────────────────────────────────────────────

describe('POST /agent/tasks/assign', () => {
  test('assigning grants a write share, matching the UI-level assign flow (regression)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const { id: rachelId } = addUser('rachel', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Book flights', ownerId: uid });
    // Rachel has no share yet — before the fix, assignItem() alone left her unable to
    // see the task via /api/sync even though she was now "assigned" to it.
    assert.equal(hasWriteAccess(db, task.id, rachelId), false);
    const app = buildAgentApp(db, deviceId);

    const res = await appFetch(app, '/agent/tasks/assign', json(basic, { id: task.id, users: ['rachel'] }));
    assert.equal(res.status, 200);
    assert.ok(listAssigneesForItem(db, task.id).some((a) => a.user_id === rachelId));
    assert.equal(hasWriteAccess(db, task.id, rachelId), true);
  });

  test('assigning an already-shared user does not downgrade their permission', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const { id: rachelId } = addUser('rachel', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Book flights', ownerId: uid });
    shareItem(db, deviceId, task.id, rachelId, 'write'); // already has write access
    const app = buildAgentApp(db, deviceId);

    const res = await appFetch(app, '/agent/tasks/assign', json(basic, { id: task.id, users: ['rachel'] }));
    assert.equal(res.status, 200);
    assert.equal(hasWriteAccess(db, task.id, rachelId), true);
  });
});

// ─── update via status:'done' ──────────────────────────────────────────────────

describe('POST /agent/tasks/update — status:done routes through setCompleted', () => {
  test('a raw status:"done" patch still spawns the next recurrence', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const due = new Date();
    due.setDate(due.getDate() + 5);
    due.setMilliseconds(0);
    const task = createItem(db, deviceId, { type: 'task', title: 'Water the plants', ownerId: uid, dueDate: due.toISOString() });
    updateItem(db, deviceId, task.id, { recurrence: JSON.stringify({ type: 'daily', interval: 1 }) });
    const app = buildAgentApp(db, deviceId);

    const res = await appFetch(
      app,
      '/agent/tasks/update',
      json(basic, { updates: [{ id: task.id, patch: { status: 'done' } }] }),
    );
    assert.equal(res.status, 200);
    const original = getItem(db, task.id)!;
    assert.equal(original.status, 'done');
    assert.ok(original.completed_at);
    const spawned = queryItems(db, { tasksOnly: true }).find(
      (i) => i.title === 'Water the plants' && i.id !== task.id,
    );
    assert.ok(spawned, 'expected a spawned next occurrence');
    assert.equal(spawned!.status, 'active');
  });
});

// ─── visibility & auth ────────────────────────────────────────────────────────

describe('visibility & auth', () => {
  test('a human sees only their own tasks; a sharee sees shared ones', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { id: bobId, basic: bobBasic } = addUser('bob', 'pw');
    const t1 = createItem(db, deviceId, { type: 'task', title: 'Alice only', ownerId: aliceId });
    const t2 = createItem(db, deviceId, { type: 'task', title: 'Shared', ownerId: aliceId });
    shareItem(db, deviceId, t2.id, bobId, 'read');
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/items?status=all', { headers: { Authorization: bobBasic } });
    const titles = ((await res.json()) as { items: { title: string }[] }).items.map((i) => i.title);
    assert.ok(titles.includes('Shared'));
    assert.ok(!titles.includes('Alice only'));
    void t1;
  });

  test('401 without credentials', async () => {
    const { db, deviceId } = makeTestDb();
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/lists');
    assert.equal(res.status, 401);
  });

  test('a token missing tasks:write is 403 on complete', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { token } = createToken(db, { userId: uid, name: 'ro', scopes: ['tasks:read'] });
    const app = buildAgentApp(db, deviceId);
    const res = await appFetch(app, '/agent/tasks/complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: ['milk'] }),
    });
    assert.equal(res.status, 403);
  });
});
