// Ids of just-completed tasks held visible during the completion grace window
// (see completion.ts, which owns the timer). Kept in a module with no imports so
// store-free code — list filters running in the read-replica worker — can read
// it; the worker receives the main thread's current set with each query.

let pending = new Set<string>();

/** Ids of completed tasks currently held visible during the grace window. */
export function pendingHideIds(): Set<string> {
  return pending;
}

/** Replace the held set (completion.ts on the main thread; the worker per query). */
export function setPendingHideIds(ids: Iterable<string>): void {
  pending = new Set(ids);
}
