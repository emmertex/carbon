import initSqlJs, {
  type Database as SqlJsDatabase,
  type Statement,
} from "sql.js";
import localforage from "localforage";
import { perf } from "./perf";
import { bindBlobIdentity, clearBlobs, migrateLegacyBlobs } from "./blobs";
import { identityKey, eraseIdentitySettings } from "./identity";
import {
  applyOp,
  migrate,
  ensureDeviceId,
  backfillTagRecordOps,
  reapplyAllRecordOps,
  ingestOps,
  ingestRecordOps,
  claimUnowned,
  reviewEntryId,
  type Db,
  type Row,
  type SqlParams,
  type Op,
  type RecordOp,
} from "@carbon/core";

/**
 * Storage seam for the persisted database. Production is raw IndexedDB (database
 * `carbon_meta`, object store `kv`) — not localforage — because the persistence
 * protocol needs compound atomicity (a read-modify-write of the lock + snapshot
 * in ONE transaction); localforage offers no such primitive. Tests substitute an
 * in-memory implementation so two "tabs" (separate module instances, see
 * persist.test.ts) can share one store under node. See
 * `docs/internal/a3/design.md` for the full design.
 */
export interface KvTx {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export interface KvSeam {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Run fn inside a single atomic transaction with snapshot isolation
   * (production: one IndexedDB readwrite transaction). The ops fn receives are
   * bound to that transaction, so a read-modify-write is atomic: no other
   * connection can interleave between the read and the write.
   */
  transaction(fn: (tx: KvTx) => Promise<void> | void): Promise<void>;
}

export function makeIdbSeam(): KvSeam {
  let dbp: Promise<IDBDatabase> | null = null;
  const openDb = (): Promise<IDBDatabase> =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("carbon_meta", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close();
          dbp = null;
        };
        resolve(req.result);
      };
      req.onerror = () =>
        reject(req.error ?? new Error("indexedDB open failed"));
    }));

  const fromReq = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error ?? new Error("indexedDB operation failed"));
    });

  const ops = (tx: IDBTransaction): KvTx => {
    const st = () => tx.objectStore("kv");
    return {
      get: (key) => fromReq(st().get(key)),
      put: (key, value) => fromReq(st().put(value, key)).then(() => undefined),
      del: (key) => fromReq(st().delete(key)),
    };
  };

  const transaction = async (
    fn: (tx: KvTx) => Promise<void> | void,
  ): Promise<void> => {
    const tx = (await openDb()).transaction("kv", "readwrite");
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
    });
    // Install handlers before issuing requests, including a callback that throws.
    void done.catch(() => {});
    try {
      await fn(ops(tx));
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already aborted */
      }
      await done.catch(() => {});
      throw e;
    }
    await done;
  };
  return {
    get: async (key) =>
      fromReq(
        (await openDb())
          .transaction("kv", "readonly")
          .objectStore("kv")
          .get(key),
      ),
    put: (key, value) => transaction((tx) => tx.put(key, value)),
    del: (key) => transaction((tx) => tx.del(key)),
    transaction,
  };
}

let kvOverride: KvSeam | null = null;
let kvDefault: KvSeam | null = null;

/** Substitute the storage seam (tests only; pass null to restore production). */
export function setKvSeam(seam: KvSeam | null): void {
  kvOverride = seam;
  kvDefault = null;
}

function kv(): KvSeam {
  return kvOverride ?? (kvDefault ??= makeIdbSeam());
}

// ----- generation-ordered durable persistence (A3) ---------------------------

/** One persisted snapshot: a whole-DB export tagged with its generation. */
interface SnapRec {
  gen: number;
  snap: Uint8Array;
  writer?: string;
}

/** A single-writer lock record: who holds the persist lock, and when. */
interface LockVal {
  owner: string;
  ts: number;
  token: string;
}

// A3 commit 4 replaces the fixed namespace below with the signed-in
// workspace/user identity (see docs/internal/a3/design.md).
/**
 * The identity this tab is bound to, captured at boot (`initDb`). A tab keeps
 * addressing the stores of the identity it booted as — even if the signed-in
 * user changes in localStorage afterwards (another tab signed in) — so a stale
 * old-identity tab can never read or write a new identity's data. `rebindIdentity`
 * (sign-in/out, workspace switch) is the only thing that re-points it.
 */
let boundNs: string | null = null;
function ns(): string {
  return boundNs ?? identityKey();
}
// Each takes an optional namespace so callers can reach a specific identity's
// durable store (e.g. the device-local capture) rather than only the bound one.
const dbKey = (n?: string) => `db|${n ?? ns()}`;
const logKey = (n?: string) => `dblog|${n ?? ns()}`;
const wipeKey = (n?: string) => `wipe|${n ?? ns()}`;
let wipeEpoch: unknown = undefined;
let activeLock: LockVal | null = null;
let lockSerial = 0;

// Serialize all state replacement and durable operations within this tab.
let operationTail: Promise<unknown> = Promise.resolve();
let directRequests = 0;
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = operationTail.then(fn);
  operationTail = result.catch(() => {});
  return result;
}

const lockKey = (n?: string) => `lock|${n ?? ns()}`;

/** The snapshot log keeps the last few whole-DB snapshots (newest first) so a
 *  corrupt or missing current record can be recovered from the last good one. */
const MAX_LOG = 4;
const LOG_MAX_BYTES = 64 * 1024 * 1024;
/** A lock whose owner has gone silent (crashed, killed) is released after this. */
const LOCK_TTL_MS = 15_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_TRIES = 40;

/** Unique id for this tab — identifies this tab's lock ownership. */
const tabId: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);

// ----- cross-tab coordination (BroadcastChannel) -----------------------------

