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

  test('tolerant fallback: a JSON search_notes action in plain text still executes', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    createItem(db, deviceId, { type: 'note', title: 'Trip', note: 'pack sunscreen', ownerId: uid });
    const agent = makeAgent(db);
    stubLLM([doneResp('{"op":"search_notes","q":"sunscreen"}')]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'do I have a note about sunscreen?', true);
    assert.match(r.reply, /sunscreen/);
  });

  test('tolerant fallback: a JSON tag_items action in plain text still executes', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Milk', ownerId: uid });
    const agent = makeAgent(db);
    stubLLM([doneResp('{"op":"tag_items","queries":["milk"],"add":["urgent"]}')]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'tag milk urgent', true);
    assert.match(r.reply, /urgent/i);
    const { getItemTags } = await import('@carbon/core');
    assert.deepEqual(getItemTags(db, task.id).map((t) => t.name), ['urgent']);
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

describe('runAgentCommand — scheduling, sharing, assigning, timers, completed reads', () => {
  test('scheduling: add_tasks with recurrence + reminder_at round-trips onto the item', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { parseRecurrence } = await import('@carbon/core');
    const agent = makeAgent(db);
    stubLLM([
      toolResp('add_tasks', {
        tasks: [
          {
            title: 'Take son to swimming',
            due_date: '2026-07-07T17:00:00.000Z',
            reminder_at: '2026-07-07T16:00:00.000Z',
            recurrence: { type: 'weekly', interval: 1, daysOfWeek: [2] },
          },
        ],
      }),
      doneResp(),
    ]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'remind me to take my son to swimming every tuesday at 5pm, an hour before', true);
    assert.match(r.reply, /Added.*Take son to swimming/);
    const { queryItems } = await import('@carbon/core');
    const task = queryItems(db, { tasksOnly: true }).find((t) => t.title === 'Take son to swimming')!;
    assert.equal(task.due_date, '2026-07-07T17:00:00.000Z');
    assert.equal(task.reminder_at, '2026-07-07T16:00:00.000Z');
    const rule = parseRecurrence(task.recurrence);
    assert.deepEqual(rule, { type: 'weekly', interval: 1, daysOfWeek: [2] });
  });

  test('scheduling: due_date on the wrong weekday is snapped to the recurrence day', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { parseRecurrence, queryItems } = await import('@carbon/core');
    const agent = makeAgent(db);
    // Real bug: asked on Monday 2026-07-06 (Melbourne) for "every Tuesday 4pm", the model
    // miscounted the weekday and returned Saturday 2026-07-11 16:00 local (06:00Z), while
    // still emitting the correct daysOfWeek [2].
    stubLLM([
      toolResp('add_tasks', {
        tasks: [
          {
            title: 'Call Ben',
            due_date: '2026-07-11T06:00:00.000Z',
            reminder_at: '2026-07-11T05:00:00.000Z',
            recurrence: { type: 'weekly', interval: 1, daysOfWeek: [2] },
          },
        ],
      }),
      doneResp(),
    ]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'call ben every tuesday at 4pm', true, {
      now: new Date('2026-07-06T06:05:00.000Z'), // Monday 16:05 in Melbourne
      timezone: 'Australia/Melbourne',
    });
    assert.match(r.reply, /Added.*Call Ben/);
    const task = queryItems(db, { tasksOnly: true }).find((t) => t.title === 'Call Ben')!;
    // Tuesday 2026-07-07 16:00 Melbourne = 06:00Z; the reminder keeps its 1h-before offset.
    assert.equal(task.due_date, '2026-07-07T06:00:00.000Z');
    assert.equal(task.reminder_at, '2026-07-07T05:00:00.000Z');
    assert.deepEqual(parseRecurrence(task.recurrence), { type: 'weekly', interval: 1, daysOfWeek: [2] });
  });

  test('scheduling: due_date already on a recurrence day is left alone', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { queryItems } = await import('@carbon/core');
    const agent = makeAgent(db);
    stubLLM([
      toolResp('add_tasks', {
        tasks: [
          {
            title: 'Call Ben',
            due_date: '2026-07-14T06:00:00.000Z', // Tuesday 16:00 Melbourne, a week out
            recurrence: { type: 'weekly', interval: 1, daysOfWeek: [2] },
          },
        ],
      }),
      doneResp(),
    ]);

    await runAgentCommand(deps(db, deviceId), agent, uid, 'call ben every tuesday at 4pm starting next week', true, {
      now: new Date('2026-07-06T06:05:00.000Z'),
      timezone: 'Australia/Melbourne',
    });
    const task = queryItems(db, { tasksOnly: true }).find((t) => t.title === 'Call Ben')!;
    // A matching weekday must not be "corrected" — the model may deliberately start later.
    assert.equal(task.due_date, '2026-07-14T06:00:00.000Z');
  });

  test('update: a status->done patch still spawns the next recurrence (routed through setCompleted)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { updateItem, queryItems, parseRecurrence } = await import('@carbon/core');
    const agent = makeAgent(db);
    const due = new Date();
    due.setDate(due.getDate() + 5);
    due.setMilliseconds(0);
    const task = createItem(db, deviceId, { type: 'task', title: 'Water the plants', ownerId: uid, dueDate: due.toISOString() });
    updateItem(db, deviceId, task.id, { recurrence: JSON.stringify({ type: 'daily', interval: 1 }) });
    stubLLM([
      toolResp('update', { updates: [{ query: 'water the plants', patch: { status: 'done' } }] }),
      doneResp(),
    ]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'mark water the plants as done', true);
    assert.match(r.reply, /Updated: Water the plants/);
    assert.equal(getItem(db, task.id)?.status, 'done');
    assert.ok(getItem(db, task.id)?.completed_at);
    // A next occurrence was spawned — proof the update went through setCompleted, not a
    // raw field write that would have bypassed the recurrence-spawn logic.
    const spawned = queryItems(db, { tasksOnly: true }).find(
      (t) => t.title === 'Water the plants' && t.id !== task.id,
    );
    assert.ok(spawned, 'expected a spawned next occurrence');
    assert.equal(spawned!.status, 'active');
    assert.deepEqual(parseRecurrence(spawned!.recurrence), { type: 'daily', interval: 1 });
  });

  test('reopen: complete done:false finds a completed task by name', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { setCompleted } = await import('@carbon/core');
    const agent = makeAgent(db);
    const task = createItem(db, deviceId, { type: 'task', title: 'Pay rent', ownerId: uid });
    setCompleted(db, deviceId, task.id, true);
    assert.equal(getItem(db, task.id)?.status, 'done');
    stubLLM([toolResp('complete', { queries: ['pay rent'], done: false }), doneResp()]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'untick pay rent', true);
    assert.match(r.reply, /Re-opened: Pay rent/);
    assert.equal(getItem(db, task.id)?.status, 'active');
  });

  test('share: shares a task with a roster user (write by default)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { id: rachelId } = addUser('rachel', 'pw');
    const { listSharesForItem } = await import('@carbon/core');
    const agent = makeAgent(db);
    const task = createItem(db, deviceId, { type: 'task', title: 'Plan trip', ownerId: uid });
    stubLLM([toolResp('share', { query: 'plan trip', users: ['rachel'] }), doneResp()]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'share plan trip with rachel', true);
    assert.match(r.reply, /Shared Plan trip with rachel/);
    const shares = listSharesForItem(db, task.id);
    assert.equal(shares.length, 1);
    assert.equal(shares[0].user_id, rachelId);
    assert.equal(shares[0].permission, 'write');
  });

  test('share: a read-only collaborator cannot re-share (write-gated)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: ownerId } = addUser('owner', 'pw');
    const { id: bobId } = addUser('bob', 'pw');
    addUser('rachel', 'pw');
    const { shareItem, listSharesForItem } = await import('@carbon/core');
    const agent = makeAgent(db);
    const task = createItem(db, deviceId, { type: 'task', title: 'Secret plan', ownerId });
    shareItem(db, deviceId, task.id, bobId, 'read'); // bob can see but not write
    stubLLM([toolResp('share', { query: 'secret plan', users: ['rachel'] }), doneResp()]);

    const r = await runAgentCommand(deps(db, deviceId), agent, bobId, 'share secret plan with rachel', true);
    assert.match(r.reply, /Skipped: Secret plan/);
    // Only bob's original read share exists; rachel was never added.
    assert.equal(listSharesForItem(db, task.id).length, 1);
  });

  test('assign: assigns a task to a roster user', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { id: rachelId } = addUser('rachel', 'pw');
    const agent = makeAgent(db);
    const task = createItem(db, deviceId, { type: 'task', title: 'Book flights', ownerId: uid });
    stubLLM([toolResp('assign', { query: 'book flights', users: ['rachel'] }), doneResp()]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'assign book flights to rachel', true);
    assert.match(r.reply, /Assigned Book flights to rachel/);
    assert.ok(listAssigneesForItem(db, task.id).some((a) => a.user_id === rachelId));
  });

  test('assign: also grants a write share, so the assignee can see it via /api/sync (regression)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { id: rachelId } = addUser('rachel', 'pw');
    const { hasWriteAccess } = await import('@carbon/core');
    const agent = makeAgent(db);
    const task = createItem(db, deviceId, { type: 'task', title: 'Book flights', ownerId: uid });
    // Rachel isn't shared on the task yet — an agent assign must not leave her unable to see it.
    assert.equal(hasWriteAccess(db, task.id, rachelId), false);
    stubLLM([toolResp('assign', { query: 'book flights', users: ['rachel'] }), doneResp()]);

    await runAgentCommand(deps(db, deviceId), agent, uid, 'assign book flights to rachel', true);
    assert.ok(listAssigneesForItem(db, task.id).some((a) => a.user_id === rachelId));
    assert.equal(hasWriteAccess(db, task.id, rachelId), true);
  });

  test('timers: start auto-stops a prior running timer; stop ends it', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { getRunningTimer } = await import('@carbon/core');
    const agent = makeAgent(db);
    const t1 = createItem(db, deviceId, { type: 'task', title: 'Write report', ownerId: uid });
    const t2 = createItem(db, deviceId, { type: 'task', title: 'Review PR', ownerId: uid });

    stubLLM([toolResp('start_timer', { query: 'write report' }), doneResp()]);
    await runAgentCommand(deps(db, deviceId), agent, uid, 'start a timer on write report', true);
    assert.equal(getRunningTimer(db, uid)?.item_id, t1.id);

    stubLLM([toolResp('start_timer', { query: 'review PR' }), doneResp()]);
    const r2 = await runAgentCommand(deps(db, deviceId), agent, uid, 'start a timer on review PR', true);
    assert.match(r2.reply, /Started timer on Review PR \(stopped Write report\)/);
    assert.equal(getRunningTimer(db, uid)?.item_id, t2.id);

    stubLLM([toolResp('stop_timer', {}), doneResp()]);
    const r3 = await runAgentCommand(deps(db, deviceId), agent, uid, 'stop the timer', true);
    assert.match(r3.reply, /Stopped timer on Review PR/);
    assert.equal(getRunningTimer(db, uid), undefined);
  });
});

