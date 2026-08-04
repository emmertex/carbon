import {
  getItem,
  updateItem,
  itemsNeedingThumb,
  firstBlobRef,
  parseThumb,
  type Db,
} from '@carbon/core';
import { getDb } from './db';
import { mutate } from './mutate';
import { getBlob, getCachedBlob, storeFile } from './blobs';

// Row thumbnails.
//
// A note row shows its first image. Rendering that from the original would mean
// downloading (and decoding) a multi-megabyte photo to fill a ~96px box — per row,
// on every device, even the ones that only ever scroll past it. So the device that
// saves the note also renders a small JPEG, stores it as an ordinary
// content-addressed blob, and records {src, hash, w, h} on the item's `thumb`
// field. That field syncs with the item like any other column, so every other
// device gets the thumbnail reference for free and can fetch just the small blob.
//
// `src` (the hash of the image it was rendered from) is the invalidation key: when
// the note's first image changes, `src` stops matching and the thumbnail is rebuilt.

/** Longest edge of a generated thumbnail, in pixels. Covers a ~120px row at 2x. */
const THUMB_MAX_PX = 320;
/** JPEG quality — small enough to always sync, good enough for a row icon. */
const THUMB_QUALITY = 0.72;

/** Items whose thumbnail is being generated right now, so overlapping saves (the
 *  1.5s autosave plus a blur commit) don't render the same image twice. */
const inFlight = new Set<string>();
/** Ids that got another ensure call (or a mid-flight first-image change) while a
 *  pass was running. Value is `allowFetch` OR'd across the queued callers — if any
 *  of them may hit the network, the retry may too. */
const queued = new Map<string, boolean>();

function queueRetry(id: string, allowFetch: boolean): void {
  queued.set(id, (queued.get(id) ?? false) || allowFetch);
}

/** Decode `source` and re-encode it as a downscaled JPEG. Returns null when the
 *  bytes aren't a decodable image or the platform lacks canvas encoding. */
export async function makeThumbnail(
  source: Blob,
): Promise<{ blob: Blob; w: number; h: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null; // not an image (or an unsupported codec) — no thumbnail, no error
  }
  try {
    const scale = Math.min(1, THUMB_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY),
    );
    return blob ? { blob, w, h } : null;
  } finally {
    bitmap.close();
  }
}

/**
 * Make sure `id`'s `thumb` matches the first image in its note body.
 *
 * No-ops when the thumbnail is already current. Clears `thumb` when the body no
 * longer references an image. `allowFetch` decides whether a missing source image
 * may be downloaded: true on the save path (the user is looking at the image, so
 * it's already cached anyway), false for background backfill, which must never
 * turn a cheap pass into a bulk download.
 *
 * Overlapping calls coalesce: a second ensure while one is in flight is queued and
 * re-run once, so a rapid image replace (autosave for A, then blur/save for B)
 * cannot abort A and then forget B. A mid-flight body change that invalidates the
 * thumbnail we just built is queued the same way.
 */
export async function ensureNoteThumb(id: string, allowFetch = true): Promise<void> {
  if (inFlight.has(id)) {
    queueRetry(id, allowFetch);
    return;
  }
  inFlight.add(id);
  try {
    const item = getItem(getDb(), id);
    if (!item) return;
    const src = firstBlobRef(item.note);
    const current = parseThumb(item);
    if (!src) {
      // Image removed from the note — drop the stale thumbnail reference. The blob
      // itself is left to the cache policy (it may still be referenced elsewhere).
      if (current) mutate((db, dev) => updateItem(db, dev, id, { thumb: null }), 'thumb');
      return;
    }
    if (current?.src === src) return;

    const source = allowFetch ? await getBlob(src, null) : await getCachedBlob(src, null);
    if (!source) return; // not available locally (and not fetchable) — try again later
    const thumb = await makeThumbnail(source);
    if (!thumb) return;

    const hash = await storeFile(
      new File([thumb.blob], `${src.slice(0, 12)}-thumb.jpg`, { type: 'image/jpeg' }),
    );
    // Re-read: the note may have changed while we were decoding/encoding. Only
    // publish the thumbnail if it still describes the current first image; otherwise
    // queue a retry for whatever the body needs now.
    const fresh = getItem(getDb(), id);
    if (!fresh || firstBlobRef(fresh.note) !== src) {
      queueRetry(id, allowFetch);
      return;
    }
    mutate(
      (db, dev) =>
        updateItem(db, dev, id, {
          thumb: JSON.stringify({ src, hash, w: thumb.w, h: thumb.h }),
        }),
      'thumb',
    );
  } catch (err) {
    console.warn('[carbon] thumbnail generation failed', err);
  } finally {
    inFlight.delete(id);
    if (queued.has(id)) {
      const nextFetch = queued.get(id)!;
      queued.delete(id);
      void ensureNoteThumb(id, nextFetch);
    }
  }
}

/**
 * Generate thumbnails for notes that reference an image but have none — items
 * written before thumbnails existed, or imported from a backup.
 *
 * Cache-only by default, so a device on the on-demand blob policy doesn't quietly
 * download every image in the workspace; the 'all' policy has already pulled the
 * originals down by the time this runs, so it fills in everything.
 */
export async function backfillThumbs(db: Db, allowFetch = false): Promise<void> {
  for (const it of itemsNeedingThumb(db)) await ensureNoteThumb(it.id, allowFetch);
}
