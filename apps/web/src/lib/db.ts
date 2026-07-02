import initSqlJs, { type Database as SqlJsDatabase, type Statement } from 'sql.js';
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
/** Clears the live DB's prepared-statement cache; set when the live DB is wrapped.
 *  Must be called after every `sqlDb.export()` (which finalizes all statements). */
let clearLiveStmtCache: () => void = () => {};

localforage.config({ name: 'carbon', storeName: 'carbon' });

// sql.js is loaded once and reused (for the live DB and for reading snapshots).
let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
function getSql() {
  return (sqlPromise ??= initSqlJs({ locateFile: (file) => `/${file}` }));
}

function wrap(sdb: SqlJsDatabase): { db: Db; clearCache: () => void } {
  // Cache compiled statements by SQL text. sql.js recompiles on every `prepare()`,
  // and the repo layer fires many tiny reads (getItem / getChildren inside ancestor
  // and subtree walks) — recompiling each one is a large share of interaction cost
  // on the WASM build. Reusing the compiled statement removes that per-call cost.
  //
  // Safe because: every read fully drains its rows into an array before returning,
  // so a cached statement is never mid-iteration when reused (true even for
  // recursive tree walks — the inner call runs only after the outer `all()` has
  // returned and `reset()` the statement). The schema is stable after `migrate()`,
  // which uses `exec()` and never touches the cached read/write paths.
  const stmtCache = new Map<string, Statement>();
  const stmtFor = (sql: string): Statement => {
    let st = stmtCache.get(sql);
    if (!st) {
      // prepare() may throw (e.g. a table that doesn't exist pre-migrate) — let it
      // propagate without caching a bad entry.
      st = sdb.prepare(sql);
      stmtCache.set(sql, st);
    }
    return st;
  };
  const db: Db = {
    run(sql: string, params: SqlParams = []): void {
      // exec() handles DDL / multi-statement SQL; run() is always a single
      // parameterized statement, so it can reuse a cached compiled statement.
      const st = stmtFor(sql);
      try {
        st.bind(params as never);
        st.step();
      } finally {
        st.reset();
      }
    },
    all<T = Row>(sql: string, params: SqlParams = []): T[] {
      const st = stmtFor(sql);
      try {
        st.bind(params as never);
        const rows: T[] = [];
        while (st.step()) rows.push(st.getAsObject() as T);
        return rows;
      } finally {
        st.reset();
      }
    },
    get<T = Row>(sql: string, params: SqlParams = []): T | undefined {
      const st = stmtFor(sql);
      try {
        st.bind(params as never);
        return st.step() ? (st.getAsObject() as T) : undefined;
      } finally {
        st.reset();
      }
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
  // sql.js `export()` closes + reopens the underlying database and finalizes every
  // prepared statement, so cached handles are invalid ("Statement closed") after a
  // persist. Exporters call this; queries then re-prepare lazily against the
  // reopened handle.
  const clearCache = () => stmtCache.clear();
  return { db, clearCache };
}

export async function initDb(): Promise<{ db: Db; deviceId: string }> {
  if (dbInstance) return { db: dbInstance, deviceId };

  const SQL = await getSql();
  const saved = await localforage.getItem<Uint8Array>(STORE_KEY);
  sqlDb = saved ? new SQL.Database(saved) : new SQL.Database();
  sqlDb.run('PRAGMA foreign_keys = OFF');

  const wrapped = wrap(sqlDb);
  dbInstance = wrapped.db;
  clearLiveStmtCache = wrapped.clearCache;
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
  clearLiveStmtCache(); // export() finalized every prepared statement
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
  const data = sqlDb.export();
  clearLiveStmtCache(); // export() finalized every prepared statement
  return data;
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
  return wrap(sdb).db;
}

/**
 * Open a read-only snapshot of the persisted database straight from IndexedDB,
 * without initializing the live DB. Returns null when nothing has been persisted
 * yet. Used by the desktop quick-add window to read tags/users for autocomplete
 * while leaving all writes to the main window (the single DB owner).
 */
export async function loadSnapshot(): Promise<Db | null> {
  const saved = await localforage.getItem<Uint8Array>(STORE_KEY);
  if (!saved) return null;
  return openSnapshot(saved);
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