/** A BroadcastChannel-like surface (tests substitute a shared in-memory one). */
export interface BcLike {
  postMessage(msg: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close(): void;
}

let bcFactory: (name: string) => BcLike | null = (name) =>
  typeof BroadcastChannel !== "undefined"
    ? (new BroadcastChannel(name) as BcLike)
    : null;

/** Substitute the channel factory (tests only; pass null to restore production). */
export function setBcFactory(
  f: ((name: string) => BcLike | null) | null,
): void {
  bcFactory =
    f ??
    ((name) =>
      typeof BroadcastChannel !== "undefined"
        ? (new BroadcastChannel(name) as BcLike)
        : null);
}

let bc: BcLike | null = null;

/** Peer messages (see docs/internal/a3/design.md). */
interface PeerMsg {
  t: "persisted" | "hello" | "wiped" | "rebind";
  gen?: number;
  tab?: string;
}

function postMsg(msg: PeerMsg): void {
  try {
    bc?.postMessage(msg);
  } catch {
    /* channel closed mid-flight — nothing to do */
  }
}

/**
 * Re-check the store and, if another tab advanced the generation since this
 * tab's last read, resync onto it (replaying this tab's unflushed work). This
 * is both the message handler for peers' 'persisted' notices and the
 * catch-up path for a throttled background tab that missed them.
 */
async function catchUpToStoreImpl(): Promise<void> {
  await assertNotWiped();
  if (!sqlDb) return;
  const cur = (await kv().get(dbKey())) as SnapRec | null;
  if (!cur || cur.gen <= baseGen) return;
  await resyncFromStore(cur.snap, cur.gen);
}

function catchUpToStore(): Promise<void> {
  return serialize(catchUpToStoreImpl);
}

async function assertNotWiped(): Promise<void> {
  if ((await kv().get(wipeKey())) !== wipeEpoch) {
    throw new Error(
      "Local data was erased in another tab; reload before continuing",
    );
  }
}

let reloadFn: () => void = () => {
  if (typeof window !== "undefined") window.location.reload();
};

/** Substitute the reload (tests only — 'wiped'/'rebind' messages call it). */
export function setReloadFn(fn: () => void): void {
  reloadFn = fn;
}

function onPeerMsg(e: { data: unknown }): void {
  const msg = e.data as PeerMsg | null;
  if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
  if (msg.tab === tabId) return; // never act on our own messages
  switch (msg.t) {
    case "persisted":
      if (typeof msg.gen === "number" && msg.gen > baseGen) {
        void catchUpToStore().catch((err) =>
          console.warn("[carbon] tab catch-up failed:", err),
        );
      }
      break;
    case "hello":
      // A tab is joining: answer with the store's CURRENT generation so a
      // boot that raced a peer's commit resyncs before its first write.
      void kv()
        .get(dbKey())
        .then((cur) =>
          postMsg({
            t: "persisted",
            gen: (cur as SnapRec | null)?.gen ?? 0,
            tab: tabId,
          }),
        )
        .catch(() => {});
      break;
    case "wiped":
    case "rebind":
      reloadFn();
      break;
  }
}

/** Open this namespace's coordination channel (once per tab, at boot). */
function openPeerChannel(): void {
  closePeerChannel();
  const ch = bcFactory(`carbon|${ns()}`);
  if (ch) {
    ch.onmessage = onPeerMsg;
    bc = ch;
  }
}

function closePeerChannel(): void {
  try {
    bc?.close();
  } catch {
    /* already closed */
  }
  bc = null;
}

/** The generation of the snapshot this tab's in-memory state was loaded from. */
let baseGen = 0;

// ----- per-tab mutation log ---------------------------------------------------
//
// Every write statement executed through the wrapped DB is recorded here. The
// log holds everything this tab has changed since its last *successful*
// persist, so when another tab commits first and forces a resync (see
// `resyncFromStore`), this tab's not-yet-flushed work is replayed on top of the
// new store snapshot instead of being lost. See docs/internal/a3/design.md.

type MutRec =
  | { sql: string; params: unknown[]; exec?: boolean }
  | { tx: "begin" | "commit" | "rollback" };

let mutLog: MutRec[] = [];

let dbInstance: Db | null = null;
let sqlDb: SqlJsDatabase | null = null;
let deviceId = "";
/** Clears the live DB's prepared-statement cache; set when the live DB is wrapped.
 *  Must be called after every `sqlDb.export()` (which finalizes all statements). */
let clearLiveStmtCache: () => void = () => {};

/** The pre-A3 single-tenant store (localforage instance `carbon`/`carbon`, key
 *  `carbon_db`): the whole DB as one raw export under one key. Read only by the
 *  one-time migration below. */
const LEGACY_STORE = localforage.createInstance({
  name: "carbon",
  storeName: "carbon",
});
const LEGACY_DB_KEY = "carbon_db";

/**
 * One-time, idempotent: move the legacy whole-DB record into the current
 * identity's snapshot store (a legacy install's data belongs to whoever is
 * signed in now; a not-signed-in install's to the device-local store). Skipped
 * when the new key already holds data, or the migration flag is set.
 */
async function migrateLegacyStore(): Promise<void> {
  let legacy: Uint8Array | null;
  try {
    legacy = await LEGACY_STORE.getItem(LEGACY_DB_KEY);
  } catch {
    return;
  } // No legacy IndexedDB driver (e.g. node).
  if (!legacy?.length) return;
  // Global, atomic claim: a later account must never copy the same legacy DB.
  const priorOwners = Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.key(i),
  )
    .filter(
      (key): key is string =>
        !!key?.startsWith("carbon.dbMigrated::") &&
        localStorage.getItem(key) === "1",
    )
    .map((key) => key.slice("carbon.dbMigrated::".length));
  let copied = false;
  await kv().transaction(async (tx) => {
    if (await tx.get("legacy-db-owner")) return;
    if (
      priorOwners.length &&
      (priorOwners.length !== 1 || priorOwners[0] !== ns())
    ) {
      await tx.put(
        "legacy-db-owner",
        priorOwners.length === 1 ? priorOwners[0] : "ambiguous-legacy-owner",
      );
      return;
    }
    if (!(await tx.get(dbKey())) && !(await tx.get(wipeKey()))) {
      await tx.put(dbKey(), { gen: 0, snap: legacy });
      await tx.put(logKey(), [{ gen: 0, snap: legacy }]);
      copied = true;
    }
    await tx.put("legacy-db-owner", ns());
  });
  if (copied) await LEGACY_STORE.removeItem(LEGACY_DB_KEY);
}

