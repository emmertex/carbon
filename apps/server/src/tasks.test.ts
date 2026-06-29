import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  createItem,
  getItem,
  updateItem,
  setCompleted,
  allItems,
  inbox,
  today,
  flagged,
  getChildren,
  addComment,
  listComments,
  visibleItemIds,
  shareItem,
  hasWriteAccess,
} from '@carbon/core';
import { makeTestDb } from './test-app';

const DEV = 'test-device';

// ─── basic CRUD ──────────────────────────────────────────────────────────────

describe('task CRUD', () => {
  test('createItem returns a task with defaults', () => {
    const { db } = makeTestDb();
    const task = createItem(db, DEV, { type: 'task', title: 'Write tests' });
    assert.equal(task.type, 'task');
    assert.equal(task.title, 'Write tests');
    assert.equal(task.status, 'active');
    assert.equal(task.flagged, false);
    assert.equal(task.deleted, false);
  });

  test('getItem returns the created item', () => {
    const { db } = makeTestDb();
    const task = createItem(db, DEV, { type: 'task', title: 'Get me' });
    const fetched = getItem(db, task.id);
    assert.ok(fetched);
    assert.equal(fetched.id, task.id);
    assert.equal(fetched.title, 'Get me');
  });

  test('getItem returns undefined for unknown id', () => {
    const { db } = makeTestDb();
    assert.equal(getItem(db, 'nonexistent'), undefined);
  });

  test('updateItem mutates title and flagged', () => {
    const { db } = makeTestDb();
    const task = createItem(db, DEV, { type: 'task', title: 'Old' });
    updateItem(db, DEV, task.id, { title: 'New', flagged: true });
    const updated = getItem(db, task.id)!;
    assert.equal(updated.title, 'New');
    assert.equal(updated.flagged, true);
  });

  test('setCompleted marks task done and undone', () => {
    const { db } = makeTestDb();
    const task = createItem(db, DEV, { type: 'task', title: 'Do me' });
    setCompleted(db, DEV, task.id, true);
    assert.equal(getItem(db, task.id)!.status, 'done');
    setCompleted(db, DEV, task.id, false);
    assert.equal(getItem(db, task.id)!.status, 'active');
  });

  test('project can contain tasks as children', () => {
    const { db } = makeTestDb();
    const project = createItem(db, DEV, { type: 'project', title: 'P1' });
    const task = createItem(db, DEV, { type: 'task', title: 'T1', parentId: project.id });
    const children = getChildren(db, project.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.id, task.id);
  });
});

// ─── perspectives ────────────────────────────────────────────────────────────

describe('inbox perspective', () => {
  test('returns tasks with no parent', () => {
    const { db } = makeTestDb();
    createItem(db, DEV, { type: 'task', title: 'Orphan' });
    const project = createItem(db, DEV, { type: 'project', title: 'P' });
    createItem(db, DEV, { type: 'task', title: 'In project', parentId: project.id });
    const items = inbox(allItems(db));
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, 'Orphan');
  });

  test('excludes completed tasks from inbox', () => {
    const { db } = makeTestDb();
    const t = createItem(db, DEV, { type: 'task', title: 'Done' });
    setCompleted(db, DEV, t.id, true);
    assert.equal(inbox(allItems(db)).length, 0);
  });
});

describe('today perspective', () => {
  test('includes flagged tasks', () => {
    const { db } = makeTestDb();
    createItem(db, DEV, { type: 'task', title: 'Flagged', flagged: true });
    const items = today(allItems(db));
    assert.ok(items.some((i) => i.title === 'Flagged'));
  });

  test('includes tasks due today or earlier', () => {
    const { db } = makeTestDb();
    const past = new Date();
    past.setDate(past.getDate() - 1);
    past.setHours(12, 0, 0, 0);
    createItem(db, DEV, { type: 'task', title: 'Overdue', dueDate: past.toISOString() });
    const items = today(allItems(db));
    assert.ok(items.some((i) => i.title === 'Overdue'));
  });

  test('excludes tasks with future due dates', () => {
    const { db } = makeTestDb();
    const future = new Date();
    future.setDate(future.getDate() + 7);
    createItem(db, DEV, { type: 'task', title: 'Future', dueDate: future.toISOString() });
    const items = today(allItems(db));
    assert.equal(items.filter((i) => i.title === 'Future').length, 0);
  });
});

describe('flagged perspective', () => {
  test('returns only flagged tasks', () => {
    const { db } = makeTestDb();
    createItem(db, DEV, { type: 'task', title: 'Plain' });
    createItem(db, DEV, { type: 'task', title: 'Starred', flagged: true });
    const items = flagged(allItems(db));
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, 'Starred');
  });
});

// ─── visibility / sharing ────────────────────────────────────────────────────

describe('visibility scoping', () => {
  test('owner can see their own item', () => {
    const { db, addUser } = makeTestDb();
    const { id: userId } = addUser('alice', 'pw');
    const task = createItem(db, DEV, { type: 'task', title: 'Mine', ownerId: userId });
    const visible = visibleItemIds(db, userId);
    assert.ok(visible.has(task.id));
  });

  test('another user cannot see an unshared item', () => {
    const { db, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { id: bobId } = addUser('bob', 'pw');
    const task = createItem(db, DEV, { type: 'task', title: 'Private', ownerId: aliceId });
    const visible = visibleItemIds(db, bobId);
    assert.ok(!visible.has(task.id));
  });

  test('shared item is visible to the sharee', () => {
    const { db, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { id: bobId } = addUser('bob', 'pw');
    const task = createItem(db, DEV, { type: 'task', title: 'Shared', ownerId: aliceId });
    shareItem(db, DEV, task.id, bobId, 'read');
    const visible = visibleItemIds(db, bobId);
    assert.ok(visible.has(task.id));
  });

  test('hasWriteAccess respects share level', () => {
    const { db, addUser } = makeTestDb();
    const { id: aliceId } = addUser('alice', 'pw');
    const { id: bobId } = addUser('bob', 'pw');
    const task = createItem(db, DEV, { type: 'task', title: 'ReadOnly', ownerId: aliceId });
    shareItem(db, DEV, task.id, bobId, 'read');
    assert.ok(!hasWriteAccess(db, task.id, bobId), 'read share → no write');
    shareItem(db, DEV, task.id, bobId, 'write');
    assert.ok(hasWriteAccess(db, task.id, bobId), 'write share → has write');
  });
});

// ─── comments ────────────────────────────────────────────────────────────────

describe('comments', () => {
  test('addComment / listComments round-trip', () => {
    const { db, addUser } = makeTestDb();
    const { id: userId } = addUser('alice', 'pw');
    const task = createItem(db, DEV, { type: 'task', title: 'Discussed', ownerId: userId });
    addComment(db, DEV, { itemId: task.id, authorId: userId, body: 'Hello!' });
    const comments = listComments(db, task.id);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.body, 'Hello!');
    assert.equal(comments[0]!.author_id, userId);
  });
});
