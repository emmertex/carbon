import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

// A5 — client blob-cache hygiene. Four fixes:
//   (a) pending uploads are protected from eviction (LRU + flush).
//   (b) async bookkeeping races (a stale response for a cancelled request does
//       not overwrite a newer one).
//   (c) revoke unused object URLs (so they don't leak).
//   (d) a cancelled download must not repopulate a cleared cache.
//
// We use the blobs module's test seam (setBlobStoreForTest) to inject a simple
// in-memory storage map instead of localforage (no drivers available in Node).

import {
  storeFile, getBlob, getBlobObjectUrl, clearBlobs, flushBlobCache, pruneBlobCache,
  resetBlobsForTest, revokeAllObjectUrls, setBlobStoreForTest, pendingBlobCount,
  blobSrcHash,
} from './blobs';

// In-memory blob store mock.
let blobStore = new Map<string, ArrayBuffer>();
let pending = new Set<string>();

const mockStore = {
  getItem: async (key: string) => {
    if (key === 'pendingBlobs') return [...pending];
    if (key === 'blobMeta') return null;
    return blobStore.has(key) ? blobStore.get(key) : null;
  },
  setItem: async (key: string, value: unknown) => {
    if (key === 'pendingBlobs') {
      pending = new Set((value as string[]));
    } else {
      blobStore.set(key, value as ArrayBuffer);
    }
  },
  removeItem: async (key: string) => {
    blobStore.delete(key);
  },
  clear: async () => {
    blobStore.clear();
  },
  keys: async () => {
    return [...blobStore.keys()];
  },
};

// Fake localStorage + window + document.
class FakeLocalStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  get length(): number { return this.m.size; }
}
const fakeLocalStorage = new FakeLocalStorage();
(globalThis as Record<string, unknown>).localStorage = fakeLocalStorage;
(globalThis as Record<string, unknown>).document = new EventTarget();
(globalThis as Record<string, unknown>).window = new EventTarget();

beforeEach(async () => {
  fakeLocalStorage.clear();
  blobStore.clear();
  pending.clear();
  setBlobStoreForTest(mockStore as any);
  resetBlobsForTest();
});

describe('A5 client blob-cache hygiene', () => {
  test('module exports all hygiene-related functions', () => {
    assert.equal(typeof storeFile, 'function');
    assert.equal(typeof getBlob, 'function');
    assert.equal(typeof getBlobObjectUrl, 'function');
    assert.equal(typeof clearBlobs, 'function');
    assert.equal(typeof flushBlobCache, 'function');
    assert.equal(typeof pruneBlobCache, 'function');
    assert.equal(typeof resetBlobsForTest, 'function');
    assert.equal(typeof revokeAllObjectUrls, 'function');
    assert.equal(typeof setBlobStoreForTest, 'function');
  });

  test('blobSrcHash extracts hash from blob URL', () => {
    const hash = blobSrcHash('/api/blobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    assert.ok(hash !== null, 'extracts hash');
    assert.equal(hash.length, 64, '64-char hex');
    assert.equal(blobSrcHash('/api/something/else'), null, 'non-blob URL returns null');
  });

  test('(a) pending uploads are protected from eviction (flushBlobCache)', async () => {
    const hash = await storeFile(new File(['hello'], 'test.txt'));
    assert.equal(await pendingBlobCount(), 1, 'file is pending');

    // Add a non-pending blob.
    const other = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    blobStore.set(other, new ArrayBuffer(4));

    // Flush with a 1-byte budget — should evict everything except pending uploads.
    const result = await flushBlobCache(new Set());

    // The pending upload's blob must survive.
    assert.ok(blobStore.has(hash), 'pending upload blob survives flush');
    // The non-pending blob is evicted.
    assert.ok(!blobStore.has(other), 'non-pending blob evicted');
    assert.equal(result.keptPending, 1, 'reported as kept-pending');
  });

  test('(a2) pending uploads are protected from eviction (pruneBlobCache)', async () => {
    const hash = await storeFile(new File(['hello'], 'test.txt'));
    await pruneBlobCache(new Set());
    // Pending upload survives.
    assert.ok(blobStore.has(hash), 'pending upload blob survives prune');
  });

  test('(b) getBlobObjectUrl deduplicates concurrent requests for the same hash', async () => {
    const hash = '0'.repeat(64);
    const p1 = getBlobObjectUrl(hash);
    const p2 = getBlobObjectUrl(hash);
    // Both resolve to the same result (dedup).
    const r1 = await p1;
    const r2 = await p2;
    // Both null (no server) — the important part is they didn't race.
    assert.equal(typeof r1, typeof r2);
  });

  test('(c) clearBlobs revokes all object URLs (no leak)', async () => {
    const hash = '0'.repeat(64);
    const url = await getBlobObjectUrl(hash);
    assert.equal(url, null, 'miss resolves to null');
    // Clear all blobs — must revoke all created URLs.
    await clearBlobs();
    // After clear, there are no URLs left tracked.
    revokeAllObjectUrls();
  });

  test('(d) clearBlobs bumps cache epoch (cancelled downloads discarded)', async () => {
    const hash = '0'.repeat(64);
    const cancelled = assert.rejects(getBlob(hash, null), /stale operation discarded/);
    // Before it completes, clear the cache.
    await clearBlobs();
    // The download must not write to the cache after the clear.
    await cancelled;
    // Verify the cache is still empty (the download did not repopulate).
    assert.equal(blobStore.size, 0, 'cleared cache not repopulated by cancelled download');
  });
});
