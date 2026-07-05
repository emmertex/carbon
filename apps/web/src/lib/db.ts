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
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist().catch((e) => console.error('[carbon] debounced persist failed:', e));
  }, 250);
}

// The routine debounced persist hands the exported buffer to a worker so the
// structured-clone + IndexedDB write (the dominant cost under CPU throttling —
// see perf/results) doesn't block the main thread's render/interaction work.
// `sqlDb.export()` itself stays on the main thread (needs the live WASM memory,
// and is cheap — ~1ms even at 10k items).
let persistWorker: Worker | null = null;
// Set when the worker itself errors (script failed to load, message couldn't
// deserialize): all later persists write directly for the rest of the session.
let persistWorkerBroken = false;
let persistReqId = 0;
const pendingWrites = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();

function getPersistWorker(): Worker {
  if (!persistWorker) {
    const w = new Worker(new URL('./persist.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
      const pending = pendingWrites.get(e.data.id);
      if (!pending) return;
      pendingWrites.delete(e.data.id);
      if (e.data.ok) pending.resolve();
      else pending.reject(new Error(e.data.error));
    };
    // A worker that can't start (CSP, chunk fetch failure while offline) never
    // answers: without this, every waiter would hang forever and the routine
    // path would silently stop persisting. Fail the waiters — persistImpl falls
    // back to a direct write — and don't try the worker again this session.
    const fail = () => {
      persistWorkerBroken = true;
      persistWorker = null;
      w.terminate();
      const pending = [...pendingWrites.values()];
      pendingWrites.clear();
      for (const p of pending) p.reject(new Error('persist worker failed'));
    };
    w.onerror = fail;
    w.onmessageerror = fail;
    persistWorker = w;
  }
  return persistWorker;
}

/** Write `data` to IndexedDB off the main thread via a transferable (zero-copy)
 *  postMessage. Only for the routine debounced path — see `writeSnapshotDirect`
 *  for the must-land-before-unload path. */
function writeSnapshotViaWorker(data: Uint8Array): Promise<void> {
  const id = ++persistReqId;
  return new Promise((resolve, reject) => {
    pendingWrites.set(id, { resolve, reject });
    getPersistWorker().postMessage({ id, key: STORE_KEY, data }, [data.buffer]);
  });
}

/** Write `data` to IndexedDB directly on the main thread. Used only by
 *  `flushPersist()` — a page about to unload can't reliably wait on a worker
 *  round trip, so that path must not go through the worker. */
function writeSnapshotDirect(data: Uint8Array): Promise<void> {
  return localforage.setItem(STORE_KEY, data).then(() => undefined);
}

async function persistImpl(direct: boolean): Promise<void> {
  if (!sqlDb) return;
  const t0 = performance.now();
  const data = sqlDb.export();
  clearLiveStmtCache(); // export() finalized every prepared statement
  perf.record('persist', 'export', performance.now() - t0);
  const t1 = performance.now();
  if (direct || persistWorkerBroken) {
    await writeSnapshotDirect(data);
  } else {
    try {
      await writeSnapshotViaWorker(data);
    } catch (e) {
      // The worker (or its write) failed. The snapshot buffer was transferred
      // and lost with the message, so re-export (cheap, ~1ms) and land the
      // write on the main thread rather than dropping it.
      console.error('[carbon] persist worker write failed; writing directly:', e);
      if (!sqlDb) return;
      const retry = sqlDb.export();
      clearLiveStmtCache();
      await writeSnapshotDirect(retry);
    }
  }
  perf.record('persist', 'idb', performance.now() - t1);
}

export async function persist(): Promise<void> {
  return persistImpl(false);
}

/** Cancel the debounced save and kill any in-flight worker write, then run
 *  `write` (a direct main-thread snapshot write). IndexedDB orders overlapping
 *  writes by transaction creation, not submission, so without this an older
 *  worker snapshot could land *after* — and silently roll back — the newer
 *  direct write. Terminating the worker is safe both ways: an uncommitted
 *  worker transaction dies with it, and a committed one is simply overwritten
 *  by `write`. Waiters on the killed writes settle with `write`, whose newer
 *  snapshot supersedes theirs. */
function supersedePendingWrites(write: () => Promise<void>): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  let superseded: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  if (persistWorker && pendingWrites.size) {
    persistWorker.terminate();
    persistWorker = null;
    superseded = [...pendingWrites.values()];
    pendingWrites.clear();
  }
  const done = write();
  for (const p of superseded) done.then(p.resolve, p.reject);
  return done;
}

/** Flush any pending debounced save immediately (e.g. the tab is about to hide or
 *  close). Returns the persist promise so callers can await it where possible.
 *  Writes directly on the main thread (bypasses the worker) since a page about to
 *  unload can't reliably wait on a cross-thread round trip; any in-flight worker
 *  write is killed first so its older snapshot can't land after this one. */
export function flushPersist(): Promise<void> {
  return supersedePendingWrites(() => persistImpl(true));
}

/** The default `registerPersistFlush` handler: flush when a save is still
 *  debouncing OR still in flight on the worker — a backgrounded page's worker
 *  can be frozen before its write commits, so only a direct main-thread write
 *  is safe to rely on here. Exported (as `defaultPersistFlushHandler`) so tests
 *  can assert `registerPersistFlush` wires it to `pagehide`/`visibilitychange`
 *  without having to drive a real sql.js/IndexedDB round trip. */
export function defaultPersistFlushHandler(): void {
  if (saveTimer || pendingWrites.size) void flushPersist();
}

/**
 * Persist the moment the page is hidden or unloaded, not 250 ms later. Without this
 * a write made just before a reload / app-kill (very common on mobile PWAs) never
 * reaches IndexedDB and is silently lost. `visibilitychange→hidden` is the reliable
 * mobile signal (fires before the OS kills a backgrounded PWA); `pagehide` covers
 * desktop tab close. IndexedDB writes can't be awaited synchronously here, but the
 * browser keeps the page alive long enough for the export+put to land in practice.
 *
 * `flush` defaults to `defaultPersistFlushHandler` and is only overridable so
 * tests can substitute a spy; production callers should never pass it.
 */
export function registerPersistFlush(flush: () => void = defaultPersistFlushHandler): void {
  if (typeof document === 'undefined') return;
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

/** Overwrite the persisted database with imported bytes. Reload the app after.
 *  Pending debounced/worker writes of the old live DB are killed first — one
 *  landing after this write would silently undo the import before the reload. */
export async function importDb(bytes: Uint8Array): Promise<void> {
  await supersedePendingWrites(() => localforage.setItem(STORE_KEY, bytes).then(() => undefined));
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