// sql.js is loaded once and reused (for the live DB and for reading snapshots).
let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
function getSql() {
  // In the browser the wasm is served from the app origin; under node (tests)
  // it loads from the sql.js package directory with the default locator.
  // (indexedDB, not window, marks the boundary: tests fake `window` but not
  // `indexedDB`.)
  return (sqlPromise ??=
    typeof indexedDB === "undefined"
      ? initSqlJs()
      : initSqlJs({ locateFile: (file) => `/${file}` }));
}

function wrap(
  sdb: SqlJsDatabase,
  record = false,
): { db: Db; clearCache: () => void } {
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
        if (record)
          mutLog.push({ sql, params: structuredClone(params) as unknown[] });
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
      if (record) mutLog.push({ sql, params: [], exec: true });
    },
    transaction<T>(fn: () => T): T {
      // BEGIN/COMMIT/ROLLBACK go straight to the raw handle (not recorded as
      // statements); the log records explicit markers so a replay re-wraps them
      // in a real transaction.
      const start = mutLog.length;
      sdb.run("BEGIN");
      if (record) mutLog.push({ tx: "begin" });
      try {
        const result = fn();
        sdb.run("COMMIT");
        if (record) mutLog.push({ tx: "commit" });
        return result;
      } catch (e) {
        sdb.run("ROLLBACK");
        if (record) mutLog.splice(start);
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

/** True when `bytes` opens as a SQLite database with the Carbon schema. */
function tryOpenSnapshot(
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  bytes: unknown,
): SqlJsDatabase | null {
  if (!(bytes instanceof Uint8Array)) return null;
  let sdb: SqlJsDatabase | null = null;
  try {
    sdb = new SQL.Database(bytes);
    sdb.run("PRAGMA foreign_keys = OFF");
    const hasItems = sdb.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
    );
    if (hasItems.length && hasItems[0].values.length) return sdb;
    sdb.close();
    return null;
  } catch {
    try {
      sdb?.close();
    } catch {
      /* invalid handle */
    }
    return null;
  }
}

function validSnapshot(
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  bytes: unknown,
): boolean {
  const opened = tryOpenSnapshot(SQL, bytes);
  if (!opened) return false;
  opened.close();
  return true;
}

/** Replay into a disposable candidate. Unexpected failures abort replacement
 * and persistence, retaining the complete original live state and journal. */
function replayMutations(sdb: SqlJsDatabase): void {
  // The candidate database is disposable until EVERY pending mutation has
  // replayed. Failure must retain both the old live database and its journal.
  for (const rec of mutLog) {
    if ("tx" in rec) {
      sdb.run(
        rec.tx === "begin"
          ? "BEGIN"
          : rec.tx === "commit"
            ? "COMMIT"
            : "ROLLBACK",
      );
    } else if (rec.exec) {
      sdb.exec(rec.sql);
    } else {
      replayStatement(sdb, rec);
    }
  }
}

function replayStatement(
  sdb: SqlJsDatabase,
  rec: { sql: string; params: unknown[] },
): void {
  const db = wrap(sdb).db;
  if (/INSERT INTO meta/i.test(rec.sql) && rec.params[0] === "op_clock") {
    const old = db.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'op_clock'",
    );
    if (Number(old?.value ?? 0) >= Number(rec.params[1])) return;
  }
  if (/^UPDATE items SET /i.test(rec.sql) && rec.sql.includes("clocks = ?")) {
    const columns = rec.sql
      .slice("UPDATE items SET ".length)
      .split(" WHERE ")[0]
      .split(", ")
      .map((c) => c.split(" = ")[0].replaceAll('"', ""));
    const clocks = JSON.parse(String(rec.params[columns.indexOf("clocks")]));
    const itemId = String(rec.params.at(-1));
    for (let i = 0; i < columns.length; i++) {
      const field = columns[i];
      if (field === "clocks" || field === "updated_at") continue;
      const clock = clocks[field];
      if (!clock) throw new Error("Missing replay field clock");
      applyOp(db, {
        id: "",
        item_id: itemId,
        ts: clock.ts,
        device_id: clock.dev,
        fields: { [field]: rec.params[i] },
      });
    }
    return;
  }
  // An applyOp shell may already exist in the peer's snapshot.
  if (
    /INSERT INTO items.*\(id, type, title, status, created_at, updated_at, clocks\)/s.test(
      rec.sql,
    ) &&
    db.get("SELECT id FROM items WHERE id = ?", [String(rec.params[0])])
  )
    return;
  sdb.run(rec.sql, rec.params as never);
}

/**
 * Replace the live in-memory DB with `snap` (a store snapshot at generation
 * `gen`) and replay this tab's unflushed mutations on top. Called when another
 * tab committed first (its generation is ahead of this tab's base): the stale
 * in-memory state is discarded — and, crucially, never written back — while
 * this tab's own pending work is salvaged through the mutation log.
 */
