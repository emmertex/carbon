import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { mkdirSync } from 'node:fs';
import { createUser, createItem, assignItem, listComments } from '@carbon/core';
import { initTenantDb } from './tenant';
import { createSession, createToken } from './auth';
import { createAgent } from './agents';
import type { DeliverToPeer } from './federation';

/** The human ⇄ agent comment channel on the task REST API: read a thread, the
 *  activity feed agents poll, mention resolution, own-comment edit/delete, and
 *  `?include=` on a single task — through the real tenant app and personal keys. */

const TMP = `/tmp/carbon-task-comments-${process.pid}`;
process.env.DATABASE_PATH = `${TMP}/carbon.db`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.BLOBS_DIR = `${TMP}/blobs`;
process.env.CARBON_NO_AUTOSTART = '1';

const NO_DELIVERY: DeliverToPeer = async () =>
  new Response(JSON.stringify({ error: 'no delivery in test' }), { status: 501 });

let n = 0;
async function setup() {
  const dir = `${TMP}/t${++n}`;
  mkdirSync(dir, { recursive: true });
  const ctx = initTenantDb({ id: `t${n}`, subdomain: `t${n}`, dbPath: `${dir}/carbon.db`, blobsDir: `${TMP}/blobs` });
  const db = ctx.db;
  const ann = createUser(db, { username: 'ann', displayName: 'Ann', role: 'admin' });
  // An API-driven agent: webhook kind with no URL, acting through its own token.
  const agent = createAgent(db, { name: 'Claude', username: 'claude', kind: 'webhook' });
  const project = createItem(db, 'd', { title: 'Work', type: 'project', ownerId: ann.id });
  const task = createItem(db, 'd', { title: 'Write report', ownerId: ann.id, parentId: project.id });
  const sub = createItem(db, 'd', { title: 'Outline', ownerId: ann.id, parentId: task.id });
  assignItem(db, 'd', task.id, agent.user_id);
  const annKey = createToken(db, { userId: ann.id, name: 'k', scopes: ['tasks:read', 'tasks:write'], restOnly: true }).token;
  const scopedKey = createToken(db, { userId: ann.id, name: 's', scopes: ['tasks:read', 'tasks:write'], restOnly: true, projectIds: [project.id] }).token;
  const botKey = createToken(db, { userId: agent.user_id, name: 'b', scopes: ['tasks:read', 'tasks:write'] }).token;
  const app = (await import('./index')).buildTenantApp(ctx, NO_DELIVERY);
  const { appFetch } = await import('./test-app');
  const call = async (key: string, path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await appFetch(app, `/api${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { db, ann, agent, project, task, sub, annKey, scopedKey, botKey, call, session: createSession(db, ann.id) };
}

describe('task comments API', () => {
  test('conversation round-trip between a human key and an agent key', async () => {
    const s = await setup();
    const t = s.task.id;

    // Human asks the agent; @claude is resolved to the bot's id.
    const q = await s.call(s.annKey, `/tasks/${t}/comments`, { method: 'POST', body: { body: '@claude can you draft this?' } });
    assert.equal(q.status, 201);
    assert.equal(q.json.author.username, 'ann');
    assert.deepEqual(q.json.mentions.map((m: any) => m.username), ['claude']);

    // Agent polls its feed and sees the request, with task context; its cursor works.
    const feed = await s.call(s.botKey, '/comments?for=me');
    assert.equal(feed.status, 200);
    assert.equal(feed.json.me.username, 'claude');
    assert.equal(feed.json.comments.length, 1);
    assert.equal(feed.json.comments[0].task.title, 'Write report');
    const cursor = feed.json.cursor;

    // Agent replies, asking ann (explicit mention by username); its own reply is
    // not in its own for=me feed.
    const r = await s.call(s.botKey, `/tasks/${t}/comments`, { method: 'POST', body: { body: 'Draft attached. OK?', mentions: ['ann'] } });
    assert.equal(r.status, 201);
    assert.equal(r.json.author.is_bot, true);
    const again = await s.call(s.botKey, `/comments?for=me&since=${encodeURIComponent(cursor)}`);
    assert.equal(again.json.comments.length, 0);

    // Human sees the reply in the thread and in their feed (they own the task).
    const thread = await s.call(s.annKey, `/tasks/${t}/comments`);
    assert.equal(thread.status, 200);
    assert.deepEqual(thread.json.comments.map((c: any) => c.author.username), ['ann', 'claude']);
    const since = await s.call(s.annKey, `/tasks/${t}/comments?since=${encodeURIComponent(q.json.created_at)}`);
    assert.equal(since.json.comments.length, 1);
    const annFeed = await s.call(s.annKey, '/comments?for=me');
    assert.deepEqual(annFeed.json.comments.map((c: any) => c.author.username), ['claude']);

    // No error comment was posted by the URL-less webhook agent.
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(listComments(s.db, t).length, 2);
  });

  test('edit/delete own comment only; include= embeds context', async () => {
    const s = await setup();
    const t = s.task.id;
    const c = await s.call(s.annKey, `/tasks/${t}/comments`, { method: 'POST', body: { body: 'first' } });
    const id = c.json.id;
    const edit = await s.call(s.annKey, `/tasks/${t}/comments/${id}`, { method: 'PATCH', body: { body: 'first (edited)' } });
    assert.equal(edit.status, 200);
    assert.equal(edit.json.body, 'first (edited)');
    // The bot (assigned) may read but not edit someone else's comment.
    const denied = await s.call(s.botKey, `/tasks/${t}/comments/${id}`, { method: 'PATCH', body: { body: 'x' } });
    assert.equal(denied.status, 403);
    // Scoped personal key reaches the nested route.
    const scoped = await s.call(s.scopedKey, `/tasks/${t}/comments/${id}`, { method: 'PATCH', body: { body: 'second edit' } });
    assert.equal(scoped.status, 200);

    const full = await s.call(s.annKey, `/tasks/${t}?include=all`);
    assert.equal(full.status, 200);
    assert.equal(full.json.comments[0].body, 'second edit');
    assert.deepEqual(full.json.subtasks.map((x: any) => x.title), ['Outline']);
    assert.deepEqual(full.json.assignees.map((x: any) => x.username), ['claude']);
    const plain = await s.call(s.annKey, `/tasks/${t}`);
    assert.equal(plain.json.comments, undefined, 'default shape unchanged');

    const del = await s.call(s.annKey, `/tasks/${t}/comments/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await s.call(s.annKey, `/tasks/${t}/comments`)).json.comments.length, 0);
  });

  test('validation and key boundaries', async () => {
    const s = await setup();
    assert.equal((await s.call(s.annKey, `/tasks/${s.task.id}/comments?since=nope`)).status, 400);
    assert.equal((await s.call(s.annKey, `/tasks/${s.task.id}/comments`, { method: 'POST', body: { body: '  ' } })).status, 400);
    // Personal keys still can't reach other routes such as /me.
    assert.equal((await s.call(s.annKey, '/me')).status, 403);
    // A task outside a scoped key's projects is invisible in its feed.
    const other = createItem(s.db, 'd', { title: 'Elsewhere', ownerId: s.ann.id });
    await s.call(s.annKey, `/tasks/${other.id}/comments`, { method: 'POST', body: { body: 'outside' } });
    await s.call(s.annKey, `/tasks/${s.task.id}/comments`, { method: 'POST', body: { body: 'inside' } });
    const feed = await s.call(s.scopedKey, '/comments');
    assert.deepEqual(feed.json.comments.map((c: any) => c.body), ['inside']);
  });

  test('admin issues a task-API-only key for an agent', async () => {
    const s = await setup();
    const agentId = (s.db.get<{ id: string }>('SELECT id FROM agents WHERE user_id = ?', [s.agent.user_id]))!.id;
    const issued = await s.call(s.session, `/admin/agents/${agentId}/keys`, { method: 'POST' });
    assert.equal(issued.status, 201);
    const key = issued.json.token as string;
    // A personal key (even an admin's) can't mint agent keys.
    assert.equal((await s.call(s.annKey, `/admin/agents/${agentId}/keys`, { method: 'POST' })).status, 403);
    const feed = await s.call(key, '/comments?for=me');
    assert.equal(feed.json.me.username, 'claude');
    assert.equal((await s.call(key, '/me')).status, 403, 'agent key is limited to the task API');
  });
});
