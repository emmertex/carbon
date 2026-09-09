import localforage from "localforage";
import { blobRefIndex, type Db } from "@carbon/core";
import {
  getServerConfig,
  authHeaders,
  getWorkspaceAuthState,
  workspaceHostOf,
} from "./config";
import { identityKey } from "./identity";

/**
 * Per-identity blob stores: each identity gets its own localforage store
 * (`blobs|<identity>`) inside the same `carbon` IndexedDB database, so one
 * user's cache and pending-upload queue can never touch another's (see
 * identity.ts). The identity is captured on first use (always post-boot) —
 * the same per-tab binding as db.ts: a stale tab keeps writing its own store().
 */
const storeCache = new Map<string, typeof localforage>();
let capturedNs: string | null = null;

function myNs(): string {
  if (!capturedNs) capturedNs = identityKey();
  return capturedNs;
}

let _testStore: typeof localforage | null = null;

/** Test hook: inject a mock storage instance (e.g. in-memory map). */
export function setBlobStoreForTest(s: typeof localforage | null): void {
  _testStore = s;
}

function store(): typeof localforage {
  if (_testStore) return _testStore;
  const key = myNs();
  let s = storeCache.get(key);
  if (!s) {
    s = localforage.createInstance({
      name: "carbon",
      storeName: `blobs|${key}`,
    });
    storeCache.set(key, s);
  }
  return s;
}

let bindingGeneration = 0;
let bindingController = new AbortController();
let durableGuard: (() => Promise<void>) | undefined;
const contexts = new WeakMap<
  typeof localforage,
  {
    generation: number;
    ns: string;
    cfg: ReturnType<typeof getServerConfig>;
    signal: AbortSignal;
    authState: ReturnType<typeof getWorkspaceAuthState>;
  }
>();

/** Cancel network requests at sign-out, including keep-offline with unchanged identity. */
export function cancelBlobRequests(): void {
  bindingController.abort();
  bindingController = new AbortController();
}

/** Bind together with the live SQLite DB, invalidating all old continuations. */
export function bindBlobIdentity(
  namespace: string,
  guard?: () => Promise<void>,
  force = false,
): void {
  if (capturedNs === namespace && !force) {
    durableGuard = guard ?? durableGuard;
    return;
  }
  bindingController.abort();
  bindingController = new AbortController();
  bindingGeneration++;
  capturedNs = namespace;
  durableGuard = guard;
  if (metaFlushTimer) clearTimeout(metaFlushTimer);
  metaFlushTimer = null;
  metaCache = null;
  metaDirty = false;
  prefetching = false;
  for (const pending of objectUrls.values())
    void pending
      .then((url) => {
        if (url) URL.revokeObjectURL(url);
      })
      .catch(() => {});
  objectUrls.clear();
}

function guardedStore(): typeof localforage {
  const target = store();
  const generation = bindingGeneration;
  const guard = durableGuard;
  const check = () => {
    if (generation !== bindingGeneration)
      throw new Error("Blob identity changed; stale operation discarded");
  };
  const proxy = new Proxy(target, {
    get(obj, key) {
      const value = Reflect.get(obj, key);
      if (
        !["getItem", "setItem", "removeItem", "clear", "keys"].includes(
          String(key),
        )
      )
        return value;
      return async (...args: unknown[]) => {
        check();
        await guard?.();
        check();
        const result = await value.apply(obj, args);
        check();
        return result;
      };
    },
  });
  const cfg = getServerConfig();
  contexts.set(proxy, {
    generation,
    ns: myNs(),
    cfg,
    signal: bindingController.signal,
    authState: getWorkspaceAuthState(workspaceHostOf(cfg.url)),
  });
  return proxy;
}

function networkGeneration(s: typeof localforage): void {
  if (contexts.get(s)?.generation !== bindingGeneration)
    throw new Error("Blob identity changed");
}

