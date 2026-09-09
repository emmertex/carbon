import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  getSchemaVersion,
  migrate,
  getItem,
  ingestOps,
  type Db,
  type Op,
} from '@carbon/core';

/**
 * Sync-cursor preservation across schema migrations (A4). The sync cursors are
 * `ops.rowid` / `record_ops.rowid` high-waters. Two migrations (v15, v20) rebuild the
 * `items` table (DROP + rename), which renumbers `items.rowid` — but they do NOT touch
 * `ops` or `record_ops`, so the cursor basis must stay put. This test builds a DB at an
 * OLD schema version (v14, before both rebuilds), records the ops/record_ops rowids,
 * migrates forward across both rebuilds, and asserts:
 *   1. ops / record_ops rowids are unchanged (the cursor basis is preserved);
 *   2. the pre-migration cursor is still valid (a pull past it re-fetches nothing);
 *   3. mixed-version convergence: the old-version ops materialize correctly on the
 *      new schema (a pre-migration peer and a post-migration peer converge).
 */

/** Build an in-memory Db at a specific schema version (runs migrations 1..version). */
function dbAtVersion(version: number): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const db: Db = {
    run: (sql: string, params = []) => {
      sqlite.prepare(sql).run(...(params as (string | number | null)[]));
    },
    all: <T>(sql: string, params = []) =>
      sqlite.prepare(sql).all(...(params as (string | number | null)[])) as T[],
    get: <T>(sql: string, params = []) =>
      sqlite.prepare(sql).get(...(params as (string | number | null)[])) as T | undefined,
    exec: (sql: string) => sqlite.exec(sql),
    transaction: <R>(fn: () => R): R => {
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
  for (const m of MIGRATIONS) if (m.version <= version) db.exec(m.up);
  db.run(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(version)],
  );
  return db;
}

function rowids(db: Db, table: string): number[] {
  return db
    .all<{ rowid: number }>(`SELECT rowid FROM ${table} ORDER BY rowid`)
    .map((r) => Number(r.rowid));
}

describe('sync cursor preservation across schema migrations (A4)', () => {
  test('ops/record_ops rowids survive the v15 + v20 items rebuilds; cursor stays valid; old ops converge on new schema', () => {
    // A peer running an OLD app: its DB is at schema v14 (before both items rebuilds).
    const old = dbAtVersion(14);
    assert.equal(getSchemaVersion(old), 14);

    // Record a few item ops + a record op at v14 (fields that exist in every version).
    old.transaction(() => {
      old.run(
        `INSERT INTO ops (id, item_id, ts, device_id, fields) VALUES
         ('op-a', 'item-a', 1000, 'dev-old', ?),
         ('op-b', 'item-b', 2000, 'dev-old', ?)`,
        [JSON.stringify({ type: 'task', title: 'A' }), JSON.stringify({ type: 'task', title: 'B' })],
      );
      old.run(
        `INSERT INTO record_ops (id, entity, row_id, ts, device_id, data) VALUES
         ('rop-tag-1', 'tag', 'tag-x', 3000, 'dev-old', ?)`,
        [JSON.stringify({ id: 'tag-x', name: 'x', deleted: false })],
      );
    });

    const opsRowidsBefore = rowids(old, 'ops');
    const recRowidsBefore = rowids(old, 'record_ops');
    assert.ok(opsRowidsBefore.length >= 2 && recRowidsBefore.length >= 1);
    const cursorBefore = Math.max(...opsRowidsBefore); // the peer's sync cursor high-water

    // Migrate the old DB forward across BOTH items rebuilds (v15, v20) to the latest.
    const r = migrate(old);
    assert.equal(r.to, LATEST_SCHEMA_VERSION);
    assert.equal(getSchemaVersion(old), LATEST_SCHEMA_VERSION);

    // 1. The cursor basis (ops/record_ops rowids) is preserved across the rebuilds.
    assert.deepEqual(rowids(old, 'ops'), opsRowidsBefore, 'ops rowids unchanged across migration');
    assert.deepEqual(rowids(old, 'record_ops'), recRowidsBefore, 'record_ops rowids unchanged across migration');

    // 2. The pre-migration cursor is still valid: a pull strictly past it returns nothing
    //    (no re-fetch of already-sent ops, no skip).
    const pastCursor = old.all<{ rowid: number }>(
      `SELECT rowid FROM ops WHERE rowid > ? ORDER BY rowid`,
      [cursorBefore],
    );
    assert.equal(pastCursor.length, 0, 'cursor high-water still bounds the log (no re-fetch)');

    // 3. Mixed-version convergence: the v14-recorded ops (a stable, version-independent
    //    format) converge onto a FRESH post-migration peer through the real ingest path.
    //    Pull the ops out of the old peer's log and ingest them on a LATEST-schema peer.
    const peer = dbAtVersion(LATEST_SCHEMA_VERSION);
    const pulled: Op[] = old
      .all<{ id: string; item_id: string; ts: number; device_id: string; fields: string }>(
        'SELECT id, item_id, ts, device_id, fields FROM ops ORDER BY ts',
      )
      .map((r) => ({
        id: r.id,
        item_id: r.item_id,
        ts: Number(r.ts),
        device_id: r.device_id,
        fields: JSON.parse(r.fields),
      }));
    const { fresh } = ingestOps(peer, pulled, false);
    assert.equal(fresh.length, pulled.length, 'all old-peer ops ingested on the new peer');
    assert.equal(getItem(peer, 'item-a')?.title, 'A', 'v14 op converged onto the new-schema peer (item A)');
    assert.equal(getItem(peer, 'item-b')?.title, 'B', 'v14 op converged onto the new-schema peer (item B)');
  });
});
