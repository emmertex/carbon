import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from '@carbon/core';

// Uses Node's built-in SQLite (node:sqlite, stable in Node 24+). No native
// compilation, no extra dependency — ideal for a small self-hosted server.
export function openDb(path: string): Db & { raw: DatabaseSync } {
  const sqlite = new DatabaseSync(path);
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
}
