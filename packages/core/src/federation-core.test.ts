/**
 * Core-side federation Phase-1 tests: the extracted `subtreeIds` BFS walk, and a
 * federation shadow user (`is_remote=1`) round-tripping through the roster
 * projection + resolving a share that references it. No transport here — this
 * verifies the shared traversal helper and the synced shadow-user model only.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  createItem,
  createUser,
  upsertUser,
  getUser,
  listUsers,
  shareItem,
  effectiveShares,
  subtreeIds,
  visibleItemIds,
  type User,
} from './index';
import { openMemoryDb } from './test-helpers';

const DEVICE = 'dev-core-fed';

describe('subtreeIds', () => {
  test('returns roots + all descendants (nested), and no unrelated items', () => {
    const db = openMemoryDb();
    const project = createItem(db, DEVICE, { type: 'project', title: 'P' });
    const top = createItem(db, DEVICE, { title: 'top', parentId: project.id });
    const sub = createItem(db, DEVICE, { title: 'sub', parentId: top.id });
    const subSub = createItem(db, DEVICE, { title: 'subsub', parentId: sub.id });
    // An unrelated tree that must NOT be pulled in.
    const other = createItem(db, DEVICE, { type: 'project', title: 'other' });
    const otherChild = createItem(db, DEVICE, { title: 'oc', parentId: other.id });

    const ids = subtreeIds(db, [project.id]);
    assert.deepEqual(
      [...ids].sort(),
      [project.id, top.id, sub.id, subSub.id].sort(),
    );
    assert.ok(!ids.has(other.id));
    assert.ok(!ids.has(otherChild.id));
  });

  test('includes the roots themselves even when they are leaves', () => {
    const db = openMemoryDb();
    const leaf = createItem(db, DEVICE, { title: 'leaf' });
    const ids = subtreeIds(db, [leaf.id]);
    assert.deepEqual([...ids], [leaf.id]);
  });

  test('multiple roots union their subtrees', () => {
    const db = openMemoryDb();
    const a = createItem(db, DEVICE, { type: 'project', title: 'A' });
    const aChild = createItem(db, DEVICE, { title: 'ac', parentId: a.id });
    const b = createItem(db, DEVICE, { type: 'project', title: 'B' });
    const bChild = createItem(db, DEVICE, { title: 'bc', parentId: b.id });

    const ids = subtreeIds(db, [a.id, b.id]);
    assert.deepEqual([...ids].sort(), [a.id, aChild.id, b.id, bChild.id].sort());
  });

  test('empty roots → empty set', () => {
    const db = openMemoryDb();
    createItem(db, DEVICE, { title: 'x' });
    assert.equal(subtreeIds(db, []).size, 0);
  });

  test('a level wider than the internal batch size is still fully gathered', () => {
    // Exercises the chunked `IN (...)` level-batching: a frontier wider than the
    // batch size must not silently drop its tail. Every child gets a grandchild
    // because SQL row order (and so chunk membership) is unspecified — only full
    // coverage guarantees a dropped frontier chunk would actually lose
    // descendants rather than just re-query nothing.
    const db = openMemoryDb();
    const project = createItem(db, DEVICE, { type: 'project', title: 'Wide' });
    const children = Array.from({ length: 620 }, (_, i) =>
      createItem(db, DEVICE, { title: `c${i}`, parentId: project.id }),
    );
    const grandkids = children.map((c, i) =>
      createItem(db, DEVICE, { title: `g${i}`, parentId: c.id }),
    );
    const ids = subtreeIds(db, [project.id]);
    assert.equal(ids.size, 1 + children.length + grandkids.length);
    for (const c of children) assert.ok(ids.has(c.id));
    for (const g of grandkids) assert.ok(ids.has(g.id));
  });

  test('visibleItemIds is unchanged by the refactor (owner items + shared subtree)', () => {
    const db = openMemoryDb();
    const alice = createUser(db, { username: 'alice' });
    const bob = createUser(db, { username: 'bob' });
    // Alice owns a project subtree; she shares the project with Bob.
    const project = createItem(db, DEVICE, { type: 'project', title: 'Roadmap', ownerId: alice.id });
    const task = createItem(db, DEVICE, { title: 't', parentId: project.id, ownerId: alice.id });
    const deep = createItem(db, DEVICE, { title: 'deep', parentId: task.id, ownerId: alice.id });
    // Bob owns his own unrelated item.
    const bobItem = createItem(db, DEVICE, { title: 'bob-own', ownerId: bob.id });
    shareItem(db, DEVICE, project.id, bob.id, 'read');

    const vis = visibleItemIds(db, bob.id);
    // Bob sees his own item + the whole shared subtree.
    assert.ok(vis.has(bobItem.id));
    assert.ok(vis.has(project.id));
    assert.ok(vis.has(task.id));
    assert.ok(vis.has(deep.id));
    // The shared subtree equals subtreeIds(project) ∪ bob's own items.
    for (const id of subtreeIds(db, [project.id])) assert.ok(vis.has(id));
  });
});

describe('shadow user (is_remote) round-trip', () => {
  test('a synced users row with is_remote=1 round-trips through the roster projection', () => {
    const db = openMemoryDb();
    const now = new Date().toISOString();
    const shadow: User = {
      id: 'remote:globex:alice',
      username: 'alice@globex',
      display_name: 'Alice (globex)',
      role: 'member',
      is_bot: false,
      avatar_color: null,
      avatar_initial: null,
      plan_startup_min: null,
      plan_default_estimate_min: null,
      is_remote: true,
      home_server: 'globex',
      created_at: now,
      updated_at: now,
      deleted: false,
    };
    upsertUser(db, shadow);

    const fetched = getUser(db, shadow.id);
    assert.ok(fetched);
    assert.equal(fetched!.is_remote, true);
    assert.equal(fetched!.home_server, 'globex');

    // The roster projection (listUsers → rowToUser) carries the fields.
    const roster = listUsers(db);
    const inRoster = roster.find((u) => u.id === shadow.id);
    assert.ok(inRoster, 'shadow user appears in the roster');
    assert.equal(inRoster!.is_remote, true);
    assert.equal(inRoster!.home_server, 'globex');
  });

  test('a share referencing a shadow user resolves', () => {
    const db = openMemoryDb();
    const now = new Date().toISOString();
    const owner = createUser(db, { username: 'owner' });
    const shadow: User = {
      id: 'remote:globex:alice',
      username: 'alice@globex',
      display_name: 'Alice',
      role: 'member',
      is_bot: false,
      avatar_color: null,
      avatar_initial: null,
      plan_startup_min: null,
      plan_default_estimate_min: null,
      is_remote: true,
      home_server: 'globex',
      created_at: now,
      updated_at: now,
      deleted: false,
    };
    upsertUser(db, shadow);

    const project = createItem(db, DEVICE, { type: 'project', title: 'Shared', ownerId: owner.id });
    shareItem(db, DEVICE, project.id, shadow.id, 'write');

    const shares = effectiveShares(db, project.id);
    const s = shares.find((x) => x.user_id === shadow.id);
    assert.ok(s, 'the shadow user has an effective share');
    assert.equal(s!.permission, 'write');
    // The referenced user resolves to a real (remote) roster row.
    assert.equal(getUser(db, s!.user_id)?.is_remote, true);
  });
});