function networkContext(s: typeof localforage) {
  const ctx = contexts.get(s)!;
  const current = getServerConfig();
  if (
    ctx.signal.aborted ||
    ctx.generation !== bindingGeneration ||
    ctx.ns !== identityKey() ||
    current.url !== ctx.cfg.url ||
    current.token !== ctx.cfg.token ||
    current.username !== ctx.cfg.username ||
    getWorkspaceAuthState(workspaceHostOf(current.url)) !== ctx.authState
  ) {
    throw new Error("Blob identity does not match configured account");
  }
  return ctx;
}

/** Test hook: drop the captured identity + cached store instances. */
export function resetBlobsForTest(): void {
  bindBlobIdentity(myNs(), undefined, true);
  capturedNs = null;
  durableGuard = undefined;
  storeCache.clear();
  metaCache = null;
  metaDirty = false;
}

/** The pre-A3 single-tenant blob store (read only by the one-time migration). */
const LEGACY_BLOBS = localforage.createInstance({
  name: "carbon",
  storeName: "blobs",
});
const PENDING_KEY = "pendingBlobs";

/**
 * One-time, idempotent: move the pre-A3 shared `blobs` store into the current
 * identity's store (only when the new store is empty — never over data).
 * A global atomic owner claim prevents a second account from copying the source.
 */
export async function migrateLegacyBlobs(
  claimOwner: () => Promise<boolean>,
): Promise<void> {
  const dst = guardedStore();
  let keys: string[];
  try {
    keys = await LEGACY_BLOBS.keys();
  } catch {
    return;
  }
  if (!keys.length || !(await claimOwner())) return;
  // An occupied destination is not proof that legacy-only work was migrated.
  // Retain it for recovery, under the single globally claimed owner.
  if ((await dst.keys()).length) return;
  for (const key of keys) {
    const value = await LEGACY_BLOBS.getItem(key);
    if (value != null) await dst.setItem(key, value);
  }
  // Keep legacy bytes for recovery. Copy and consumption span separate stores;
  // retaining the globally claimed source also makes partial failures safe.
}
/** Per-hash `{ size, at }` bookkeeping that drives least-recently-used eviction. */
const META_KEY = "blobMeta";
/** Keys in the blob store that are bookkeeping, not blob content. */
const RESERVED_KEYS = new Set([PENDING_KEY, META_KEY]);

// Per-attachment size cap. Mirrors the server default (BLOB_MAX_MB, 25 MB): the
// server rejects larger uploads with 413, so accepting one here would just create a
// broken attachment whose blob can never sync. Reject up front instead.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;

/** Thrown by storeFile when a file exceeds MAX_ATTACHMENT_BYTES. */
export class AttachmentTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`Attachment exceeds the ${MAX_ATTACHMENT_MB} MB limit`);
    this.name = "AttachmentTooLargeError";
  }
}

