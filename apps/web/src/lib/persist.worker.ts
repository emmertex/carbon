/// <reference lib="webworker" />

// Writes one generation's snapshot to the app's raw IndexedDB store (database
// `carbon_meta`, object store `kv`) off the main thread, so the structured-clone
// + commit of the routine debounced persist doesn't block render/interaction
// work (the dominant cost under CPU throttling — see perf/results).
//
// Mirrors the main-thread direct path in `db.ts` (`landDirect`): the main record
// (`db|<ns>`) and its snapshot-log entry (`dblog|<ns>`) land in ONE transaction,
// so a crash can leave at most a missing write, never a torn one. The same
// transaction resets the journal head to this snapshot and deletes the journal
// entries it covers (see "journal" in db.ts).
//
// Keep MAX_LOG in sync with db.ts.
const MAX_LOG = 4;

declare const self: DedicatedWorkerGlobalScope;

interface PersistRequest {
  id: number;
  key: string;
  logKey: string;
  lockKey: string;
  headKey: string;
  head: { gen: number; base: number; writer?: string; n: number; bytes: number };
  dropKeys: string[];
  token: string;
  gen: number;
  snap: Uint8Array;
}

interface PersistResponse {
  id: number;
  ok: boolean;
  error?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("carbon_meta", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("kv"))
        req.result.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

self.onmessage = (e: MessageEvent<PersistRequest>) => {
  const { id, key, logKey, lockKey, headKey, head, dropKeys, token, gen, snap } =
    e.data;
  const fail = (error: unknown): void =>
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies PersistResponse);

  void openDb()
    .then((db) => {
      const tx = db.transaction("kv", "readwrite");
      const st = tx.objectStore("kv");
      const lock = st.get(lockKey);
      lock.onsuccess = () => {
        if (
          !token ||
          lock.result?.token !== token ||
          Date.now() - lock.result.ts > 15_000
        ) {
          tx.abort();
          return;
        }
        // The head is the generation of record; a store last written by a build
        // without the journal has none, so fall back to the snapshot's.
        const currentHead = st.get(headKey);
        currentHead.onsuccess = () => {
          if (currentHead.result) check(currentHead.result.gen);
          else {
            const current = st.get(key);
            current.onsuccess = () => check(current.result?.gen ?? -1);
          }
        };
        const check = (currentGen: number) => {
          if (currentGen >= gen) {
            tx.abort();
            return;
          }
          const get = st.get(logKey);
          get.onsuccess = () => {
            const old = Array.isArray(get.result)
              ? (get.result as { gen: number; snap: Uint8Array }[])
              : [];
            const log = [{ gen, snap }, ...old].slice(0, MAX_LOG);
            while (
              log.length &&
              log.reduce((n, e) => n + e.snap.byteLength, 0) > 64 * 1024 * 1024
            )
              log.pop();
            st.put({ gen, snap, writer: token }, key);
            st.put(log, logKey);
            for (const k of dropKeys) st.delete(k);
            st.put(head, headKey);
          };
        };
      };
      tx.oncomplete = () => {
        db.close();
        self.postMessage({ id, ok: true } satisfies PersistResponse);
      };
      tx.onabort = () => {
        db.close();
        fail(tx.error ?? new Error("transaction aborted"));
      };
    })
    .catch(fail);
};