async function resyncFromStore(snap: Uint8Array, gen: number): Promise<void> {
  const SQL = await getSql();
  const fresh = new SQL.Database(snap);
  fresh.run("PRAGMA foreign_keys = OFF");
  try {
    replayMutations(fresh);
  } catch (e) {
    fresh.close();
    throw new Error(
      "Pending local edits could not be replayed; original data retained",
      { cause: e },
    );
  }
  sqlDb?.close();
  sqlDb = fresh;
  const wrapped = wrap(sqlDb, true);
  dbInstance = wrapped.db;
  clearLiveStmtCache = wrapped.clearCache;
  baseGen = gen;
  // Re-render the UI from the new state. The store is imported lazily: it
  // reads localStorage at module load, and db.ts must stay importable without
  // a DOM (see dbRevision's header comment for why the counter lives apart).
  void import("./store")
    .then((m) => m.useStore.getState().bump())
    .catch(() => {
      /* store unavailable (e.g. mid-test) — the next mutation bumps anyway */
    });
}

export function initDb(): Promise<{ db: Db; deviceId: string }> {
  return serialize(initDbImpl);
}

async function initDbImpl(): Promise<{ db: Db; deviceId: string }> {
  if (dbInstance) return { db: dbInstance, deviceId };

  // Bind this tab to the identity it's booting as. Everything this tab reads
  // or writes from now on is namespaced by it (see `boundNs`).
  boundNs ??= identityKey();
  wipeEpoch = await kv().get(wipeKey());

  const SQL = await getSql();
  // One-time legacy migration: pre-A3 `carbon_db` record + `blobs` store.
  await migrateLegacyStore();
  bindBlobIdentity(ns(), assertNotWiped);
  await migrateLegacyBlobs(async () => {
    let allowed = false;
    await kv().transaction(async (tx) => {
      if (await tx.get(wipeKey())) return;
      const owner = await tx.get("legacy-blobs-owner");
      if (owner && owner !== ns()) return;
      if (!owner) {
        const priorOwners = Array.from(
          { length: localStorage.length },
          (_, i) => localStorage.key(i),
        )
          .filter(
            (key): key is string =>
              !!key?.startsWith("carbon.blobsMigrated::") &&
              localStorage.getItem(key) === "1",
          )
          .map((key) => key.slice("carbon.blobsMigrated::".length));
        if (
          priorOwners.length &&
          (priorOwners.length !== 1 || priorOwners[0] !== ns())
        ) {
          await tx.put(
            "legacy-blobs-owner",
            priorOwners.length === 1
              ? priorOwners[0]
              : "ambiguous-legacy-owner",
          );
          return;
        }
      }
      if (!owner) await tx.put("legacy-blobs-owner", ns());
      allowed = true;
    });
    return allowed;
  });
  // Load the latest good snapshot. If the current record is missing or corrupt
  // (crash mid-write, a bad import, storage corruption), walk the append-only
  // snapshot log newest-first until an entry opens cleanly and heal the main
  // record from it. The store therefore always recovers to the last good state
  // — see docs/internal/a3/design.md.
  let sql: SqlJsDatabase | null = null;
  let loadedGen = 0;
  let hadStoredData = false;
  const cur = (await kv().get(dbKey())) as SnapRec | null;
  if (cur) {
    hadStoredData = true;
    const opened = tryOpenSnapshot(SQL, cur.snap);
    if (opened) {
      sql = opened;
      loadedGen = cur.gen;
    }
  }
  if (!sql) {
    const log = (await kv().get(logKey())) as SnapRec[] | null;
    hadStoredData ||= Array.isArray(log) && log.length > 0;
    for (const entry of Array.isArray(log) ? log : []) {
      const cand = tryOpenSnapshot(SQL, entry.snap);
      if (cand) {
        sql = cand;
        loadedGen = entry.gen;
        console.warn("[carbon] Recovered local database from snapshot history");
        break;
      }
    }
  }
  if (sql) {
    baseGen = loadedGen;

    sqlDb = sql;
    sqlDb.run("PRAGMA foreign_keys = OFF");
  } else {
    if (hadStoredData)
      throw new Error(
        "Local database is corrupt; stored snapshots retained for recovery",
      );
    sqlDb = new SQL.Database();
  }

  const wrapped = wrap(sqlDb, true);
  dbInstance = wrapped.db;
  clearLiveStmtCache = wrapped.clearCache;
  migrate(dbInstance);
  deviceId = ensureDeviceId(dbInstance);
  // One-time: emit record-ops for tags/links created before they were syncable.
  if (getMeta("tags_backfilled") !== "1") {
    backfillTagRecordOps(dbInstance, deviceId);
    setMeta("tags_backfilled", "1");
  }
  // One-time: re-apply the local record-op log so ops received but not materialized
  // by an older client (e.g. tags before this build) take effect.
  if (getMeta("recordops_reapplied_v6") !== "1") {
    reapplyAllRecordOps(dbInstance);
    setMeta("recordops_reapplied_v6", "1");
  }
  // A reload can abandon its predecessor's lease. Boot must wait long enough
  // for that lease to expire, rather than leaving the app on its loading screen.
  await persistImpl(false, LOCK_TTL_MS + LOCK_MAX_TRIES * LOCK_RETRY_MS);
  // Join this namespace's peer channel and announce ourselves: any tab that
  // answers with a store generation ahead of ours (we raced a peer's commit
  // while booting) makes us resync before our first write.
  openPeerChannel();
  postMsg({ t: "hello", tab: tabId });
  return { db: dbInstance, deviceId };
}

/** Actual live DB namespace; may differ from config while a rebind is pending or failed. */
export function getBoundIdentity(): string | null {
  return dbInstance ? boundNs : null;
}

export function getDb(): Db {
  if (!dbInstance) throw new Error("DB not initialized");
  return dbInstance;
}

