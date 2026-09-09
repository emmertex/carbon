import {
  hasWriteAccess,
  applyOp,
  getItem,
  type Db,
  type Op,
  type RecordOp,
  type ItemPatch,
} from "@carbon/core";
import {
  sessionCredentialFor,
  validateRecordOps,
  checkItemOpDestination,
} from "./authorize";

// ----- sync push validation (S1 + A1) ----------------------------------------
// The sync handler used to apply client-pushed ops verbatim. A client could then
// claim another user's ownership, author comments as someone else, or stamp a
// far-future timestamp that permanently wins all field-level LWW (and poisons the
// server's causal clock). These sanitizers run on every authenticated push.
//
// A1: the access rules now live in `./authorize` (the single shared authorization
// module). `sanitizeOps` enforces ownership + destination access (a create/move's
// parent must be writable; no hierarchy cycles; no invalid parent types) and
// `sanitizeRecordOps` enforces record identity + owner-only sharing + comment
// management. A credential's *scopes* (a read-only API token stays read-only) are
// bound one level up, in the `/api/sync` handler, via `authorize.canPushWrites`.
export const SYNC_SKEW_MS = 5 * 60_000; // tolerate 5 min of legitimate clock skew

/** Per-request ceiling on each array a sync push carries. The body-size cap alone
 *  doesn't bound the work: even a modest body can hold hundreds of thousands of
 *  minimal ops to sanitize and ingest in one request. Clients push well under this
 *  (SYNC_PUSH_CHUNK in apps/web/src/lib/sync.ts) and drain a backlog over several
 *  rounds, so reaching it means a client bug or abuse. */
export const MAX_SYNC_BATCH = Math.max(
  1,
  Number(process.env.MAX_SYNC_BATCH) || 10_000,
);

/** Per-workspace ceiling on DISTINCT tags. Tags are shared vocabulary: the sync pull
 *  re-sends the full tag set to every client, so an unbounded tag store grows the
 *  response without bound. A malicious push could otherwise mint 10k new tags per sync.
 *  New-tag record-ops beyond the cap are dropped (the pusher is told via the rejected
 *  count). 0 = unlimited. (Mirrors TAGS_MAX_PER_WORKSPACE in index.ts.) */
export const TAGS_MAX_PER_WORKSPACE = Math.floor(
  Number(process.env.TAGS_MAX_PER_WORKSPACE) || 10000,
);

/**
 * A2: cap the number of DISTINCT tags a workspace may hold. Count the existing distinct
 * tag rows once, then walk the authorized ops, dropping new-tag creates (a `tag` op
 * whose row_id is not already a tag) once the cap is reached. Existing-tag updates and
 * all non-tag ops pass through untouched. 0 cap = no-op.
 */
function capNewTags(db: Db, ops: RecordOp[]): RecordOp[] {
  if (TAGS_MAX_PER_WORKSPACE <= 0) return ops;
  if (!ops.some((o) => o && o.entity === "tag")) return ops;
  // Count the DISTINCT tags already in the store (a tag can have many record-ops — one
  // per change — so count distinct row_ids, not rows).
  const existing = db.get<{ n: number }>(
    "SELECT COUNT(DISTINCT row_id) AS n FROM record_ops WHERE entity = ?",
    ["tag"],
  );
  let budget = TAGS_MAX_PER_WORKSPACE - (existing?.n ?? 0);
  const seenNew = new Set<string>(); // new tags already counted in THIS push
  const out: RecordOp[] = [];
  for (const o of ops) {
    if (o && o.entity === "tag") {
      const isNew =
        !seenNew.has(o.row_id) &&
        !db.get(
          "SELECT 1 AS x FROM record_ops WHERE entity = ? AND row_id = ?",
          ["tag", o.row_id],
        );
      if (isNew) {
        // A genuinely new tag beyond the cap is dropped. An UPDATE to an existing tag
        // never counts against the cap (it doesn't grow the distinct count).
        if (budget <= 0) continue;
        budget--;
        seenNew.add(o.row_id);
      }
    }
    out.push(o);
  }
  return out;
}

