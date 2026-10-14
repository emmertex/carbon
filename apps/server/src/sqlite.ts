import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Db, SqlParams } from '@carbon/core';

// Uses Node's built-in SQLite (node:sqlite, stable in Node 24+). No native
// compilation, no extra dependency — ideal for a small self-hosted server.
//
// Prepared statements are cached per handle (bounded LRU keyed by SQL text) so hot
// queries aren't recompiled on every call. The cache is cleared when the handle is
// closed via raw.close().
export const STMT_CACHE_MAX = 256;
const stmtCaches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** Number of cached prepared statements on a handle (tests/diagnostics). */
export function stmtCacheSize(raw: DatabaseSync): number {
  return stmtCaches.get(raw)?.size ?? 0;
}

export function openDb(
  path: string,
  opts: { stmtCacheMax?: number } = {},
): Db & { raw: DatabaseSync } {
  const sqlite = new DatabaseSync(path);
  const stmtCacheMax = Math.max(0, opts.stmtCacheMax ?? STMT_CACHE_MAX);
  const stmts = new Map<string, StatementSync>();
  stmtCaches.set(sqlite, stmts);
  const prepare = (sql: string): StatementSync => {
    const hit = stmts.get(sql);
    if (hit) {
      stmts.delete(sql); // move to most-recently-used
      stmts.set(sql, hit);
      return hit;
    }
    const stmt = sqlite.prepare(sql);
    if (stmtCacheMax > 0) {
      stmts.set(sql, stmt);
      if (stmts.size > stmtCacheMax) stmts.delete(stmts.keys().next().value as string);
    }
    return stmt;
  };
  // Every close path goes through raw.close() (registry eviction, migration repair,
  // tests), so clear the cache there: finalized statements must not be reused.
  const close = sqlite.close.bind(sqlite);
  sqlite.close = () => {
    stmts.clear();
    close();
  };
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  // Foreign keys are off by design: all soft-delete tombstones and cascades are
  // enforced by app-level code (see schema.ts:317 & :432), not SQL constraints.
  // This allows flexible tombstone handling and sync-guard integrity without
  // table rebuilds when cascading deletes occur.
  sqlite.exec('PRAGMA foreign_keys = OFF');

  return {
    raw: sqlite,
    run(sql: string, params: SqlParams = []): void {
      prepare(sql).run(...params);
    },
    all<T>(sql: string, params: SqlParams = []): T[] {
      return prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: SqlParams = []): T | undefined {
      return prepare(sql).get(...params) as T | undefined;
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
}
