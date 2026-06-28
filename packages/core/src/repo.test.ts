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