/** Name of the first sync-push array over the cap, or null when the push is within
 *  bounds. Per array rather than summed, so a large `need` (a backfill request, not
 *  work to ingest) can't make an otherwise ordinary push fail. */
export function oversizedSyncArray(
  body: { ops?: unknown; recordOps?: unknown; need?: unknown },
  max = MAX_SYNC_BATCH,
): "ops" | "recordOps" | "need" | null {
  const arrays = [
    ["ops", body.ops],
    ["recordOps", body.recordOps],
    ["need", body.need],
  ] as const;
  for (const [name, value] of arrays) {
    if (Array.isArray(value) && value.length > max) return name;
  }
  return null;
}

/** Owners of items in this push batch that the caller is marking done and is
 *  allowed to write. Used so a write-sharee completing a recurring task can create
 *  the next occurrence still owned by the series owner (instead of sanitizeOps
 *  rewriting the create to the completer and dropping the series for the owner).
 */
function seriesOwnersBeingCompleted(
  db: Db,
  userId: string,
  ops: Op[],
): Set<string> {
  const owners = new Set<string>();
  for (const op of ops) {
    if (!op?.fields || op.fields.status !== "done") continue;
    if (typeof op.item_id !== "string") continue;
    const item = getItem(db, op.item_id);
    if (!item?.owner_id) continue;
    if (item.owner_id !== userId && !hasWriteAccess(db, op.item_id, userId))
      continue;
    owners.add(item.owner_id);
  }
  return owners;
}