/**
 * Test hook (persist.test.ts): reset this module instance's live state so the
 * next `initDb` starts from the current store — the same effect a browser tab
 * reload has (a fresh module). Never called in production.
 */
export function resetDbForTest(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (persistWorker) {
    persistWorker.terminate();
    persistWorker = null;
  }
  pendingWrites.clear();
  closePeerChannel();
  sqlDb?.close();
  sqlDb = null;
  dbInstance = null;
  mutLog = [];
  baseGen = 0;
  boundNs = null;
  wipeEpoch = undefined;
  activeLock = null;
  operationTail = Promise.resolve();
  persistWorkerBroken = typeof Worker === "undefined";
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
    persist().catch((e) =>
      console.error("[carbon] debounced persist failed:", e),
    );
  }, 250);
}

// ----- single-writer lock ----------------------------------------------------
//
// All tabs of this namespace share ONE persist lock (an IndexedDB record).
// Every durable write happens inside `acquireLock`/`releaseLock`, which is what
// makes the generation protocol airtight: two tabs can never both read
// "generation N is current" and both write "generation N+1" — the second
// writer waits for the first to release, then re-reads the current generation
// and sees it has moved. A tab that crashes or is killed while holding the
// lock is released by TTL (LOCK_TTL_MS). All tabs stay fully editable at all
// times — the lock only serializes the (millisecond-scale) commit.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquireLock(
  waitMs = LOCK_MAX_TRIES * LOCK_RETRY_MS,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  do {
    let acquired: LockVal | null = null;
    await kv().transaction(async (tx) => {
      const cur = (await tx.get(lockKey())) as LockVal | null;
      const now = Date.now();
      if (cur && now - cur.ts <= LOCK_TTL_MS) return;
      acquired = { owner: tabId, ts: now, token: `${tabId}:${++lockSerial}` };
      await tx.put(lockKey(), acquired);
    });
    if (acquired) {
      activeLock = acquired;
      return true;
    }
    await sleep(LOCK_RETRY_MS);
  } while (Date.now() < deadline);
  return false;
}

async function releaseLock(): Promise<void> {
  const held = activeLock;
  activeLock = null;
  if (!held) return;
  try {
    await kv().transaction(async (tx) => {
      const cur = (await tx.get(lockKey())) as LockVal | null;
      if (cur?.token === held.token) await tx.del(lockKey());
    });
  } catch {
    /* TTL frees a dead owner; commit fencing rejects expired writers. */
  }
}

// The routine debounced persist hands the exported buffer to a worker so the
// structured-clone + IndexedDB write (the dominant cost under CPU throttling —
// see perf/results) doesn't block the main thread's render/interaction work.
// `sqlDb.export()` itself stays on the main thread (needs the live WASM memory,
// and is cheap — ~1ms even at 10k items).
let persistWorker: Worker | null = null;
// Set when the worker itself errors (script failed to load, message couldn't
// deserialize): all later persists write directly for the rest of the session.
// Under node (tests) there is no Worker global — go straight to the direct
// main-thread write path instead of failing on first use.
let persistWorkerBroken = typeof Worker === "undefined";
let persistReqId = 0;
const pendingWrites = new Map<
  number,
  { resolve: () => void; reject: (e: unknown) => void }
>();