describe('runAgentCommand — notes (type support, disambiguation, content search)', () => {
  test('add_tasks with type:"note" creates a note item, not a task', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);
    stubLLM([
      toolResp('add_tasks', { tasks: [{ title: 'Trip planning', type: 'note', note: 'Flights, hotel.' }] }),
      doneResp(),
    ]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'write a note about trip planning: flights, hotel', true);
    assert.match(r.reply, /Added note.*Trip planning/);
    const { queryItems } = await import('@carbon/core');
    const note = queryItems(db, {}).find((i) => i.title === 'Trip planning')!;
    assert.equal(note.type, 'note');
    assert.equal(note.note, 'Flights, hotel.');
  });

  test('update: adding a note field to an existing task ("add a note to X") does not change its type', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);
    const task = createItem(db, deviceId, { type: 'task', title: 'Fix the fence', ownerId: uid });
    stubLLM([
      toolResp('update', { updates: [{ query: 'fix the fence', patch: { note: 'Need 4 posts and concrete.' } }] }),
      doneResp(),
    ]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'add a note to fix the fence: need 4 posts and concrete', true);
    assert.match(r.reply, /Updated: Fix the fence/);
    const after = getItem(db, task.id)!;
    assert.equal(after.type, 'task');
    assert.equal(after.note, 'Need 4 posts and concrete.');
  });

  test('update: converting a task to a note preserves status untouched; converting back restores it', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const { setCompleted } = await import('@carbon/core');
    const agent = makeAgent(db);
    const task = createItem(db, deviceId, { type: 'task', title: 'Old reminder', ownerId: uid });
    setCompleted(db, deviceId, task.id, true); // status: done, before it ever becomes a note

    stubLLM([toolResp('update', { include_done: true, updates: [{ query: 'old reminder', patch: { type: 'note' } }] }), doneResp()]);
    await runAgentCommand(deps(db, deviceId), agent, uid, 'turn old reminder into a note', true);
    let after = getItem(db, task.id)!;
    assert.equal(after.type, 'note');
    assert.equal(after.status, 'done'); // preserved, just inert

    stubLLM([toolResp('update', { include_done: true, updates: [{ query: 'old reminder', patch: { type: 'task' } }] }), doneResp()]);
    const r2 = await runAgentCommand(deps(db, deviceId), agent, uid, 'turn old reminder back into a task', true);
    assert.match(r2.reply, /Updated: Old reminder/);
    after = getItem(db, task.id)!;
    assert.equal(after.type, 'task');
    assert.equal(after.status, 'done'); // restored automatically, not reset to active
  });

  test('items tool with type:"note" only returns notes', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);
    const proj = createItem(db, deviceId, { type: 'project', title: 'Home', ownerId: uid });
    createItem(db, deviceId, { type: 'task', title: 'Mow lawn', parentId: proj.id, ownerId: uid });
    createItem(db, deviceId, { type: 'note', title: 'Paint colors', parentId: proj.id, ownerId: uid });
    stubLLM([toolResp('items', { list: 'home', type: 'note' }), doneResp()]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'show my notes in home', true);
    assert.match(r.reply, /Paint colors/);
    assert.doesNotMatch(r.reply, /Mow lawn/);
  });

  test('search_notes: finds text in a note body and returns a snippet (Telegram/chat surface, conversational mode)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);
    createItem(db, deviceId, {
      type: 'note',
      title: 'Trip planning',
      ownerId: uid,
      note: 'Remember to book the rental car before the long weekend.',
    });
    // Conversational mode (as Telegram uses): the model's own final-turn text is the reply.
    stubLLM([
      toolResp('search_notes', { q: 'rental car' }),
      doneResp("Yep — your note 'Trip planning' says to book the rental car before the long weekend."),
    ]);

    const r = await runAgentCommand(deps(db, deviceId), agent, uid, 'search my notes for rental car', true, {
      conversational: true,
    });
    assert.match(r.reply, /Trip planning/);
    assert.match(r.reply, /rental car/);
    assert.equal(r.executed[0].tool, 'search_notes');
    assert.ok((r.executed[0].result.ok && r.executed[0].result.data) as unknown);
    const data = r.executed[0].result as { ok: true; data: { matches: { title: string; snippet: string; id: string }[] } };
    assert.equal(data.data.matches[0].title, 'Trip planning');
    assert.match(data.data.matches[0].snippet, /«rental car»/);
  });

  test('Telegram-equivalent end-to-end (shared runAgentCommand loop, conversational mode): create note, search its content, convert to a task', async () => {
    // Telegram (telegram.ts) drives the exact same runAgentCommand loop with
    // conversational:true — this exercises that loop directly, which is the documented
    // approach when a real Telegram transport isn't available in the test harness.
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    const agent = makeAgent(db);

    // 1) create a note
    stubLLM([
      toolResp('add_tasks', { tasks: [{ title: 'Camping list', type: 'note', note: 'Tent, stove, torch.' }] }),
      doneResp('Noted!'),
    ]);
    const r1 = await runAgentCommand(deps(db, deviceId), agent, uid, 'make a note: camping list — tent, stove, torch', true, {
      conversational: true,
    });
    assert.match(r1.reply, /Noted/);
    const note = (await import('@carbon/core')).queryItems(db, {}).find((i) => i.title === 'Camping list')!;
    assert.equal(note.type, 'note');

    // 2) search its content
    stubLLM([toolResp('search_notes', { q: 'torch' }), doneResp("Your camping list note mentions a torch.")]);
    const r2 = await runAgentCommand(deps(db, deviceId), agent, uid, 'do my notes mention a torch anywhere', true, {
      conversational: true,
    });
    assert.match(r2.reply, /torch/);

    // 3) convert note -> task
    stubLLM([toolResp('update', { updates: [{ query: 'camping list', patch: { type: 'task' } }] }), doneResp('Done, added as a task.')]);
    const r3 = await runAgentCommand(deps(db, deviceId), agent, uid, 'turn my camping list note into a task', true, {
      conversational: true,
    });
    assert.match(r3.reply, /Done/);
    assert.equal(getItem(db, note.id)?.type, 'task');
    assert.equal(getItem(db, note.id)?.status, 'active'); // was never completed, so restores to active
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

describe('formatNow', () => {
  test('spells out the weekday so the model never derives it from the date', async () => {
    const { formatNow } = await import('./agents');
    const now = new Date('2026-07-06T06:05:00.000Z'); // Monday 16:05 in Melbourne
    assert.equal(formatNow(now, 'Australia/Melbourne'), 'Monday 2026-07-06T16:05:00+10:00 (Australia/Melbourne)');
    assert.equal(formatNow(now, null), 'Monday 2026-07-06T06:05:00.000Z (UTC)');
    // Zone west of UTC where the local weekday differs from the UTC one.
    assert.equal(formatNow(new Date('2026-07-06T02:05:00.000Z'), 'America/Los_Angeles'), 'Sunday 2026-07-05T19:05:00-07:00 (America/Los_Angeles)');
  });
});
