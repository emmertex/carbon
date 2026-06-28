import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import localforage from 'localforage';
import { perf } from './perf';
import {
  migrate,
  ensureDeviceId,
  backfillTagRecordOps,
  reapplyAllRecordOps,
  type Db,
  type Row,
  type SqlParams,
} from '@carbon/core';

const STORE_KEY = 'carbon_db';

let dbInstance: Db | null = null;
let sqlDb: SqlJsDatabase | null = null;
let deviceId = '';

localforage.config({ name: 'carbon', storeName: 'carbon' });

// sql.js is loaded once and reused (for the live DB and for reading snapshots).
let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
function getSql() {
  return (sqlPromise ??= initSqlJs({ locateFile: (file) => `/${file}` }));
}

function wrap(sdb: SqlJsDatabase): Db {
  return {
    run(sql: string, params: SqlParams = []): void {
      sdb.run(sql, params as never);
    },
    all<T = Row>(sql: string, params: SqlParams = []): T[] {
      const stmt = sdb.prepare(sql);
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    },
    get<T = Row>(sql: string, params: SqlParams = []): T | undefined {
      const stmt = sdb.prepare(sql);
      stmt.bind(params as never);
      let row: T | undefined;
      if (stmt.step()) row = stmt.getAsObject() as T;
      stmt.free();
      return row;
    },
    exec(sql: string): void {
      sdb.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      sdb.run('BEGIN');
      try {
        const result = fn();
        sdb.run('COMMIT');
        return result;
      } catch (e) {
        sdb.run('ROLLBACK');
        throw e;
      }
    },
  };
}

export async function initDb(): Promise<{ db: Db; deviceId: string }> {
  if (dbInstance) return { db: dbInstance, deviceId };

  const SQL = await getSql();
  const saved = await localforage.getItem<Uint8Array>(STORE_KEY);
  sqlDb = saved ? new SQL.Database(saved) : new SQL.Database();
  sqlDb.run('PRAGMA foreign_keys = OFF');

  dbInstance = wrap(sqlDb);
  migrate(dbInstance);
  deviceId = ensureDeviceId(dbInstance);
  // One-time: emit record-ops for tags/links created before they were syncable.
  if (getMeta('tags_backfilled') !== '1') {
    backfillTagRecordOps(dbInstance, deviceId);
    setMeta('tags_backfilled', '1');
  }
  // One-time: re-apply the local record-op log so ops received but not materialized
  // by an older client (e.g. tags before this build) take effect.
  if (getMeta('recordops_reapplied_v6') !== '1') {
    reapplyAllRecordOps(dbInstance);
    setMeta('recordops_reapplied_v6', '1');
  }
  await persist();
  return { db: dbInstance, deviceId };
}

export function getDb(): Db {
  if (!dbInstance) throw new Error('DB not initialized');
  return dbInstance;
}

export function getDeviceId(): string {
  return deviceId;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced persistence of the in-memory DB to IndexedDB. */
export function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persist(), 250);
}

export async function persist(): Promise<void> {
  if (!sqlDb) return;
  const t0 = performance.now();
  const data = sqlDb.export();
  perf.record('persist', 'export', performance.now() - t0);
  const t1 = performance.now();
  await localforage.setItem(STORE_KEY, data);
  perf.record('persist', 'idb', performance.now() - t1);
}

/** Flush any pending debounced save immediately (e.g. the tab is about to hide or
 *  close). Returns the persist promise so callers can await it where possible. */
export function flushPersist(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return persist();
}

/**
 * Persist the moment the page is hidden or unloaded, not 250 ms later. Without this
 * a write made just before a reload / app-kill (very common on mobile PWAs) never
 * reaches IndexedDB and is silently lost. `visibilitychange→hidden` is the reliable
 * mobile signal (fires before the OS kills a backgrounded PWA); `pagehide` covers
 * desktop tab close. IndexedDB writes can't be awaited synchronously here, but the
 * browser keeps the page alive long enough for the export+put to land in practice.
 */
export function registerPersistFlush(): void {
  if (typeof document === 'undefined') return;
  const flush = () => {
    if (saveTimer) void flushPersist();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}

/** Raw bytes of the current SQLite database (for backup/export). */
export function exportDb(): Uint8Array {
  if (!sqlDb) throw new Error('DB not initialized');
  return sqlDb.export();
}

/** Overwrite the persisted database with imported bytes. Reload the app after. */
export async function importDb(bytes: Uint8Array): Promise<void> {
  await localforage.setItem(STORE_KEY, bytes);
}

/** Open backup bytes as a throwaway in-memory DB to read from, without touching
 *  the live database. Caller is done with it once it falls out of scope. */
export async function openSnapshot(bytes: Uint8Array): Promise<Db> {
  const SQL = await getSql();
  const sdb = new SQL.Database(bytes);
  sdb.run('PRAGMA foreign_keys = OFF');
  return wrap(sdb);
}

// ----- meta key/value helpers ----------------------------------------------

export function getMeta(key: string): string | null {
  const row = getDb().get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb().run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