function getPersistWorker(): Worker {
  if (!persistWorker) {
    const w = new Worker(new URL("./persist.worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (
      e: MessageEvent<{ id: number; ok: boolean; error?: string }>,
    ) => {
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
      for (const p of pending) p.reject(new Error("persist worker failed"));
    };
    w.onerror = fail;
    w.onmessageerror = fail;
    persistWorker = w;
  }
  return persistWorker;
}

/** Write generation `nextGen`'s snapshot to IndexedDB off the main thread via
 *  a transferable (zero-copy) postMessage. Only for the routine debounced path
 *  — see `landDirect` for the must-land-before-unload path. */
function writeSnapshotViaWorker(
  snap: Uint8Array,
  nextGen: number,
): Promise<void> {
  const id = ++persistReqId;
  return new Promise((resolve, reject) => {
    pendingWrites.set(id, { resolve, reject });
    try {
      getPersistWorker().postMessage(
        {
          id,
          key: dbKey(),
          logKey: logKey(),
          lockKey: lockKey(),
          token: activeLock?.token,
          gen: nextGen,
          snap,
        },
        [snap.buffer],
      );
    } catch (e) {
      pendingWrites.delete(id);
      reject(e);
    }
  });
}

function logBytes(log: SnapRec[]): number {
  return log.reduce((n, e) => n + e.snap.byteLength, 0);
}

/** Land `snap` as generation `nextGen` directly on the main thread: the main
 *  record and its snapshot-log entry go in ONE transaction, so a crash or
 *  storage failure can leave at most a MISSING write, never a torn one. Used
 *  by `flushPersist()` (a page about to unload can't reliably wait on a worker
 *  round trip) and as the worker's fallback. */
async function landDirect(snap: Uint8Array, nextGen: number): Promise<void> {
  await kv().transaction(async (tx) => {
    const held = (await tx.get(lockKey())) as LockVal | null;
    const cur = (await tx.get(dbKey())) as SnapRec | null;
    if (
      !activeLock ||
      held?.token !== activeLock.token ||
      Date.now() - held.ts > LOCK_TTL_MS ||
      (cur?.gen ?? -1) >= nextGen
    )
      throw new Error("Stale persistence writer rejected");
    return tx.get(logKey()).then((oldLog) => {
      const old = Array.isArray(oldLog) ? (oldLog as SnapRec[]) : [];
      let log = [{ gen: nextGen, snap }, ...old].slice(0, MAX_LOG);
      // Cap by total bytes as well so a huge workspace can't blow out storage.
      while (log.length && logBytes(log) > LOG_MAX_BYTES) log.pop();
      return tx
        .put(logKey(), log)
        .then(() =>
          tx.put(dbKey(), { gen: nextGen, snap, writer: activeLock!.token }),
        );
    });
  });
}

async function persistImpl(
  direct: boolean,
  lockWaitMs?: number,
): Promise<void> {
  if (!sqlDb) return;

  if (!(await acquireLock(lockWaitMs)))
    throw new Error("Persist lock busy; pending work retained");
  try {
    await assertNotWiped();
    // Generation check (the heart of the fix): if the store's current snapshot
    // is from a generation AHEAD of this tab's base, another tab committed
    // first. Resync — load their snapshot and replay this tab's unflushed
    // mutations on top — so a stale tab's older state can never be written
    // back over newer committed work.
    let gen = baseGen;
    const cur = (await kv().get(dbKey())) as SnapRec | null;
    if (cur && cur.gen > gen && validSnapshot(await getSql(), cur.snap)) {
      gen = cur.gen;
      await resyncFromStore(cur.snap, cur.gen);
    }

    const nextGen = Math.max(gen, cur?.gen ?? 0) + 1;
    const t0 = performance.now();
    let writtenCount = mutLog.length;
    const data = sqlDb.export();
    clearLiveStmtCache(); // export() finalized every prepared statement
    perf.record("persist", "export", performance.now() - t0);
    const t1 = performance.now();

    if (direct || directRequests || persistWorkerBroken) {
      await landDirect(data, nextGen);
    } else {
      try {
        await writeSnapshotViaWorker(data, nextGen);
      } catch (e) {
        // The worker (or its write) failed. The snapshot buffer was transferred
        // and lost with the message, so re-export (cheap, ~1ms) and land the
        // write on the main thread rather than dropping it.
        console.error(
          "[carbon] persist worker write failed; writing directly:",
          e,
        );
        if (!sqlDb) return;
        const receipt = (await kv().get(dbKey())) as SnapRec | null;
        if (receipt?.gen !== nextGen || receipt.writer !== activeLock?.token) {
          writtenCount = mutLog.length;
          const retry = sqlDb.export();
          clearLiveStmtCache();
          await landDirect(retry, nextGen);
        } // A committed worker whose acknowledgement was lost already landed the original prefix.
      }
    }
    perf.record("persist", "idb", performance.now() - t1);

    baseGen = nextGen;
    mutLog.splice(0, writtenCount); // Edits made while awaiting IDB remain pending.
    // Tell peer tabs of this namespace: they resync (and never clobber us).
    postMsg({ t: "persisted", gen: nextGen, tab: tabId });
  } finally {
    await releaseLock();
  }
}

export async function persist(): Promise<void> {
  return serialize(() => persistImpl(false));
}

/** Cancel a paused worker so its operation falls back directly, then serialize
 * the requested write behind that fallback. Never resolve an old waiter with a
 * queued operation that depends on that same waiter. The lease/receipt fence
 * handles both aborted writes and commits whose acknowledgement was lost. */
function supersedePendingWrites(write: () => Promise<void>): Promise<void> {
  directRequests++;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (persistWorker && pendingWrites.size) {
    persistWorker.terminate();
    persistWorker = null;
    const waiters = [...pendingWrites.values()];
    pendingWrites.clear();
    for (const waiter of waiters)
      waiter.reject(new Error("Worker superseded by direct flush"));
  }
  return serialize(write).finally(() => {
    directRequests--;
  });
}

/** Flush any pending debounced save immediately (e.g. the tab is about to hide or
 *  close). Returns the persist promise so callers can await it where possible.
 *  Writes directly on the main thread (bypasses the worker) since a page about to
 *  unload can't reliably wait on a cross-thread round trip; any in-flight worker
 *  write is killed first so its older snapshot can't land after this one. */
export function flushPersist(): Promise<void> {
  return supersedePendingWrites(() => persistImpl(true));
}

// ----- identity rebind (workspace switch / sign-in / sign-out) ---------------

let rebindPromise: Promise<void> | null = null;

/**
 * Cancel every write that could still land under the OLD identity: clear the
 * debounce, terminate the worker, settle its waiters. The killed writes are
 * superseded by the identity switch itself (their work is flushed first by
 * `rebindIdentity`).
 */
function cancelInFlightWrites(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (persistWorker) {
    persistWorker.terminate();
    persistWorker = null;
  }
  if (pendingWrites.size) {
    for (const p of pendingWrites.values()) p.resolve();
    pendingWrites.clear();
  }
}

async function doRebind(next: string, flushOld = true): Promise<void> {
  if (dbInstance) {
    // 1. Land this identity's pending work under its OWN store — unless the old
    //    store was just deliberately wiped (sign-out erase), where re-persisting
    //    the still-live in-memory DB would resurrect the data we just erased.
    if (flushOld) {
      do {
        await persistImpl(true);
      } while (mutLog.length);
    }
    // 2. Nothing in flight may land under the old store afterwards.
    cancelInFlightWrites();
    // 3. Release the old identity's persist lock.
    await releaseLock().catch(() => {});
  }
  postMsg({ t: "rebind", tab: tabId });
  // 4. Swap the binding, drop the live state for the old identity.
  boundNs = next;
  closePeerChannel();
  sqlDb?.close();
  sqlDb = null;
  dbInstance = null;
  mutLog = [];
  baseGen = 0;
  // 5. Boot the new identity (binds, loads its store, reopens the channel).
  await initDbImpl();
  // 6. Re-read the new identity's namespaced settings + user into the UI.
  void import("./store")
    .then((m) => m.useStore.getState().reloadIdentitySettings())
    .catch(() => {
      /* store unavailable (e.g. mid-test) */
    });
}

/**
 * Re-bind this tab when the derived identity changed (sign-in, sign-out,
 * workspace/URL switch) — see docs/internal/a3/design.md. Full identity
 * comparison: a no-op when unchanged, so it's safe to call after any operation
 * that *might* have changed the identity. Callers gate the trigger themselves:
 *  - the server-config listener only calls it when the URL workspace changed
 *    (a 401 that only clears the token on the SAME server does not rebind — the
 *    user's data stays visible under the sign-in gate);
 *  - sign-in / sign-out call it unconditionally.
 * Concurrent callers share one rebind. The old identity's pending work is
 * flushed to its own store before the swap, so nothing is lost and nothing
 * leaks across identities.
 */
export function rebindIdentity(flushOld = true): Promise<void> {
  const next = identityKey();
  if (rebindPromise) return rebindPromise;
  if (boundNs === next) return Promise.resolve();
  if (!rebindPromise) {
    rebindPromise = supersedePendingWrites(async () => {
      let shouldFlush = flushOld;
      while (boundNs !== identityKey()) {
        await doRebind(identityKey(), shouldFlush);
        shouldFlush = true;
      }
    }).finally(() => {
      rebindPromise = null;
    });
  }
  return rebindPromise;
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
export function registerPersistFlush(
  flush: () => void = defaultPersistFlushHandler,
): void {
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flush();
    } else if (document.visibilityState === "visible" && bc) {
      // A throttled background tab can miss peer 'persisted' messages while
      // it's hidden — re-check the store when it comes back to the front so
      // it never writes on top of state it never saw.
      void catchUpToStore().catch((err) =>
        console.warn("[carbon] tab catch-up failed:", err),
      );
    }
  });
  window.addEventListener("pagehide", flush);
}

