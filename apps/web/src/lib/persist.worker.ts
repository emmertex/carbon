/// <reference lib="webworker" />
import localforage from 'localforage';

// Mirrors the main thread's config in `db.ts` — same underlying IndexedDB
// database/store, just written from a different thread so the structured-clone +
// IndexedDB write for the routine debounced persist doesn't block the main
// thread's render/interaction work. See `db.ts` `persist()`/`writeSnapshotViaWorker()`.
localforage.config({ name: 'carbon', storeName: 'carbon' });

declare const self: DedicatedWorkerGlobalScope;

interface PersistRequest {
  id: number;
  key: string;
  data: Uint8Array;
}

interface PersistResponse {
  id: number;
  ok: boolean;
  error?: string;
}

self.onmessage = (e: MessageEvent<PersistRequest>) => {
  const { id, key, data } = e.data;
  localforage
    .setItem(key, data)
    .then(() => self.postMessage({ id, ok: true } satisfies PersistResponse))
    .catch((err: unknown) => {
      self.postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies PersistResponse);
    });
};
