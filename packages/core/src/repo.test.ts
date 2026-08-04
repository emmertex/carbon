import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import {
  createItem,
  updateItem,
  setCompleted,
  createTag,
  setItemTagLink,
  getItem,
  getItemTags,
  inheritedPriority,
  projectAncestor,
  completedBefore,
  purgeCompleted,
  createUser,
  shareItem,
  assignItem,
  listSharesForItem,
  listAssigneesForItem,
  visibleItemIds,
} from './repo';

// Minimal in-memory Db backed by node:sqlite (mirrors apps/server/src/sqlite.ts).
function openMemoryDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const db: Db = {
    run(sql: string, params: SqlParams = []): void {
      sqlite.prepare(sql).run(...params);
    },
    all<T>(sql: string, params: SqlParams = []): T[] {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: SqlParams = []): T | undefined {
      return sqlite.prepare(sql).get(...params) as T | undefined;
    },
    exec(sql: string): void {
      sqlite.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const result = fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  migrate(db);
  return db;
}

const DEVICE = 'test-device';
const DAILY = JSON.stringify({ type: 'daily', interval: 1 });

/** A due date safely in the future. A 'scheduled' recurrence advances to the first
 *  occurrence *after now*, so a past due date would roll forward by however many
 *  days have elapsed — making any hard-coded expectation a time-bomb. Anchoring in
 *  the future keeps the next occurrence at exactly +1 interval whatever day the
 *  test runs. */
function futureDue(daysAhead = 5): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setMilliseconds(0);
  return d;
}
/** Next calendar day, mirroring the recurrence engine's addDays (setDate-based). */
function nextDay(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + 1);
  return x;
}

test('projectAncestor resolves the nearest project up the parent chain', () => {
  const db = openMemoryDb();
  const project = createItem(db, DEVICE, { type: 'project', title: 'P' });
  const top = createItem(db, DEVICE, { title: 'top', parentId: project.id });
  const sub = createItem(db, DEVICE, { title: 'sub', parentId: top.id });
  const subSub = createItem(db, DEVICE, { title: 'subsub', parentId: sub.id });

  // Root-level task: parent is the project itself.
  assert.equal(projectAncestor(db, top.id)?.id, project.id);
  // Nested subtasks: walk up past intermediate tasks to the project.
  assert.equal(projectAncestor(db, sub.id)?.id, project.id);
  assert.equal(projectAncestor(db, subSub.id)?.id, project.id);
  // Inbox task (no project ancestor) resolves to undefined.
  const inbox = createItem(db, DEVICE, { title: 'inbox' });
  const inboxSub = createItem(db, DEVICE, { title: 'inboxsub', parentId: inbox.id });
  assert.equal(projectAncestor(db, inbox.id), undefined);
  assert.equal(projectAncestor(db, inboxSub.id), undefined);
});

test('setCompleted carries estimate, geo, and tags onto the spawned recurrence', () => {
  const db = openMemoryDb();

  const geo = JSON.stringify({ lat: -37.81, lng: 144.96, radius: 100, label: 'Office' });
  const due = futureDue();
  const original = createItem(db, DEVICE, {
    title: 'Water the plants',
    dueDate: due.toISOString(),
  });
  // Fields createItem() doesn't accept are set via patches, as the app does.
  updateItem(db, DEVICE, original.id, {
    recurrence: DAILY,
    estimate_minutes: 15,
    geo,
  });
  const tag = createTag(db, DEVICE, 'home');
  setItemTagLink(db, DEVICE, original.id, tag.id, false);

  const { item, spawned } = setCompleted(db, DEVICE, original.id, true);

  // Original is completed.
  assert.equal(item?.status, 'done');
  assert.ok(item?.completed_at);

  // A next occurrence was spawned, active, with the recurrence preserved.
  assert.ok(spawned, 'expected a spawned next occurrence');
  assert.equal(spawned.status, 'active');
  assert.equal(spawned.recurrence, DAILY);
  assert.equal(spawned.due_date, nextDay(due).toISOString());

  // The effort estimate and geofence carry over.
  assert.equal(spawned.estimate_minutes, 15);
  assert.equal(spawned.geo, geo);

  // The item_tags link is copied onto the new occurrence.
  const spawnedTags = getItemTags(db, spawned.id).map((t) => t.id);
  assert.deepEqual(spawnedTags, [tag.id]);
});

