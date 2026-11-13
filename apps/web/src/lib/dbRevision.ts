/**
 * Monotonic DB-revision counter, bumped after every mutation/sync (via the store's
 * `bump()`). It lives apart from the UI store on purpose: revision-keyed caches in
 * plain lib modules (enrich, listQuery) need to read it, and importing the store
 * pulls in its DOM-dependent initialisation (it reads `localStorage` at module
 * load), which crashes under Node test runners / SSR. This module has no deps.
 */
let revision = 0;

/** The current revision — changes whenever the DB is mutated or synced. */
export function currentRevision(): number {
  return revision;
}

/** Advance the revision and return the new value. Called only by the store's bump. */
export function bumpRevision(): number {
  return (revision += 1);
}

/** Read-replica worker only: adopt the main thread's revision for the state it
 *  just applied, so revision-keyed caches (listQuery, childrenIndex) invalidate
 *  exactly when the main thread's do. */
export function adoptRevision(rev: number): void {
  if (rev > revision) revision = rev;
}