export function sanitizeOps(
  db: Db,
  userId: string,
  ops: Op[],
  now = Date.now(),
): Op[] {
  const cred = sessionCredentialFor(userId);
  const maxTs = now + SYNC_SKEW_MS;
  const seriesOwners = seriesOwnersBeingCompleted(db, userId, ops);

  const out: Op[] = [];
  // Resolve same-batch parents before children using an iterative dependency walk.
  // Authorization runs against the actual projected LWW state, never claimed ids.
  const byItem = new Map<string, Op[]>();
  for (const op of ops) {
    if (!op || typeof op.item_id !== "string") continue;
    const list = byItem.get(op.item_id) ?? [];
    list.push(op);
    byItem.set(op.item_id, list);
  }
  const duplicateIds = new Set<string>();
  const uniqueOps: Op[] = [];
  for (const op of ops) {
    if (!op || duplicateIds.has(op.id)) continue;
    duplicateIds.add(op.id);
    if (!db.get("SELECT 1 FROM ops WHERE id = ?", [op.id])) uniqueOps.push(op);
  }
  // Build dependencies only from entries ingest will actually apply.
  byItem.clear();
  for (const op of uniqueOps)
    byItem.set(op.item_id, [...(byItem.get(op.item_id) ?? []), op]);
  const ordered: Op[] = [];
  const visited = new Set<Op>();
  const active = new Set<Op>();
  for (const root of uniqueOps) {
    if (!root || typeof root.item_id !== "string") continue;
    const stack: Array<[Op, boolean]> = [[root, false]];
    while (stack.length) {
      const [op, done] = stack.pop()!;
      if (visited.has(op)) continue;
      if (done) {
        active.delete(op);
        visited.add(op);
        ordered.push(op);
        continue;
      }
      if (active.has(op)) {
        visited.add(op);
        continue;
      }
      active.add(op);
      stack.push([op, true]);
      const parent = op.fields?.parent_id;
      if (parent && !getItem(db, parent)) {
        for (const dep of byItem.get(parent) ?? [])
          if (!visited.has(dep)) stack.push([dep, false]);
      }
    }
  }
  db.exec("SAVEPOINT authorize_items");
  try {
    for (const op of ordered) {
      if (!op || typeof op !== "object" || typeof op.item_id !== "string")
        continue;
      const fields: ItemPatch = { ...(op.fields ?? {}) };

      // Destination access (A1, gap 2): a create/move whose `parent_id` is set must land
      // in a container the caller can write, without a hierarchy cycle or an invalid parent
      // type (project nested under a task, task nested under a folder). A null parent (top
      // level / inbox) always passes.
      const fieldsAny = fields as Record<string, unknown>;
      const parentId =
        typeof fieldsAny.parent_id === "string" ? fieldsAny.parent_id : null;
      if (parentId !== null && checkItemOpDestination(db, cred, op) !== "ok") {
        continue;
      }

      const existing = db.get<{ owner_id: string | null }>(
        "SELECT owner_id FROM items WHERE id = ?",
        [op.item_id],
      );
      if (!existing) {
        // Brand-new item: default owner is the pusher. Preserve a different owner_id
        // only when this create is continuing a recurring series the caller is allowed
        // to complete (same-batch status:done), or when attaching under a parent they
        // can write whose owner matches the requested owner.
        {
          const requested = fields.owner_id;
          let keep = typeof requested === "string" && requested === userId;
          if (!keep && typeof requested === "string") {
            if (seriesOwners.has(requested)) {
              keep = true;
            } else {
              const parent = parentId ? getItem(db, parentId) : undefined;
              if (
                parentId &&
                parent &&
                parent.owner_id === requested &&
                hasWriteAccess(db, parentId, userId)
              ) {
                keep = true;
              }
            }
          }
          fields.owner_id =
            keep && typeof requested === "string" ? requested : userId;
        }
      } else {
        const owner = existing.owner_id;
        // Reject writes to an item the caller neither owns nor has write access to.
        if (
          owner &&
          owner !== userId &&
          !hasWriteAccess(db, op.item_id, userId)
        )
          continue;
        if ("owner_id" in fields) {
          if (!owner)
            fields.owner_id = userId; // claiming an unowned/shell row
          else if (fields.owner_id !== owner && userId !== owner)
            delete fields.owner_id; // only the owner transfers
        }
      }
      const accepted = {
        ...op,
        ts: Math.min(Number(op.ts) || 0, maxTs),
        fields,
      };
      db.exec("SAVEPOINT authorize_item");
      try {
        applyOp(db, accepted);
      } catch {
        db.exec("ROLLBACK TO authorize_item");
        db.exec("RELEASE authorize_item");
        continue;
      }
      db.exec("RELEASE authorize_item");
      out.push(accepted);
    }
  } finally {
    db.exec("ROLLBACK TO authorize_items");
    db.exec("RELEASE authorize_items");
  }
  return out;
}

export function sanitizeRecordOps(
  db: Db,
  userId: string,
  ops: RecordOp[],
  now = Date.now(),
  /**
   * Item ids whose create op was accepted in this same sync push. The pusher may
   * attach shares/assignees/tags to those rows even when ownership was preserved
   * as the series owner (write-sharee completing a recurring task) — otherwise
   * the copied grants never land and the next occurrence disappears for everyone
   * but the owner.
   */
  justCreatedIds?: ReadonlySet<string>,
): RecordOp[] {
  const cred = sessionCredentialFor(userId);
  const maxTs = now + SYNC_SKEW_MS;
  const authorized = validateRecordOps(db, cred, ops, justCreatedIds);
  // A2: bound the shared-vocabulary tag store (see capNewTags).
  const capped = capNewTags(db, authorized);
  return capped.map((op) => {
    const data = { ...(op.data as Record<string, unknown>) };
    let ts = Math.min(Number(op.ts) || 0, maxTs);
    if (
      typeof data.updated_at === "string" &&
      Number.isFinite(Date.parse(data.updated_at))
    ) {
      const rowTs = Math.min(Date.parse(data.updated_at), maxTs);
      data.updated_at = new Date(rowTs).toISOString();
      ts = Math.max(ts, rowTs);
    }
    return { ...op, ts, data };
  });
}