export async function hashFile(file: File | Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getPending(s = guardedStore()): Promise<string[]> {
  return (await s.getItem<string[]>(PENDING_KEY)) ?? [];
}

/** Number of blobs still queued for upload (the local copy is the only copy
 *  until the server has them) — used to detect unsynced work before erasing. */
export async function pendingBlobCount(): Promise<number> {
  return (await getPending()).length;
}
async function addPending(hash: string, s = guardedStore()): Promise<void> {
  const p = await getPending(s);
  if (!p.includes(hash)) await s.setItem(PENDING_KEY, [...p, hash]);
}
async function removePending(hash: string, s = guardedStore()): Promise<void> {
  await s.setItem(
    PENDING_KEY,
    (await getPending(s)).filter((h) => h !== hash),
  );
}

// ----- LRU bookkeeping ------------------------------------------------------
// Eviction needs two things the blob store can't answer cheaply: how big each
// cached blob is, and when it was last actually used. Both are kept in a single
// `blobMeta` record, held in memory and flushed lazily — a display-time `touch`
// must not cost an IndexedDB write per <img>.

interface BlobMetaEntry {
  /** Byte length of the cached blob. */
  size: number;
  /** Epoch ms of the last read/write through this module. */
  at: number;
}
type BlobMeta = Record<string, BlobMetaEntry>;

let metaCache: BlobMeta | null = null;
let metaDirty = false;
let metaFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function loadMeta(s = guardedStore()): Promise<BlobMeta> {
  networkGeneration(s);
  if (!metaCache) metaCache = (await s.getItem<BlobMeta>(META_KEY)) ?? {};
  return metaCache;
}

async function flushMeta(s = guardedStore()): Promise<void> {
  networkGeneration(s);
  if (metaFlushTimer) {
    clearTimeout(metaFlushTimer);
    metaFlushTimer = null;
  }
  if (!metaDirty || !metaCache) return;
  metaDirty = false;
  await s.setItem(META_KEY, metaCache);
}

function scheduleMetaFlush(): void {
  metaDirty = true;
  if (metaFlushTimer) return;
  metaFlushTimer = setTimeout(() => void flushMeta().catch(() => {}), 5_000);
}

/** Record that `hash` was just read or written (and how big it is). Fire-and-forget. */
function touch(hash: string, size?: number): void {
  const generation = bindingGeneration;
  void loadMeta()
    .then((meta) => {
      if (generation !== bindingGeneration) return;
      const prev = meta[hash];
      meta[hash] = { size: size ?? prev?.size ?? 0, at: Date.now() };
      scheduleMetaFlush();
    })
    .catch(() => {});
}

async function forgetMeta(hashes: string[], s = guardedStore()): Promise<void> {
  const meta = await loadMeta(s);
  for (const h of hashes) delete meta[h];
  metaDirty = true;
  await flushMeta(s);
}

/** Store a file locally by content hash and queue it for upload. */
export async function storeFile(file: File): Promise<string> {
  const s = guardedStore();
  if (file.size > MAX_ATTACHMENT_BYTES)
    throw new AttachmentTooLargeError(file.size);
  const hash = await hashFile(file);
  const buf = await file.arrayBuffer();
  await s.setItem(hash, buf);
  touch(hash, buf.byteLength);
  await addPending(hash, s);
  return hash;
}

/** A blob already in the local cache, without ever hitting the network. Used where
 *  a miss is fine (thumbnail generation, offline previews) and a silent multi-MB
 *  download would not be. */
export async function getCachedBlob(
  hash: string,
  mime: string | null,
): Promise<Blob | null> {
  const s = guardedStore();
  const local = await s.getItem<ArrayBuffer>(hash);
  if (!local) return null;
  touch(hash, local.byteLength);
  return new Blob([local], { type: mime || "application/octet-stream" });
}

/** Get a blob by hash: from local cache, else download + cache. null if unavailable. */
export async function getBlob(
  hash: string,
  mime: string | null,
): Promise<Blob | null> {
  const s = guardedStore();
  const local = await s.getItem<ArrayBuffer>(hash);
  if (local) {
    touch(hash, local.byteLength);
    return new Blob([local], { type: mime || "application/octet-stream" });
  }
  const { cfg, signal } = networkContext(s);
  if (!cfg.url) return null;
  try {
    const res = await fetch(cfg.url.replace(/\/$/, "") + `/api/blobs/${hash}`, {
      headers: authHeaders(cfg),
      signal,
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    networkContext(s);
    await s.setItem(hash, buf);
    touch(hash, buf.byteLength);
    return new Blob([buf], { type: mime || "application/octet-stream" });
  } catch {
    return null;
  }
}

/** The hash in a `/api/blobs/{hash}` image src, lowercased, or null if the src
 *  isn't a blob reference. */
export function blobSrcHash(src: string | undefined | null): string | null {
  const m = /^\/api\/blobs\/([0-9a-fA-F]{64})$/.exec(src ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

// Session-lived object URLs by content hash. Blobs are content-addressed and
// therefore immutable, so a resolved URL never goes stale — cache it instead of
// creating/revoking one per <img> mount.
const objectUrls = new Map<string, Promise<string | null>>();

/** Resolve a blob hash to an object URL for use as an <img> src. An <img> must
 *  never point at `/api/blobs/...` directly: image requests carry no
 *  Authorization header (Carbon auths with a Bearer token, not cookies), so the
 *  server answers 401; on native hosts the relative URL doesn't even reach the
 *  server. This goes through getBlob — local cache first, authed fetch second. */
export function getBlobObjectUrl(hash: string): Promise<string | null> {
  let p = objectUrls.get(hash);
  if (!p) {
    const generation = bindingGeneration;
    p = getBlob(hash, null)
      .then((blob) =>
        blob && generation === bindingGeneration
          ? URL.createObjectURL(blob)
          : null,
      )
      .catch(() => null);
    objectUrls.set(hash, p);
    // A miss (offline, or the blob hasn't synced from another device yet) must
    // not be cached forever — drop it so a later render retries the fetch.
    void p.then((url) => {
      if (!url && objectUrls.get(hash) === p) objectUrls.delete(hash);
    });
  }
  return p;
}

/** All locally-cached blobs by content hash (for backup/export). */
export async function exportBlobs(): Promise<Record<string, ArrayBuffer>> {
  const s = guardedStore();
  const out: Record<string, ArrayBuffer> = {};
  for (const key of await s.keys()) {
    if (RESERVED_KEYS.has(key)) continue;
    const buf = await s.getItem<ArrayBuffer>(key);
    if (buf) out[key] = buf;
  }
  return out;
}

/** Drop every locally-cached blob and the pending-upload queue. Used when wiping
 *  the local database — blobs live in a separate localforage store and would
 *  otherwise survive the reset. They re-download from the server on demand after
 *  the next sync. */
export async function clearBlobs(): Promise<void> {
  const target = store();
  bindBlobIdentity(myNs(), durableGuard, true);
  await target.clear();
}

/** Revoke all created object URLs (used by clearBlobs/replaceBlobs). */
export function revokeAllObjectUrls(): void {
  for (const p of objectUrls.values()) {
    p.then((u) => {
      if (u) URL.revokeObjectURL(u);
    });
  }
  objectUrls.clear();
}

/** Replace all locally-cached blobs (for import). */
export async function replaceBlobs(
  map: Record<string, ArrayBuffer>,
): Promise<void> {
  await clearBlobs();
  const s = guardedStore();
  for (const [hash, buf] of Object.entries(map)) {
    await s.setItem(hash, buf);
    touch(hash, buf.byteLength);
  }
  await flushMeta(s);
}

/** Merge imported blobs into the cache and queue them for upload to the server. */
export async function addImportedBlobs(
  map: Record<string, ArrayBuffer>,
): Promise<void> {
  const s = guardedStore();
  for (const [hash, buf] of Object.entries(map)) {
    await s.setItem(hash, buf);
    touch(hash, buf.byteLength);
    await addPending(hash, s);
  }
  await flushMeta(s);
}

/** Upload any locally-stored blobs the server doesn't have yet. */
export async function uploadPendingBlobs(): Promise<void> {
  const s = guardedStore();
  const { cfg, signal } = networkContext(s);
  if (!cfg.url) return;
  for (const hash of await getPending(s)) {
    const buf = await s.getItem<ArrayBuffer>(hash);
    if (!buf) {
      await removePending(hash, s);
      continue;
    }
    try {
      networkContext(s);
      const res = await fetch(
        cfg.url.replace(/\/$/, "") + `/api/blobs/${hash}`,
        {
          signal,
          method: "POST",
          headers: {
            ...authHeaders(cfg),
            "Content-Type": "application/octet-stream",
          },
          body: buf,
        },
      );
      // Rejections (including 413) retain the only local copy and pending marker.
      // 507 means the workspace storage quota is full: keep the blob pending so it
      // uploads once space frees up or the host admin raises the cap.
      if (res.status === 507) {
        console.warn("[carbon] upload deferred: workspace storage is full");
      } else if (res.ok) {
        networkContext(s);
        await removePending(hash, s);
      }
    } catch {
      /* stay pending; retry next sync */
    }
  }
}

// ----- cache policy: prefetch + LRU eviction --------------------------------
// Notes and attachments can dwarf the item graph. A per-device setting
// (Settings → Sync server) decides how much this device pulls ahead of time:
//
//   'on-demand'  — prefetch nothing; every blob, thumbnails included, arrives the
//                  first time something displays it.
//   'thumbnails' — prefetch row thumbnails only (the default). Note lists render
//                  complete and offline; full-size images wait until opened.
//   'all'        — prefetch every referenced blob on each sync.
//
// The first two then prune the cache back to the MB budget, oldest-used first;
// 'all' never prunes. Thumbnails are never evicted in ANY mode — they're what lets
// a list of image notes render without a single full-size download, and re-earning
// them costs far more than the kilobytes they occupy.

/** Parallel blob downloads during a prefetch pass — enough to hide latency, few
 *  enough to leave the sync request and the UI some bandwidth. */
const PREFETCH_CONCURRENCY = 4;

/** True once a prefetch pass is running; a second sync must not stack another. */
let prefetching = false;

async function fetchIntoCache(
  hash: string,
  s = guardedStore(),
): Promise<boolean> {
  if (await s.getItem<ArrayBuffer>(hash)) return false;
  const { cfg, signal } = networkContext(s);
  if (!cfg.url) return false;
  try {
    const res = await fetch(cfg.url.replace(/\/$/, "") + `/api/blobs/${hash}`, {
      headers: authHeaders(cfg),
      signal,
    });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    networkContext(s);
    await s.setItem(hash, buf);
    touch(hash, buf.byteLength);
    return true;
  } catch {
    return false; // offline / transient — retried on the next sync
  }
}

/** Download `hashes` (skipping already-cached ones) with bounded concurrency. */
async function fetchAll(hashes: string[], s = guardedStore()): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(PREFETCH_CONCURRENCY, hashes.length) },
    async () => {
      while (next < hashes.length) {
        const hash = hashes[next++]!;
        await fetchIntoCache(hash, s);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Drop least-recently-used blobs until the cache fits `blobCacheMb`.
 *
 * Never evicts: thumbnails (kilobytes each, and the thing lists are drawn from),
 * blobs still queued for upload (the local copy is the only copy until the server
 * has it), or anything when the budget is 0 / the policy is 'all'. Returns the
 * number of bytes freed.
 *
 * This runs automatically, so it stays conservative about thumbnails in every mode;
 * the manual `flushBlobCache` is the one that will give them up. */
export async function pruneBlobCache(keepThumbs: Set<string>): Promise<number> {
  const s = guardedStore();
  const cfg = getServerConfig();
  if (cfg.blobFetch === "all") return 0;
  const budget = Math.max(0, cfg.blobCacheMb) * 1024 * 1024;
  if (budget <= 0) return 0;

  const pending = new Set(await getPending(s));
  const meta = await loadMeta(s);
  const keys = (await s.keys()).filter((k) => !RESERVED_KEYS.has(k));

  // Size may be unknown for blobs cached before this bookkeeping existed; read it
  // once here and record it, so later passes are pure metadata.
  const entries: { hash: string; size: number; at: number }[] = [];
  let total = 0;
  for (const hash of keys) {
    let size = meta[hash]?.size ?? 0;
    if (!size) {
      size = (await s.getItem<ArrayBuffer>(hash))?.byteLength ?? 0;
      meta[hash] = { size, at: meta[hash]?.at ?? 0 };
      metaDirty = true;
    }
    total += size;
    if (keepThumbs.has(hash) || pending.has(hash)) continue;
    entries.push({ hash, size, at: meta[hash]?.at ?? 0 });
  }
  if (total <= budget) {
    await flushMeta(s);
    return 0;
  }

  // Oldest-used first — "most time since used", the flush order asked for.
  entries.sort((a, b) => a.at - b.at);
  const dropped: string[] = [];
  let freed = 0;
  for (const e of entries) {
    if (total - freed <= budget) break;
    await s.removeItem(e.hash);
    dropped.push(e.hash);
    freed += e.size;
  }
  if (dropped.length) {
    // A dropped blob's object URL would now resolve to bytes we no longer hold.
    for (const h of dropped) objectUrls.delete(h);
    await forgetMeta(dropped, s);
    console.info(
      `[carbon] blob cache: evicted ${dropped.length} blob(s), ${Math.round(freed / 1024)} KB`,
    );
  } else {
    await flushMeta(s);
  }
  return freed;
}

/**
 * Bring this device's blob cache in line with its policy. Called after each sync.
 *
 * Prefetches according to the mode ('thumbnails' pulls row thumbnails, 'all' pulls
 * those plus every full-size image and attachment, 'on-demand' pulls nothing), then
 * prunes back to budget unless the mode is 'all'.
 *
 * Never throws — a failed prefetch is a cache miss later, not a sync failure.
 */
export async function syncBlobCache(db: Db): Promise<void> {
  const s = guardedStore();
  if (prefetching) return;
  prefetching = true;
  try {
    const mode = getServerConfig().blobFetch;
    const { thumbs, full } = blobRefIndex(db);
    if (mode !== "on-demand") await fetchAll([...thumbs], s);
    if (mode === "all") await fetchAll([...full], s);
    else {
      networkGeneration(s);
      await pruneBlobCache(thumbs);
    }
  } catch (err) {
    console.warn("[carbon] blob cache sync failed:", err);
  } finally {
    if (contexts.get(s)?.generation === bindingGeneration) {
      prefetching = false;
      await flushMeta(s);
    }
  }
}

/** Bytes currently held in the local blob cache (for the settings readout). */
export async function blobCacheBytes(): Promise<number> {
  const s = guardedStore();
  const meta = await loadMeta(s);
  let total = 0;
  for (const key of await s.keys()) {
    if (RESERVED_KEYS.has(key)) continue;
    total +=
      meta[key]?.size ?? (await s.getItem<ArrayBuffer>(key))?.byteLength ?? 0;
  }
  return total;
}

/** What a manual cache flush actually managed to do. Callers report this: a flush
 *  that frees nothing has to be able to say WHY, or it reads as a broken button. */
export interface FlushResult {
  /** Bytes reclaimed. */
  freed: number;
  /** Blobs removed. */
  dropped: number;
  /** Held back because the server hasn't got them yet — the local copy is the only
   *  copy, so dropping them would be data loss, not cache eviction. */
  keptPending: number;
  /** Thumbnails held back (every mode except 'on-demand' — see below). */
  keptThumbs: number;
}

/**
 * Drop cached blobs now, ignoring the MB budget — the manual "free up space"
 * action, and deliberately more aggressive than the automatic `pruneBlobCache`.
 *
 * Two things are never dropped, for different reasons:
 *
 *   - **Pending uploads**, always. Until the server has the bytes, the cache IS
 *     the storage; evicting them would lose the attachment outright.
 *   - **Thumbnails**, unless the mode is 'on-demand'. Under 'thumbnails'/'all' the
 *     very next sync would re-download them, so dropping them is pure churn. Under
 *     'on-demand' the user has said "hold nothing ahead of need", so they go too
 *     and re-fetch when a row scrolls into view — otherwise, on a notes-heavy
 *     workspace where almost everything cached IS a thumbnail, this button appears
 *     to do nothing at all.
 */
export async function flushBlobCache(
  thumbs: Set<string>,
): Promise<FlushResult> {
  const s = guardedStore();
  const keepThumbs = getServerConfig().blobFetch !== "on-demand";
  const pending = new Set(await getPending(s));
  const meta = await loadMeta(s);
  const dropped: string[] = [];
  const out: FlushResult = {
    freed: 0,
    dropped: 0,
    keptPending: 0,
    keptThumbs: 0,
  };
  for (const hash of await s.keys()) {
    if (RESERVED_KEYS.has(hash)) continue;
    if (pending.has(hash)) {
      out.keptPending++;
      continue;
    }
    if (keepThumbs && thumbs.has(hash)) {
      out.keptThumbs++;
      continue;
    }
    out.freed +=
      meta[hash]?.size ?? (await s.getItem<ArrayBuffer>(hash))?.byteLength ?? 0;
    await s.removeItem(hash);
    objectUrls.delete(hash);
    dropped.push(hash);
  }
  out.dropped = dropped.length;
  await forgetMeta(dropped, s);
  return out;
}
