import localforage from 'localforage';
import { blobRefIndex, type Db } from '@carbon/core';
import { getServerConfig, authHeaders } from './config';

// Content-addressed blob cache, separate store from the DB snapshot.
const store = localforage.createInstance({ name: 'carbon', storeName: 'blobs' });
const PENDING_KEY = 'pendingBlobs';
/** Per-hash `{ size, at }` bookkeeping that drives least-recently-used eviction. */
const META_KEY = 'blobMeta';
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
    this.name = 'AttachmentTooLargeError';
  }
}

function url(path: string): string {
  return getServerConfig().url.replace(/\/$/, '') + path;
}

export async function hashFile(file: File | Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getPending(): Promise<string[]> {
  return (await store.getItem<string[]>(PENDING_KEY)) ?? [];
}
async function addPending(hash: string): Promise<void> {
  const p = await getPending();
  if (!p.includes(hash)) await store.setItem(PENDING_KEY, [...p, hash]);
}
async function removePending(hash: string): Promise<void> {
  await store.setItem(PENDING_KEY, (await getPending()).filter((h) => h !== hash));
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

async function loadMeta(): Promise<BlobMeta> {
  if (!metaCache) metaCache = (await store.getItem<BlobMeta>(META_KEY)) ?? {};
  return metaCache;
}

async function flushMeta(): Promise<void> {
  if (metaFlushTimer) {
    clearTimeout(metaFlushTimer);
    metaFlushTimer = null;
  }
  if (!metaDirty || !metaCache) return;
  metaDirty = false;
  await store.setItem(META_KEY, metaCache);
}

function scheduleMetaFlush(): void {
  metaDirty = true;
  if (metaFlushTimer) return;
  metaFlushTimer = setTimeout(() => void flushMeta(), 5_000);
}

/** Record that `hash` was just read or written (and how big it is). Fire-and-forget. */
function touch(hash: string, size?: number): void {
  void loadMeta().then((meta) => {
    const prev = meta[hash];
    meta[hash] = { size: size ?? prev?.size ?? 0, at: Date.now() };
    scheduleMetaFlush();
  });
}

async function forgetMeta(hashes: string[]): Promise<void> {
  const meta = await loadMeta();
  for (const h of hashes) delete meta[h];
  metaDirty = true;
  await flushMeta();
}

/** Store a file locally by content hash and queue it for upload. */
export async function storeFile(file: File): Promise<string> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(file.size);
  const hash = await hashFile(file);
  const buf = await file.arrayBuffer();
  await store.setItem(hash, buf);
  touch(hash, buf.byteLength);
  await addPending(hash);
  return hash;
}

/** A blob already in the local cache, without ever hitting the network. Used where
 *  a miss is fine (thumbnail generation, offline previews) and a silent multi-MB
 *  download would not be. */
export async function getCachedBlob(hash: string, mime: string | null): Promise<Blob | null> {
  const local = await store.getItem<ArrayBuffer>(hash);
  if (!local) return null;
  touch(hash, local.byteLength);
  return new Blob([local], { type: mime || 'application/octet-stream' });
}

/** Get a blob by hash: from local cache, else download + cache. null if unavailable. */
export async function getBlob(hash: string, mime: string | null): Promise<Blob | null> {
  const local = await store.getItem<ArrayBuffer>(hash);
  if (local) {
    touch(hash, local.byteLength);
    return new Blob([local], { type: mime || 'application/octet-stream' });
  }
  const cfg = getServerConfig();
  if (!cfg.url) return null;
  try {
    const res = await fetch(url(`/api/blobs/${hash}`), { headers: authHeaders(cfg) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    await store.setItem(hash, buf);
    touch(hash, buf.byteLength);
    return new Blob([buf], { type: mime || 'application/octet-stream' });
  } catch {
    return null;
  }
}

/** The hash in a `/api/blobs/{hash}` image src, lowercased, or null if the src
 *  isn't a blob reference. */
export function blobSrcHash(src: string | undefined | null): string | null {
  const m = /^\/api\/blobs\/([0-9a-fA-F]{64})$/.exec(src ?? '');
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
    p = getBlob(hash, null).then((blob) => (blob ? URL.createObjectURL(blob) : null));
    objectUrls.set(hash, p);
    // A miss (offline, or the blob hasn't synced from another device yet) must
    // not be cached forever — drop it so a later render retries the fetch.
    void p.then((url) => {
      if (!url) objectUrls.delete(hash);
    });
  }
  return p;
}

/** All locally-cached blobs by content hash (for backup/export). */
export async function exportBlobs(): Promise<Record<string, ArrayBuffer>> {
  const out: Record<string, ArrayBuffer> = {};
  for (const key of await store.keys()) {
    if (RESERVED_KEYS.has(key)) continue;
    const buf = await store.getItem<ArrayBuffer>(key);
    if (buf) out[key] = buf;
  }
  return out;
}

/** Drop every locally-cached blob and the pending-upload queue. Used when wiping
 *  the local database — blobs live in a separate localforage store and would
 *  otherwise survive the reset. They re-download from the server on demand after
 *  the next sync. */
export async function clearBlobs(): Promise<void> {
  await store.clear();
  metaCache = {};
  metaDirty = false;
}

/** Replace all locally-cached blobs (for import). */
export async function replaceBlobs(map: Record<string, ArrayBuffer>): Promise<void> {
  await clearBlobs();
  for (const [hash, buf] of Object.entries(map)) {
    await store.setItem(hash, buf);
    touch(hash, buf.byteLength);
  }
  await flushMeta();
}

/** Merge imported blobs into the cache and queue them for upload to the server. */
export async function addImportedBlobs(map: Record<string, ArrayBuffer>): Promise<void> {
  for (const [hash, buf] of Object.entries(map)) {
    await store.setItem(hash, buf);
    touch(hash, buf.byteLength);
    await addPending(hash);
  }
  await flushMeta();
}

/** Upload any locally-stored blobs the server doesn't have yet. */
export async function uploadPendingBlobs(): Promise<void> {
  const cfg = getServerConfig();
  if (!cfg.url) return;
  for (const hash of await getPending()) {
    const buf = await store.getItem<ArrayBuffer>(hash);
    if (!buf) {
      await removePending(hash);
      continue;
    }
    try {
      const res = await fetch(url(`/api/blobs/${hash}`), {
        method: 'POST',
        headers: { ...authHeaders(cfg), 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      // 413 is permanent (blob exceeds the per-file cap) — stop retrying it forever.
      // 507 means the workspace storage quota is full: keep the blob pending so it
      // uploads once space frees up or the host admin raises the cap.
      if (res.status === 507) {
        console.warn('[carbon] upload deferred: workspace storage is full');
      } else if (res.ok || res.status === 413) {
        await removePending(hash);
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

async function fetchIntoCache(hash: string): Promise<boolean> {
  if (await store.getItem<ArrayBuffer>(hash)) return false;
  const cfg = getServerConfig();
  if (!cfg.url) return false;
  try {
    const res = await fetch(url(`/api/blobs/${hash}`), { headers: authHeaders(cfg) });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    await store.setItem(hash, buf);
    touch(hash, buf.byteLength);
    return true;
  } catch {
    return false; // offline / transient — retried on the next sync
  }
}

/** Download `hashes` (skipping already-cached ones) with bounded concurrency. */
async function fetchAll(hashes: string[]): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(PREFETCH_CONCURRENCY, hashes.length) }, async () => {
    while (next < hashes.length) {
      const hash = hashes[next++]!;
      await fetchIntoCache(hash);
    }
  });
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
  const cfg = getServerConfig();
  if (cfg.blobFetch === 'all') return 0;
  const budget = Math.max(0, cfg.blobCacheMb) * 1024 * 1024;
  if (budget <= 0) return 0;

  const pending = new Set(await getPending());
  const meta = await loadMeta();
  const keys = (await store.keys()).filter((k) => !RESERVED_KEYS.has(k));

  // Size may be unknown for blobs cached before this bookkeeping existed; read it
  // once here and record it, so later passes are pure metadata.
  const entries: { hash: string; size: number; at: number }[] = [];
  let total = 0;
  for (const hash of keys) {
    let size = meta[hash]?.size ?? 0;
    if (!size) {
      size = (await store.getItem<ArrayBuffer>(hash))?.byteLength ?? 0;
      meta[hash] = { size, at: meta[hash]?.at ?? 0 };
      metaDirty = true;
    }
    total += size;
    if (keepThumbs.has(hash) || pending.has(hash)) continue;
    entries.push({ hash, size, at: meta[hash]?.at ?? 0 });
  }
  if (total <= budget) {
    await flushMeta();
    return 0;
  }

  // Oldest-used first — "most time since used", the flush order asked for.
  entries.sort((a, b) => a.at - b.at);
  const dropped: string[] = [];
  let freed = 0;
  for (const e of entries) {
    if (total - freed <= budget) break;
    await store.removeItem(e.hash);
    dropped.push(e.hash);
    freed += e.size;
  }
  if (dropped.length) {
    // A dropped blob's object URL would now resolve to bytes we no longer hold.
    for (const h of dropped) objectUrls.delete(h);
    await forgetMeta(dropped);
    console.info(`[carbon] blob cache: evicted ${dropped.length} blob(s), ${Math.round(freed / 1024)} KB`);
  } else {
    await flushMeta();
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
  if (prefetching) return;
  prefetching = true;
  try {
    const mode = getServerConfig().blobFetch;
    const { thumbs, full } = blobRefIndex(db);
    if (mode !== 'on-demand') await fetchAll([...thumbs]);
    if (mode === 'all') await fetchAll([...full]);
    else await pruneBlobCache(thumbs);
  } catch (err) {
    console.warn('[carbon] blob cache sync failed:', err);
  } finally {
    prefetching = false;
    await flushMeta();
  }
}

/** Bytes currently held in the local blob cache (for the settings readout). */
export async function blobCacheBytes(): Promise<number> {
  const meta = await loadMeta();
  let total = 0;
  for (const key of await store.keys()) {
    if (RESERVED_KEYS.has(key)) continue;
    total += meta[key]?.size ?? (await store.getItem<ArrayBuffer>(key))?.byteLength ?? 0;
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
export async function flushBlobCache(thumbs: Set<string>): Promise<FlushResult> {
  const keepThumbs = getServerConfig().blobFetch !== 'on-demand';
  const pending = new Set(await getPending());
  const meta = await loadMeta();
  const dropped: string[] = [];
  const out: FlushResult = { freed: 0, dropped: 0, keptPending: 0, keptThumbs: 0 };
  for (const hash of await store.keys()) {
    if (RESERVED_KEYS.has(hash)) continue;
    if (pending.has(hash)) {
      out.keptPending++;
      continue;
    }
    if (keepThumbs && thumbs.has(hash)) {
      out.keptThumbs++;
      continue;
    }
    out.freed += meta[hash]?.size ?? (await store.getItem<ArrayBuffer>(hash))?.byteLength ?? 0;
    await store.removeItem(hash);
    objectUrls.delete(hash);
    dropped.push(hash);
  }
  out.dropped = dropped.length;
  await forgetMeta(dropped);
  return out;
}
