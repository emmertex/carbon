import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import {
  createItem,
  updateItem,
  setItemDepLink,
  getPredecessors,
  getSuccessors,
  depWouldCycle,
  isLineage,
} from './repo';
import { getUnsyncedRecordOps } from './records';
import { ingestRecordOps } from './repo';
import { getUnsyncedOps, ingestOps } from './crdt';
import { getItem } from './repo';
import { isBlocked, isDeferred, availableLeaves } from './availability';

function openMemoryDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const db: Db = {
    run: (sql: string, params: SqlParams = []) => void sqlite.prepare(sql).run(...params),
    all: <T>(sql: string, params: SqlParams = []) => sqlite.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: SqlParams = []) =>
      sqlite.prepare(sql).get(...params) as T | undefined,
    exec: (sql: string) => sqlite.exec(sql),
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const r = fn();
        sqlite.exec('COMMIT');
        return r;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  migrate(db);
  return db;
}

const DEV = 'test-device';

test('parallel project: all children available', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P' }); // default parallel
  const a = createItem(db, DEV, { title: 'A', parentId: p.id });
  const b = createItem(db, DEV, { title: 'B', parentId: p.id });
  assert.equal(isBlocked(db, a.id), false);
  assert.equal(isBlocked(db, b.id), false);
});

test('sequential project gates later siblings until earlier ones complete', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P', orderMode: 'sequential' });
  const a = createItem(db, DEV, { title: 'A', parentId: p.id });
  const b = createItem(db, DEV, { title: 'B', parentId: p.id });
  const c = createItem(db, DEV, { title: 'C', parentId: p.id });

  assert.equal(isBlocked(db, a.id), false, 'first is available');
  assert.equal(isBlocked(db, b.id), true, 'second blocked');
  assert.equal(isBlocked(db, c.id), true, 'third blocked');

  // Complete A -> B unblocks, C still blocked.
  updateItem(db, DEV, a.id, { status: 'done' });
  assert.equal(isBlocked(db, b.id), false);
  assert.equal(isBlocked(db, c.id), true);

  // Dropping B (abandon) also counts as satisfied -> C unblocks.
  updateItem(db, DEV, b.id, { status: 'dropped' });
  assert.equal(isBlocked(db, c.id), false);
});

test('switching back to parallel unblocks everything', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P', orderMode: 'sequential' });
  const a = createItem(db, DEV, { title: 'A', parentId: p.id });
  const b = createItem(db, DEV, { title: 'B', parentId: p.id });
  assert.equal(isBlocked(db, b.id), true);
  updateItem(db, DEV, p.id, { order_mode: 'parallel' });
  assert.equal(isBlocked(db, b.id), false);
  assert.equal(isBlocked(db, a.id), false);
});

test('explicit predecessor blocks then unblocks on completion', () => {
  const db = openMemoryDb();
  const a = createItem(db, DEV, { title: 'A' });
  const b = createItem(db, DEV, { title: 'B' });
  // A blocks B.
  setItemDepLink(db, DEV, a.id, b.id, false);
  assert.equal(isBlocked(db, b.id), true);
  assert.equal(isBlocked(db, a.id), false);
  assert.deepEqual(getPredecessors(db, b.id).map((i) => i.id), [a.id]);
  assert.deepEqual(getSuccessors(db, a.id).map((i) => i.id), [b.id]);

  updateItem(db, DEV, a.id, { status: 'done' });
  assert.equal(isBlocked(db, b.id), false);

  // Tombstoning the edge also unblocks (and removes it from queries).
  updateItem(db, DEV, a.id, { status: 'active' });
  assert.equal(isBlocked(db, b.id), true);
  setItemDepLink(db, DEV, a.id, b.id, true);
  assert.equal(isBlocked(db, b.id), false);
  assert.equal(getPredecessors(db, b.id).length, 0);
});

test('ancestor cascade: blocked container hides its subtree', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P', orderMode: 'sequential' });
  const a = createItem(db, DEV, { title: 'A', parentId: p.id });
  const b = createItem(db, DEV, { title: 'B', parentId: p.id, orderMode: 'parallel' });
  const b1 = createItem(db, DEV, { title: 'B1', parentId: b.id });
  // B is blocked by A (sequential), so B1 cascades to blocked even though B is parallel.
  assert.equal(isBlocked(db, b.id), true);
  assert.equal(isBlocked(db, b1.id), true);
  updateItem(db, DEV, a.id, { status: 'done' });
  assert.equal(isBlocked(db, b.id), false);
  assert.equal(isBlocked(db, b1.id), false);
});

const titles = (items: { title: string }[]) => items.map((i) => i.title);

test('availableLeaves: parallel parent returns all available leaf actions', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P' }); // parallel
  const a = createItem(db, DEV, { title: 'A', parentId: p.id });
  const b = createItem(db, DEV, { title: 'B', parentId: p.id });
  assert.deepEqual(titles(availableLeaves(db, p.id)), ['A', 'B']);
  // A non-leaf parent (B grows children) is skipped in favour of its leaves.
  createItem(db, DEV, { title: 'B1', parentId: b.id });
  assert.deepEqual(titles(availableLeaves(db, p.id)), ['A', 'B1']);
  // Done leaves drop out.
  updateItem(db, DEV, a.id, { status: 'done' });
  assert.deepEqual(titles(availableLeaves(db, p.id)), ['B1']);
});