test('setCompleted copies shares and assignees onto the spawned recurrence', () => {
  const db = openMemoryDb();
  const alice = createUser(db, { username: 'alice' });
  const bob = createUser(db, { username: 'bob' });
  const due = futureDue();
  const original = createItem(db, DEVICE, {
    title: 'Shared chore',
    ownerId: alice.id,
    dueDate: due.toISOString(),
  });
  updateItem(db, DEVICE, original.id, { recurrence: DAILY });
  shareItem(db, DEVICE, original.id, bob.id, 'write');
  assignItem(db, DEVICE, original.id, bob.id);

  const { item, spawned } = setCompleted(db, DEVICE, original.id, true);
  assert.equal(item?.status, 'done');
  assert.ok(spawned, 'expected a spawned next occurrence');

  const shares = listSharesForItem(db, spawned.id);
  assert.equal(shares.length, 1);
  assert.equal(shares[0]!.user_id, bob.id);
  assert.equal(shares[0]!.permission, 'write');
  const assignees = listAssigneesForItem(db, spawned.id);
  assert.equal(assignees.length, 1);
  assert.equal(assignees[0]!.user_id, bob.id);
  // Collaborator still sees the next occurrence (direct share, not via a parent).
  assert.ok(visibleItemIds(db, bob.id).has(spawned.id));
});

test('setCompleted shifts reminder_at to keep its offset relative to the new due', () => {
  const db = openMemoryDb();

  const due = futureDue();
  const reminder = new Date(due.getTime() - 3_600_000); // one hour before due
  const original = createItem(db, DEVICE, {
    title: 'Pay rent',
    dueDate: due.toISOString(),
  });
  updateItem(db, DEVICE, original.id, {
    recurrence: DAILY,
    reminder_at: reminder.toISOString(),
  });

  const { spawned } = setCompleted(db, DEVICE, original.id, true);

  assert.ok(spawned);
  // Due moved +1 day; the reminder keeps the same one-hour-before offset.
  const nextDue = nextDay(due);
  assert.equal(spawned.due_date, nextDue.toISOString());
  assert.equal(spawned.reminder_at, new Date(nextDue.getTime() - 3_600_000).toISOString());
});

test('setCompleted on a non-recurring task spawns nothing', () => {
  const db = openMemoryDb();
  const t = createItem(db, DEVICE, { title: 'one-off' });
  const { item, spawned } = setCompleted(db, DEVICE, t.id, true);
  assert.equal(item?.status, 'done');
  assert.equal(spawned, undefined);
  assert.equal(getItem(db, t.id)?.status, 'done');
});

test('completedBefore/purgeCompleted: scoped by owner (including null for unowned/local), age, and status', () => {
  const db = openMemoryDb();
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Unowned (owner_id NULL) — the single-user, no-account, offline-only case.
  const oldUnowned = createItem(db, DEVICE, { title: 'old unowned' });
  updateItem(db, DEVICE, oldUnowned.id, { status: 'done', completed_at: old });
  const recentUnowned = createItem(db, DEVICE, { title: 'recent unowned' });
  updateItem(db, DEVICE, recentUnowned.id, { status: 'done', completed_at: recent });
  const stillActiveUnowned = createItem(db, DEVICE, { title: 'active unowned' });

  // Owned by a real user — must not leak into the null-owner query, or vice versa.
  const oldOwned = createItem(db, DEVICE, { title: 'old owned', ownerId: 'alice' });
  updateItem(db, DEVICE, oldOwned.id, { status: 'done', completed_at: old });

  const unownedDue = completedBefore(db, null, cutoff);
  assert.deepEqual(unownedDue.map((i) => i.id).sort(), [oldUnowned.id].sort());

  const aliceDue = completedBefore(db, 'alice', cutoff);
  assert.deepEqual(aliceDue.map((i) => i.id), [oldOwned.id]);

  const purged = purgeCompleted(db, DEVICE, null, cutoff);
  assert.equal(purged, 1);
  assert.equal(getItem(db, oldUnowned.id)?.deleted, true);
  // Untouched: too recent, still active, or owned by someone else.
  assert.equal(getItem(db, recentUnowned.id)?.deleted, false);
  assert.equal(getItem(db, stillActiveUnowned.id)?.deleted, false);
  assert.equal(getItem(db, oldOwned.id)?.deleted, false);
  // Re-querying finds nothing left to purge for this owner.
  assert.equal(completedBefore(db, null, cutoff).length, 0);
});