/** Raw bytes of the current SQLite database (for backup/export). */
export function exportDb(): Uint8Array {
  if (!sqlDb) throw new Error("DB not initialized");
  const data = sqlDb.export();
  clearLiveStmtCache(); // export() finalized every prepared statement
  return data;
}

/** Overwrite the persisted database with imported bytes. Reload the app after.
 *  Pending debounced/worker writes of the old live DB are killed first — one
 *  landing after this write would silently undo the import before the reload.
 *  The bytes are validated up front: a corrupt import must not clobber a good
 *  store (recovery would silently roll the user back to the last snapshot). */
export async function importDb(bytes: Uint8Array): Promise<void> {
  if (!validSnapshot(await getSql(), bytes)) {
    throw new Error("Import rejected: not a valid Carbon database");
  }
  await supersedePendingWrites(async () => {
    if (!(await acquireLock()))
      throw new Error("Import rejected: another tab is persisting");
    try {
      await assertNotWiped();
      const cur = (await kv().get(dbKey())) as SnapRec | null;
      const nextGen = Math.max(baseGen, cur?.gen ?? 0) + 1;
      await landDirect(bytes, nextGen);
      baseGen = nextGen;
      mutLog = [];
      await resyncFromStore(bytes, nextGen);
      postMsg({ t: "persisted", gen: nextGen, tab: tabId });
    } finally {
      await releaseLock();
    }
  });
}

/** Stage a merge on the latest durable state plus local edits. No imported rows
 * become live until the complete snapshot commits; late local edits are replayed. */
export async function commitImport(apply: (db: Db) => void, expectedIdentity: string): Promise<void> {
  await supersedePendingWrites(async () => {
    if (identityKey() !== expectedIdentity || boundNs !== expectedIdentity)
      throw new Error("Import cancelled: workspace changed");
    if (!(await acquireLock())) throw new Error("Import busy: another tab is saving; retry");
    try {
      await assertNotWiped();
      const SQL = await getSql();
      const cur = (await kv().get(dbKey())) as SnapRec | null;
      if (cur && cur.gen > baseGen) await resyncFromStore(cur.snap, cur.gen);
      if (!sqlDb) throw new Error("Import cancelled: database closed");
      const bytes = sqlDb.export();
      clearLiveStmtCache();
      const staged = new SQL.Database(bytes);
      let merged: Uint8Array;
      try {
        const wrapped = wrap(staged);
        apply(wrapped.db);
        wrapped.clearCache();
        merged = staged.export();
      } finally { staged.close(); }
      const writtenCount = mutLog.length;
      const nextGen = Math.max(baseGen, cur?.gen ?? 0) + 1;
      if (identityKey() !== expectedIdentity) throw new Error("Import cancelled: workspace changed");
      await landDirect(merged, nextGen);
      mutLog.splice(0, writtenCount);
      await resyncFromStore(merged, nextGen);
      postMsg({ t: "persisted", gen: nextGen, tab: tabId });
    } finally { await releaseLock(); }
  });
}

/** Erase the persisted local database (items, ops, tags, sync cursors, device id).
 *  Server credentials live in localStorage and are left untouched, so the next
 *  launch signs back in and re-pulls everything fresh from the server. The live
 *  in-memory DB still holds the old data after this resolves — callers MUST reload
 *  the app immediately (any pending write would otherwise re-persist the old data,
 *  so those are superseded first). */
export async function wipeLocalDb(): Promise<void> {
  await supersedePendingWrites(async () => {
    await eraseNamespace(ns());
    eraseIdentitySettings(ns());
    // Keep the old binding until its blob clear completes; a concurrent rebind
    // must never redirect this erase into the next account's cache.
    await clearBlobs();
    postMsg({ t: "wiped", tab: tabId });
  });
}

/** Count of non-deleted items (projects + tasks) held in the local DB. Used to
 *  decide whether signing in should offer to merge or replace local data. */
export function localItemCount(): number {
  if (!dbInstance) return 0;
  const row = dbInstance.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM items WHERE deleted = 0",
  );
  return row?.n ?? 0;
}

/** The device-local namespace — pre-sign-in capture (see identityKey). */
const LOCAL_NS = "local|local";

