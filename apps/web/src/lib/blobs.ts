import localforage from 'localforage';
import { getServerConfig, authHeaders } from './config';

// Content-addressed blob cache, separate store from the DB snapshot.
const store = localforage.createInstance({ name: 'carbon', storeName: 'blobs' });
const PENDING_KEY = 'pendingBlobs';

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

/** Store a file locally by content hash and queue it for upload. */
export async function storeFile(file: File): Promise<string> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(file.size);
  const hash = await hashFile(file);
  await store.setItem(hash, await file.arrayBuffer());
  await addPending(hash);
  return hash;
}

/** Get a blob by hash: from local cache, else download + cache. null if unavailable. */
export async function getBlob(hash: string, mime: string | null): Promise<Blob | null> {
  const local = await store.getItem<ArrayBuffer>(hash);
  if (local) return new Blob([local], { type: mime || 'application/octet-stream' });
  const cfg = getServerConfig();
  if (!cfg.url) return null;
  try {
    const res = await fetch(url(`/api/blobs/${hash}`), { headers: authHeaders(cfg) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    await store.setItem(hash, buf);
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
    if (key === PENDING_KEY) continue;
    const buf = await store.getItem<ArrayBuffer>(key);
    if (buf) out[key] = buf;
  }
  return out;
}

/** Replace all locally-cached blobs (for import). */
export async function replaceBlobs(map: Record<string, ArrayBuffer>): Promise<void> {
  await store.clear();
  for (const [hash, buf] of Object.entries(map)) await store.setItem(hash, buf);
}

/** Merge imported blobs into the cache and queue them for upload to the server. */
export async function addImportedBlobs(map: Record<string, ArrayBuffer>): Promise<void> {
  for (const [hash, buf] of Object.entries(map)) {
    await store.setItem(hash, buf);
    await addPending(hash);
  }
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