test('availableLeaves: sequential parent surfaces only the next action', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P', orderMode: 'sequential' });
  createItem(db, DEV, { title: 'A', parentId: p.id });
  createItem(db, DEV, { title: 'B', parentId: p.id });
  createItem(db, DEV, { title: 'C', parentId: p.id });
  assert.deepEqual(titles(availableLeaves(db, p.id)), ['A'], 'only first is available');
  // Completing A advances the next action to B.
  const a = availableLeaves(db, p.id)[0]!;
  updateItem(db, DEV, a.id, { status: 'done' });
  assert.deepEqual(titles(availableLeaves(db, p.id)), ['B']);
});

test('availableLeaves: deferred and blocked leaves are excluded', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P' });
  const a = createItem(db, DEV, { title: 'A', parentId: p.id });
  const b = createItem(db, DEV, { title: 'B', parentId: p.id });
  const c = createItem(db, DEV, { title: 'C', parentId: p.id });
  // Defer B into the future.
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  updateItem(db, DEV, b.id, { defer_date: future });
  assert.equal(isDeferred(db, getItem(db, b.id)!), true);
  // C is blocked by an explicit predecessor A.
  setItemDepLink(db, DEV, a.id, c.id, false);
  assert.deepEqual(titles(availableLeaves(db, p.id)), ['A'], 'B deferred, C blocked');
});

test('availableLeaves: drills into a nested sequential sub-project', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P' }); // parallel
  createItem(db, DEV, { title: 'A', parentId: p.id });
  const g = createItem(db, DEV, { title: 'G', parentId: p.id, orderMode: 'sequential' });
  createItem(db, DEV, { title: 'G1', parentId: g.id });
  createItem(db, DEV, { title: 'G2', parentId: g.id });
  // A is available; inside the sequential sub-project only G1 is, G2 gated.
  assert.deepEqual(titles(availableLeaves(db, p.id)), ['A', 'G1']);
});

test('isDeferred: false for a plain active item, true for a future defer', () => {
  const db = openMemoryDb();
  const a = createItem(db, DEV, { title: 'A' });
  assert.equal(isDeferred(db, getItem(db, a.id)!), false);
  const past = new Date(Date.now() - 1000).toISOString();
  updateItem(db, DEV, a.id, { defer_date: past });
  assert.equal(isDeferred(db, getItem(db, a.id)!), false, 'a past defer is not deferred');
  const future = new Date(Date.now() + 1000).toISOString();
  updateItem(db, DEV, a.id, { defer_date: future });
  assert.equal(isDeferred(db, getItem(db, a.id)!), true);
});

test('depWouldCycle rejects back-edges and self', () => {
  const db = openMemoryDb();
  const a = createItem(db, DEV, { title: 'A' });
  const b = createItem(db, DEV, { title: 'B' });
  const c = createItem(db, DEV, { title: 'C' });
  setItemDepLink(db, DEV, a.id, b.id, false); // A -> B
  setItemDepLink(db, DEV, b.id, c.id, false); // B -> C
  assert.equal(depWouldCycle(db, a.id, a.id), true, 'self');
  assert.equal(depWouldCycle(db, c.id, a.id), true, 'C->A would close A->B->C->A');
  assert.equal(depWouldCycle(db, a.id, c.id), false, 'A->C is a fine shortcut');
});

test('isLineage detects ancestor/descendant relationships', () => {
  const db = openMemoryDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P' });
  const a = createItem(db, DEV, { title: 'A', parentId: p.id });
  const a1 = createItem(db, DEV, { title: 'A1', parentId: a.id });
  const b = createItem(db, DEV, { title: 'B', parentId: p.id });
  assert.equal(isLineage(db, p.id, a1.id), true); // ancestor
  assert.equal(isLineage(db, a1.id, a.id), true); // descendant
  assert.equal(isLineage(db, a.id, b.id), false); // cousins
});

test('order_mode + dependency edge sync to a peer and reproduce blocking', () => {
  const dbA = openMemoryDb();
  const dbB = openMemoryDb();

  const p = createItem(dbA, 'devA', { type: 'project', title: 'P', orderMode: 'sequential' });
  const s1 = createItem(dbA, 'devA', { title: 'S1', parentId: p.id });
  const s2 = createItem(dbA, 'devA', { title: 'S2', parentId: p.id });
  const x = createItem(dbA, 'devA', { title: 'X' });
  setItemDepLink(dbA, 'devA', x.id, s1.id, false); // X blocks S1

  // Replicate everything (field ops for items + record ops for the edge).
  ingestOps(dbB, getUnsyncedOps(dbA), true);
  const depOps = getUnsyncedRecordOps(dbA).filter((o) => o.entity === 'item_dep');
  assert.equal(depOps.length, 1);
  ingestRecordOps(dbB, getUnsyncedRecordOps(dbA), true);

  // The peer now sees the sequential order_mode and the dependency.
  assert.equal(isBlocked(dbB, s1.id), true, 'S1 blocked by X on peer');
  assert.equal(isBlocked(dbB, s2.id), true, 'S2 blocked by sequential gating on peer');
  assert.deepEqual(getPredecessors(dbB, s1.id).map((i) => i.title), ['X']);

  // Re-ingest is idempotent.
  const before = getUnsyncedRecordOps(dbB).length;
  ingestRecordOps(dbB, depOps, true);
  assert.equal(getUnsyncedRecordOps(dbB).length, before, 're-ingest adds nothing');
});