test('completedBefore/purgeCompleted: cascade safety — a completed parent only qualifies once its whole live subtree does', () => {
  const db = openMemoryDb();
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Old-done parent with a still-active child: purging it would cascade onto
  // live work, so it must be held back entirely.
  const heldParent = createItem(db, DEVICE, { type: 'project', title: 'held' });
  updateItem(db, DEVICE, heldParent.id, { status: 'done', completed_at: old });
  const activeChild = createItem(db, DEVICE, { title: 'active child', parentId: heldParent.id });

  // Old-done parent with a too-recently-done child: also held.
  const recentParent = createItem(db, DEVICE, { type: 'project', title: 'recentish' });
  updateItem(db, DEVICE, recentParent.id, { status: 'done', completed_at: old });
  const recentChild = createItem(db, DEVICE, { title: 'recent child', parentId: recentParent.id });
  updateItem(db, DEVICE, recentChild.id, { status: 'done', completed_at: recent });

  // Old-done child under an ACTIVE parent: the child itself is purgeable — the
  // common "finished task inside an ongoing project" case.
  const liveProject = createItem(db, DEVICE, { type: 'project', title: 'ongoing' });
  const doneLeaf = createItem(db, DEVICE, { title: 'done leaf', parentId: liveProject.id });
  updateItem(db, DEVICE, doneLeaf.id, { status: 'done', completed_at: old });

  // Fully old-done subtree: parent and child both qualify, and the purge must
  // record exactly one tombstone op per item (the nested candidate is covered
  // by its ancestor's cascade, not deleted a second time).
  const doneParent = createItem(db, DEVICE, { type: 'project', title: 'all done' });
  updateItem(db, DEVICE, doneParent.id, { status: 'done', completed_at: old });
  const doneChild = createItem(db, DEVICE, { title: 'done child', parentId: doneParent.id });
  updateItem(db, DEVICE, doneChild.id, { status: 'done', completed_at: old });

  const due = completedBefore(db, null, cutoff);
  assert.deepEqual(
    due.map((i) => i.id).sort(),
    [doneLeaf.id, doneParent.id, doneChild.id].sort(),
  );

  const opsBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n;
  const purged = purgeCompleted(db, DEVICE, null, cutoff);
  assert.equal(purged, 3);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n - opsBefore, 3);

  assert.equal(getItem(db, doneLeaf.id)?.deleted, true);
  assert.equal(getItem(db, doneParent.id)?.deleted, true);
  assert.equal(getItem(db, doneChild.id)?.deleted, true);
  // Held subtrees and live containers are untouched.
  assert.equal(getItem(db, heldParent.id)?.deleted, false);
  assert.equal(getItem(db, activeChild.id)?.deleted, false);
  assert.equal(getItem(db, recentParent.id)?.deleted, false);
  assert.equal(getItem(db, recentChild.id)?.deleted, false);
  assert.equal(getItem(db, liveProject.id)?.deleted, false);
});

test('inheritedPriority: own priority wins, else inherits nearest ancestor task priority', () => {
  const db = openMemoryDb();
  const project = createItem(db, DEVICE, { type: 'project', title: 'P', color: '#ec4899' });
  const high = createItem(db, DEVICE, { title: 'high', parentId: project.id, priority: 3 });
  const plain = createItem(db, DEVICE, { title: 'plain', parentId: project.id });
  const subOfHigh = createItem(db, DEVICE, { title: 'sub', parentId: high.id });

  // Own priority always wins.
  assert.equal(inheritedPriority(db, getItem(db, high.id)!), 3);
  // A coloured project does NOT pass its colour/priority down → grey (0).
  assert.equal(inheritedPriority(db, getItem(db, plain.id)!), 0);
  // Unprioritised child of a prioritised task inherits that priority (nearest wins).
  assert.equal(inheritedPriority(db, getItem(db, subOfHigh.id)!), 3);
  // A task's own priority overrides an inherited one.
  const subOwn = createItem(db, DEVICE, { title: 'own', parentId: high.id, priority: 1 });
  assert.equal(inheritedPriority(db, getItem(db, subOwn.id)!), 1);
});
