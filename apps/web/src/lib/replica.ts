import {
  enableReplicaFeed,
  exportForReplica,
  getDb,
  takeReplicaFeed,
} from "./db";
import { currentRevision } from "./dbRevision";
import { pendingHideIds } from "./completionHold";
import {
  SIDEBAR_QUERIES,
  type SidebarQueryArgs,
  type SidebarQueryName,
  type SidebarQueryResult,
} from "./sidebarQueries";
import type { ReplicaRequest, ReplicaResponse } from "./replica.worker";

/**
 * Main-thread side of the read replica (replica.worker.ts): seeds it, forwards the
 * live DB's writes, and runs named sidebar queries there so their cost never
 * blocks input. Falls back to running the query on the main thread whenever the
 * worker is unavailable (no Worker, CSP blocks wasm in workers, it crashed).
 */

let worker: Worker | null = null;
let broken = typeof Worker === "undefined";
let nextId = 0;
const waiting = new Map<
  number,
  { resolve: (v: { rev: number; value: unknown }) => void; reject: (e: unknown) => void }
>();

function fail(reason: unknown): void {
  if (!broken) console.warn("[carbon] read replica unavailable; counting on the main thread:", reason);
  broken = true;
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(reason);
  waiting.clear();
}

function getWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL("./replica.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<ReplicaResponse>) => {
      const msg = e.data;
      if (msg.t === "result") {
        waiting.get(msg.id)?.resolve({ rev: msg.rev, value: msg.value });
        waiting.delete(msg.id);
      } else if (msg.t === "error") {
        if (msg.id === undefined) fail(new Error(msg.error));
        else {
          waiting.get(msg.id)?.reject(new Error(msg.error));
          waiting.delete(msg.id);
        }
      }
    };
    w.onerror = (e) => fail(e.message || "worker error");
    w.onmessageerror = () => fail("worker message error");
    worker = w;
    enableReplicaFeed();
    return w;
  } catch (e) {
    fail(e);
    return null;
  }
}

/** Ship pending writes (or a fresh seed) so the replica is at the live revision. */
function sync(w: Worker): void {
  const { reseed, recs } = takeReplicaFeed();
  const rev = currentRevision();
  if (reseed) {
    const snap = exportForReplica();
    w.postMessage({ t: "seed", snap, rev } satisfies ReplicaRequest, [snap.buffer]);
  } else if (recs.length) {
    w.postMessage({ t: "apply", recs, rev } satisfies ReplicaRequest);
  }
}

/** Run a sidebar query on the replica at (at least) the live revision. Resolves
 *  with the revision it was computed at. Rejects only if the replica is broken —
 *  callers then compute locally. */
export function replicaQuery<N extends SidebarQueryName>(
  name: N,
  args: SidebarQueryArgs<N>,
): Promise<{ rev: number; value: SidebarQueryResult<N> }> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("replica unavailable"));
  try {
    sync(w);
  } catch (e) {
    fail(e);
    return Promise.reject(e);
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    waiting.set(id, {
      resolve: resolve as (v: { rev: number; value: unknown }) => void,
      reject,
    });
    w.postMessage({
      t: "query",
      id,
      name,
      args,
      pending: [...pendingHideIds()],
    } satisfies ReplicaRequest);
  });
}

/** The same query on the main thread (first paint, and the fallback). */
export function localQuery<N extends SidebarQueryName>(
  name: N,
  args: SidebarQueryArgs<N>,
): SidebarQueryResult<N> {
  const fn = SIDEBAR_QUERIES[name] as (d: ReturnType<typeof getDb>, a: unknown) => unknown;
  return fn(getDb(), args) as SidebarQueryResult<N>;
}

export function replicaAvailable(): boolean {
  return !broken;
}
