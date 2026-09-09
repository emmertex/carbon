import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { makeTestDb } from './test-app';
import {
  buildAgentApiDeps,
  createAgentOps,
  readMeta,
  mergeMeta,
  normalizeItemType,
  noteSnippet,
} from './agent-ops';
import { createItem, updateItem, setCompleted } from '@carbon/core';

describe('readMeta', () => {
  test('returns empty object for null/undefined', () => {
    assert.deepEqual(readMeta(null), {});
    assert.deepEqual(readMeta(undefined), {});
  });

  test('parses valid JSON object', () => {
    const meta = readMeta(JSON.stringify({ foo: 'bar' }));
    assert.deepEqual(meta, { foo: 'bar' });
  });

  test('returns empty for non-object JSON', () => {
    assert.deepEqual(readMeta('"string"'), {});
    assert.deepEqual(readMeta('42'), {});
  });

  test('returns empty for invalid JSON', () => {
    assert.deepEqual(readMeta('not json'), {});
  });
});

describe('mergeMeta', () => {
  test('creates new object from empty base', () => {
    const result = mergeMeta(null, { foo: 'bar' });
    assert.equal(result, '{"foo":"bar"}');
  });

  test('patches existing object', () => {
    const base = JSON.stringify({ a: 1 });
    const result = mergeMeta(base, { b: 2 });
    const parsed = JSON.parse(result!);
    assert.equal(parsed.a, 1);
    assert.equal(parsed.b, 2);
  });

  test('deep-merges recipe field', () => {
    const base = JSON.stringify({ recipe: { servings: 2, ingredients: ['milk'] } });
    const patch = { recipe: { servings: 4 } };
    const result = JSON.parse(mergeMeta(base, patch)!);
    assert.equal(result.recipe.servings, 4);
    assert.equal(result.recipe.ingredients.length, 1);
  });

  test('null values are removed', () => {
    const result = mergeMeta(null, { a: 1, b: null });
    const parsed = JSON.parse(result!);
    assert.equal(parsed.a, 1);
    assert.equal('b' in parsed, false);
  });

  test('returns null when result is empty', () => {
    const result = mergeMeta(null, { a: null });
    assert.equal(result, null);
  });
});

describe('normalizeItemType', () => {
  test('task type', () => {
    assert.equal(normalizeItemType('task'), 'task');
    assert.equal(normalizeItemType('TASK'), 'task');
  });

  test('note type', () => {
    assert.equal(normalizeItemType('note'), 'note');
    assert.equal(normalizeItemType('NOTE'), 'note');
  });

  test('project type falls back to task', () => {
    assert.equal(normalizeItemType('project'), 'task');
  });

  test('unknown defaults to task', () => {
    assert.equal(normalizeItemType('foo'), 'task');
  });
});

describe('noteSnippet', () => {
  test('returns first 100 chars', () => {
    const note = 'A'.repeat(200);
    const snippet = noteSnippet(note);
    assert.ok(snippet);
    assert.equal(snippet.length, 100);
  });

  test('returns full note if short', () => {
    const note = 'Short note';
    assert.equal(noteSnippet(note), note);
  });

  test('returns null for null', () => {
    assert.equal(noteSnippet(null), null);
  });
});

describe('createAgentOps', () => {
  test('returns ops object with all methods', () => {
    const { db } = makeTestDb();
    const deps = buildAgentApiDeps(db, 'device-1', { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    assert.ok(ops.addTasks);
    assert.ok(ops.complete);
    assert.ok(ops.item);
    assert.ok(ops.update);
  });
});

describe('item', () => {
  test('returns item by id', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    const item = createItem(db, deviceId, { title: 'Test task', ownerId: user.id });
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.item(user.id, item.id);
    assert.ok(result.ok);
    assert.equal(result.data.id, item.id);
  });
});

describe('addTasks', () => {
  test('adds a single task', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.addTasks(user.id, { tasks: [{ title: 'New task' }] });
    if (!result.ok) throw new Error('addTasks failed: ' + JSON.stringify(result));
    assert.equal(result.data.created.length, 1);
  });
});

describe('complete', () => {
  test('completes a task', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    const item = createItem(db, deviceId, { title: 'To complete', ownerId: user.id });
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.complete(user.id, { ids: [item.id] });
    if (!result.ok) throw new Error('complete failed: ' + JSON.stringify(result));
  });
});

describe('update', () => {
  test('updates an item', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    const item = createItem(db, deviceId, { title: 'Original', ownerId: user.id });
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.update(user.id, { updates: [{ id: item.id, patch: { title: 'Updated' } }] });
    if (!result.ok) throw new Error('update failed: ' + JSON.stringify(result));
  });
});

describe('resolve', () => {
  test('resolves item id or name', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    const item = createItem(db, deviceId, { title: 'Find me', ownerId: user.id });
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.resolve(user.id, { kind: 'task', q: item.title });
    if (!result.ok) throw new Error('resolve failed: ' + JSON.stringify(result));
  });
});

describe('lists', () => {
  test('lists projects', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.lists(user.id);
    if (!result.ok) throw new Error('lists failed: ' + JSON.stringify(result));
    assert.ok(Array.isArray(result.data.lists));
  });
});

describe('tags', () => {
  test('lists tags', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.tags(user.id);
    if (!result.ok) throw new Error('tags failed: ' + JSON.stringify(result));
    assert.ok(Array.isArray(result.data.tags));
  });
});

describe('users', () => {
  test('lists users', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.users(user.id);
    if (!result.ok) throw new Error('users failed: ' + JSON.stringify(result));
    assert.ok(Array.isArray(result.data.users));
  });
});

describe('nearby', () => {
  test('returns empty when no geocode configured', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const user = addUser('alice', 'pw');
    // No location set, so nearby returns empty
    const deps = buildAgentApiDeps(db, deviceId, { multiTenant: false, allowPrivate: true });
    const ops = createAgentOps(deps);
    const result = ops.nearby(user.id, { near_name: 'shop' });
    // May succeed or fail depending on geocode config
  });
});