/** Count of non-deleted items held in the device-local CAPTURE's durable
 *  snapshot. This drives the sign-in merge/replace prompt: before signing in,
 *  work is namespaced under local|local, a *separate* store from the signed-in
 *  identity's — so the live DB count (localItemCount) wouldn't see it. */
export async function localNamespaceItemCount(): Promise<number> {
  const saved = (await kv().get(dbKey(LOCAL_NS))) as SnapRec | null;
  if (!saved) return 0;
  const sdb = tryOpenSnapshot(await getSql(), saved.snap);
  if (!sdb) return 0;
  const res = sdb.exec("SELECT COUNT(*) FROM items WHERE deleted = 0");
  sdb.close();
  return (res[0]?.values?.[0]?.[0] as number) ?? 0;
}

/**
 * Merge the device-local capture into the current (signed-in) identity: replay
 * its op log (items + record-ops) into the live DB, re-stamping each op's
 * device id to this device, claim the now-unowned items for the user, then
 * consume (wipe) the capture so it is never merged twice. Returns the number of
 * item ops replayed. Called from the sign-in merge step.
 *
 * markSynced=false on the replayed ops: they were captured pre-sign-in and were
 * never pushed, so they must be pushed to the newly-joined server.
 */
export async function mergeLocalCapture(userId: string): Promise<number> {
  const destination = getBoundIdentity();
  if (!destination || destination === LOCAL_NS)
    throw new Error("Sign in before merging local capture");
  const saved = (await kv().get(dbKey(LOCAL_NS))) as SnapRec | null;
  if (!saved) return 0;
  const sdb = tryOpenSnapshot(await getSql(), saved.snap);
  if (!sdb) return 0;

  const db = getDb();
  const deviceId = getDeviceId();

  const ops: Op[] = sdb
    .exec("SELECT id, item_id, ts, fields FROM ops")
    .flatMap((r) =>
      r.values.map((v) => ({
        id: v[0] as string,
        item_id: v[1] as string,
        ts: Number(v[2]),
        device_id: deviceId,
        fields: JSON.parse(v[3] as string),
      })),
    );
  const recordOps: RecordOp[] = sdb
    .exec("SELECT id, entity, row_id, ts, data FROM record_ops")
    .flatMap((r) =>
      r.values.map((v) => ({
        id: v[0] as string,
        entity: v[1] as string,
        row_id: v[2] as string,
        ts: Number(v[3]),
        device_id: deviceId,
        data: JSON.parse(v[4] as string),
      })),
    );
  sdb.close();
  for (const op of recordOps) {
    if (op.entity !== 'review_progress') continue;
    const data = op.data as { id: string; user_id: string; item_id: string; cycle: string; entry_key: string };
    data.user_id = userId;
    data.id = reviewEntryId(userId, data.item_id, data.cycle, data.entry_key);
    op.row_id = data.id;
  }

  if (getBoundIdentity() !== destination)
    throw new Error("Identity changed during capture merge");
  const itemsResult = ingestOps(db, ops, false);
  const recordsResult = ingestRecordOps(db, recordOps, false);
  if (itemsResult.skipped.length || recordsResult.skipped.length)
    throw new Error("Capture contains unappliable edits; source retained");
  claimUnowned(db, deviceId, userId);

  // Only consume after the destination is durable. A concurrent source edit
  // keeps the source intact for another merge (op IDs make retries idempotent).
  await flushPersist();
  if (getBoundIdentity() !== destination)
    throw new Error("Identity changed during capture merge; source retained");
  await eraseNamespace(LOCAL_NS, saved.gen);

  return ops.length;
}

/** Consume (wipe) the device-local capture's durable store — the "replace"
 *  path at sign-in discards the capture and re-pulls everything from the
 *  server. */
export async function discardLocalCapture(): Promise<void> {
  await eraseNamespace(LOCAL_NS);
}

async function eraseNamespace(
  namespace: string,
  expectedGen?: number,
): Promise<void> {
  await kv().transaction(async (tx) => {
    const current = (await tx.get(dbKey(namespace))) as SnapRec | null;
    if (expectedGen !== undefined && current?.gen !== expectedGen) return;
    // Revocation and deletion are atomic. Even a sleeping peer missing the
    // broadcast must check this epoch before writing its old in-memory state.
    await tx.put(wipeKey(namespace), `${tabId}:${++lockSerial}`);
    await tx.del(dbKey(namespace));
    await tx.del(logKey(namespace));
    await tx.del(lockKey(namespace));
  });
}

/** Open backup bytes as a throwaway in-memory DB to read from, without touching
 *  the live database. Caller is done with it once it falls out of scope. */
export async function openSnapshot(bytes: Uint8Array): Promise<Db & { close(): void }> {
  const SQL = await getSql();
  const sdb = new SQL.Database(bytes);
  sdb.run("PRAGMA foreign_keys = OFF");
  const wrapped = wrap(sdb);
  return Object.assign(wrapped.db, { close() { wrapped.clearCache(); sdb.close(); } });
}

/**
 * Open a read-only snapshot of the persisted database straight from IndexedDB,
 * without initializing the live DB. Returns null when nothing has been persisted
 * yet. Used by the desktop quick-add window to read tags/users for autocomplete
 * while leaving all writes to the main window (the single DB owner).
 */
export async function loadSnapshot(): Promise<Db | null> {
  const saved = (await kv().get(dbKey())) as SnapRec | null;
  if (!saved) return null;
  const opened = tryOpenSnapshot(await getSql(), saved.snap);
  if (!opened) return null;
  return wrap(opened).db;
}

// ----- meta key/value helpers ----------------------------------------------

export function getMeta(key: string): string | null {
  const row = getDb().get<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
    [key],
  );
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb().run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
