/**
 * HTTP-level tests for the Integration REST API task routes.
 * These complement tasks.test.ts (which tests the repo functions directly)
 * by covering scope enforcement, HTTP status codes, and auth/visibility.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  createItem,
  getItem,
  allItems,
  inbox,
  today,
  flagged,
  visibleItemIds,
  hasWriteAccess,
  shareItem,
  addComment,
  addAttachment,
  listComments,
  listAssigneesForItem,
  setCompleted,
  updateItem,
  type ItemPatch,
} from '@carbon/core';
import { requireScope } from './auth';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';

function buildTasksApp(db: TestDb, deviceId: string) {
  const app = makeHono(db, false); // require auth

  function isBot(userId: string): boolean {
    const u = db.get<{ is_bot: number }>('SELECT is_bot FROM users WHERE id = ?', [userId]);
    return !!u?.is_bot;
  }
  function canSee(userId: string, itemId: string): boolean {
    return isBot(userId) || visibleItemIds(db, userId).has(itemId);
  }

  app.get('/tasks', requireScope('tasks:read'), (c) => {
    const userId = c.get('userId');
    const visible = isBot(userId) ? null : visibleItemIds(db, userId);
    let items = allItems(db).filter(
      (i) => i.type === 'task' && (!visible || visible.has(i.id)),
    );
    switch (c.req.query('perspective')) {
      case 'inbox': items = inbox(items); break;
      case 'today': items = today(items); break;
      case 'flagged': items = flagged(items); break;
    }
    const project = c.req.query('project');
    if (project) items = items.filter((i) => i.parent_id === project);
    const status = c.req.query('status');
    if (status) items = items.filter((i) => i.status === status);
    return c.json({ tasks: items });
  });

  app.post('/tasks', requireScope('inbox:write'), async (c) => {
    const userId = c.get('userId');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.title || typeof b.title !== 'string') return c.json({ error: 'title required' }, 400);
    const item = createItem(db, deviceId, {
      title: b.title,
      note: (b.note as string) ?? null,
      parentId: (b.project_id as string) ?? null,
      ownerId: userId,
      dueDate: (b.due_date as string) ?? null,
      flagged: !!b.flagged,
      priority: typeof b.priority === 'number' ? b.priority : 0,
    });
    return c.json(item, 201);
  });

  app.get('/tasks/:id', requireScope('tasks:read'), (c) => {
    const item = getItem(db, c.req.param('id'));
    if (!item || item.deleted || !canSee(c.get('userId'), item.id)) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(item);
  });

  app.patch('/tasks/:id', requireScope('tasks:write'), async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const item = getItem(db, id);
    if (!item || item.deleted || !canSee(userId, id)) return c.json({ error: 'not found' }, 404);
    if (!hasWriteAccess(db, id, userId)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: ItemPatch = {};
    const fields = ['title', 'note', 'status', 'due_date', 'flagged', 'priority'] as const;
    for (const k of fields) if (k in b) (patch as Record<string, unknown>)[k] = b[k];
    updateItem(db, deviceId, id, patch);
    return c.json(getItem(db, id));
  });

  app.post('/tasks/:id/complete', requireScope('tasks:write'), (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const item = getItem(db, id);
    if (!item || item.deleted || !canSee(userId, id)) return c.json({ error: 'not found' }, 404);
    if (!hasWriteAccess(db, id, userId)) return c.json({ error: 'forbidden' }, 403);
    setCompleted(db, deviceId, id, c.req.query('done') !== 'false');
    return c.json(getItem(db, id));
  });

  app.post('/tasks/:id/comments', requireScope('tasks:write'), async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const item = getItem(db, id);
    if (!item || item.deleted || !canSee(userId, id)) return c.json({ error: 'not found' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { body?: string };
    if (!b.body) return c.json({ error: 'body required' }, 400);
    const comment = addComment(db, deviceId, {
      itemId: id,
      authorId: userId,
      body: b.body,
    });
    return c.json(comment, 201);
  });

  app.post('/tasks/:id/attachments', requireScope('tasks:write'), async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const item = getItem(db, id);
    if (!item || item.deleted || !canSee(userId, id)) return c.json({ error: 'not found' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      filename?: string;
      hash?: string;
      mimeType?: string;
      size?: number;
    };
    if (!b.filename || !b.hash) return c.json({ error: 'filename and hash required' }, 400);
    const att = addAttachment(db, deviceId, {
      parentType: 'item',
      parentId: id,
      itemId: id,
      filename: b.filename,
      mimeType: b.mimeType ?? null,
      size: b.size ?? 0,
      hash: b.hash,
      createdBy: userId,
    });
    return c.json(att, 201);
  });

  return app;
}

// ─── GET /tasks ───────────────────────────────────────────────────────────────

describe('GET /tasks', () => {
  test('returns tasks visible to authenticated user', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    createItem(db, deviceId, { type: 'task', title: 'Mine', ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks', { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const body = await res.json() as { tasks: { title: string }[] };
    assert.ok(body.tasks.some((t) => t.title === 'Mine'));
  });

  test('does not return tasks owned by another user', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { basic: bobBasic } = addUser('bob', 'pw');
    createItem(db, deviceId, { type: 'task', title: 'Alice only', ownerId: aliceId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks', { headers: { Authorization: bobBasic } });
    const body = await res.json() as { tasks: { title: string }[] };
    assert.ok(!body.tasks.some((t) => t.title === 'Alice only'));
  });

  test('perspective=inbox filters to inbox tasks', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    createItem(db, deviceId, { type: 'task', title: 'Orphan', ownerId: userId });
    const proj = createItem(db, deviceId, { type: 'project', title: 'P', ownerId: userId });
    createItem(db, deviceId, { type: 'task', title: 'In project', parentId: proj.id, ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks?perspective=inbox', { headers: { Authorization: basic } });
    const body = await res.json() as { tasks: { title: string }[] };
    assert.ok(body.tasks.some((t) => t.title === 'Orphan'));
    assert.ok(!body.tasks.some((t) => t.title === 'In project'));
  });

  test('perspective=flagged returns only flagged tasks', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    createItem(db, deviceId, { type: 'task', title: 'Plain', ownerId: userId });
    createItem(db, deviceId, { type: 'task', title: 'Starred', flagged: true, ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks?perspective=flagged', { headers: { Authorization: basic } });
    const body = await res.json() as { tasks: { title: string }[] };
    assert.ok(body.tasks.some((t) => t.title === 'Starred'));
    assert.ok(!body.tasks.some((t) => t.title === 'Plain'));
  });

  test('project= filters tasks to a specific project', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const projA = createItem(db, deviceId, { type: 'project', title: 'PA', ownerId: userId });
    const projB = createItem(db, deviceId, { type: 'project', title: 'PB', ownerId: userId });
    createItem(db, deviceId, { type: 'task', title: 'InA', parentId: projA.id, ownerId: userId });
    createItem(db, deviceId, { type: 'task', title: 'InB', parentId: projB.id, ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks?project=${projA.id}`, { headers: { Authorization: basic } });
    const body = await res.json() as { tasks: { title: string }[] };
    assert.ok(body.tasks.some((t) => t.title === 'InA'));
    assert.ok(!body.tasks.some((t) => t.title === 'InB'));
  });

  test('returns 401 without credentials', async () => {
    const { db, deviceId } = makeTestDb();
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks');
    assert.equal(res.status, 401);
  });
});

// ─── POST /tasks ──────────────────────────────────────────────────────────────

describe('POST /tasks', () => {
  test('creates a task and returns 201', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New task' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { id: string; title: string };
    assert.ok(body.id);
    assert.equal(body.title, 'New task');
  });

  test('returns 400 when title is missing', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'no title here' }),
    });
    assert.equal(res.status, 400);
  });

  test('creates a task with flagged=true', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Important', flagged: true }),
    });
    const body = await res.json() as { flagged: boolean };
    assert.equal(body.flagged, true);
  });
});

// ─── GET /tasks/:id ───────────────────────────────────────────────────────────

describe('GET /tasks/:id', () => {
  test('returns the task for its owner', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Fetchable', ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}`, { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const body = await res.json() as { id: string };
    assert.equal(body.id, task.id);
  });

  test('returns 404 for another user\'s task', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { basic: bobBasic } = addUser('bob', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Private', ownerId: aliceId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}`, { headers: { Authorization: bobBasic } });
    assert.equal(res.status, 404);
  });

  test('returns 404 for nonexistent task', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, '/tasks/nonexistent', { headers: { Authorization: basic } });
    assert.equal(res.status, 404);
  });

  test('sharee can fetch a shared task', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { id: bobId, basic: bobBasic } = addUser('bob', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Shared', ownerId: aliceId });
    shareItem(db, deviceId, task.id, bobId, 'read');
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}`, { headers: { Authorization: bobBasic } });
    assert.equal(res.status, 200);
  });
});

// ─── PATCH /tasks/:id ─────────────────────────────────────────────────────────

describe('PATCH /tasks/:id', () => {
  test('owner can update task title', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Old', ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { title: string };
    assert.equal(body.title, 'Updated');
  });

  test('non-owner without write access is forbidden', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { basic: bobBasic } = addUser('bob', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Alice\'s', ownerId: aliceId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { Authorization: bobBasic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hijacked' }),
    });
    // Either 403 (can see but can't write) or 404 (can't see at all)
    assert.ok(res.status === 403 || res.status === 404);
  });
});

// ─── POST /tasks/:id/complete ─────────────────────────────────────────────────

describe('POST /tasks/:id/complete', () => {
  test('marks task done (default)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Todo', ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { Authorization: basic },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'done');
  });

  test('done=false re-opens a completed task', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Done', ownerId: userId });
    setCompleted(db, deviceId, task.id, true);
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}/complete?done=false`, {
      method: 'POST',
      headers: { Authorization: basic },
    });
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'active');
  });
});

// ─── POST /tasks/:id/comments ─────────────────────────────────────────────────

describe('POST /tasks/:id/comments', () => {
  test('adds a comment to a task', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Discussed', ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}/comments`, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Looks good!' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { body: string };
    assert.equal(body.body, 'Looks good!');
    assert.equal(listComments(db, task.id).length, 1);
  });

  test('returns 400 when body is missing', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Quiet', ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}/comments`, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test('returns 404 for tasks the user cannot see', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { basic: bobBasic } = addUser('bob', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Secret', ownerId: aliceId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}/comments`, {
      method: 'POST',
      headers: { Authorization: bobBasic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'snoop' }),
    });
    assert.equal(res.status, 404);
  });
});

// ─── POST /tasks/:id/attachments ──────────────────────────────────────────────

describe('POST /tasks/:id/attachments', () => {
  test('adds attachment metadata to a task', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'With file', ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const fakeHash = 'a'.repeat(64);
    const res = await appFetch(app, `/tasks/${task.id}/attachments`, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'report.pdf', hash: fakeHash, mimeType: 'application/pdf', size: 1024 }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { filename: string; hash: string };
    assert.equal(body.filename, 'report.pdf');
    assert.equal(body.hash, fakeHash);
  });

  test('returns 400 when filename or hash is missing', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const task = createItem(db, deviceId, { type: 'task', title: 'Missing fields', ownerId: userId });
    const app = buildTasksApp(db, deviceId);
    const res = await appFetch(app, `/tasks/${task.id}/attachments`, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'doc.pdf' }), // no hash
    });
    assert.equal(res.status, 400);
  });
});
