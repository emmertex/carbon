import {
  hasWriteAccess,
  hasReadAccess,
  getItem,
  type Db,
  type Op,
  type RecordOp,
  type ItemPatch,
} from '@carbon/core';

// ----- sync push validation (S1) --------------------------------------------
// The sync handler used to apply client-pushed ops verbatim. A client could then
// claim another user's ownership, author comments as someone else, or stamp a
// far-future timestamp that permanently wins all field-level LWW (and poisons the
// server's causal clock). These sanitizers run on every authenticated push.
export const SYNC_SKEW_MS = 5 * 60_000; // tolerate 5 min of legitimate clock skew

/** Per-request ceiling on each array a sync push carries. The body-size cap alone
 *  doesn't bound the work: even a modest body can hold hundreds of thousands of
 *  minimal ops to sanitize and ingest in one request. Clients push well under this
 *  (SYNC_PUSH_CHUNK in apps/web/src/lib/sync.ts) and drain a backlog over several
 *  rounds, so reaching it means a client bug or abuse. */
export const MAX_SYNC_BATCH = Math.max(1, Number(process.env.MAX_SYNC_BATCH) || 10_000);

/** Name of the first sync-push array over the cap, or null when the push is within
 *  bounds. Per array rather than summed, so a large `need` (a backfill request, not
 *  work to ingest) can't make an otherwise ordinary push fail. */
export function oversizedSyncArray(
  body: { ops?: unknown; recordOps?: unknown; need?: unknown },
  max = MAX_SYNC_BATCH,
): 'ops' | 'recordOps' | 'need' | null {
  const arrays = [
    ['ops', body.ops],
    ['recordOps', body.recordOps],
    ['need', body.need],
  ] as const;
  for (const [name, value] of arrays) {
    if (Array.isArray(value) && value.length > max) return name;
  }
  return null;
}

/**
 * Owners of items in this push batch that the caller is marking done and is
 * allowed to write. Used so a write-sharee completing a recurring task can create
 * the next occurrence still owned by the series owner (instead of sanitizeOps
 * rewriting the create to the completer and dropping the series for the owner).
 */
function seriesOwnersBeingCompleted(db: Db, userId: string, ops: Op[]): Set<string> {
  const owners = new Set<string>();
  for (const op of ops) {
    if (!op?.fields || op.fields.status !== 'done') continue;
    if (typeof op.item_id !== 'string') continue;
    const item = getItem(db, op.item_id);
    if (!item?.owner_id) continue;
    if (item.owner_id !== userId && !hasWriteAccess(db, op.item_id, userId)) continue;
    owners.add(item.owner_id);
  }
  return owners;
}

export function sanitizeOps(db: Db, userId: string, ops: Op[], now = Date.now()): Op[] {
  const maxTs = now + SYNC_SKEW_MS;
  const seriesOwners = seriesOwnersBeingCompleted(db, userId, ops);
  const out: Op[] = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.item_id !== 'string') continue;
    // Fields pass through verbatim except `owner_id` (handled below). Non-identity,
    // non-ownership markers like `color`/`note`/`sys_kind` are not stripped — a
    // system-notice item legitimately syncs its `sys_kind` to the owner's devices.
    const fields: ItemPatch = { ...(op.fields ?? {}) };
    const existing = db.get<{ owner_id: string | null }>(
      'SELECT owner_id FROM items WHERE id = ?',
      [op.item_id],
    );
    if (!existing) {
      // Brand-new item: default owner is the pusher. Preserve a different owner_id
      // only when this create is continuing a recurring series the caller is allowed
      // to complete (same-batch status:done), or when attaching under a parent they
      // can write whose owner matches the requested owner.
      if ('owner_id' in fields) {
        const requested = fields.owner_id;
        let keep = typeof requested === 'string' && requested === userId;
        if (!keep && typeof requested === 'string') {
          if (seriesOwners.has(requested)) {
            keep = true;
          } else {
            const parentId = typeof fields.parent_id === 'string' ? fields.parent_id : null;
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
        fields.owner_id = keep && typeof requested === 'string' ? requested : userId;
      }
    } else {
      const owner = existing.owner_id;
      // Reject writes to an item the caller neither owns nor has write access to.
      if (owner && owner !== userId && !hasWriteAccess(db, op.item_id, userId)) continue;
      if ('owner_id' in fields) {
        if (!owner) fields.owner_id = userId; // claiming an unowned/shell row
        else if (fields.owner_id !== owner && userId !== owner) delete fields.owner_id; // only the owner transfers
      }
    }
    out.push({ ...op, ts: Math.min(Number(op.ts) || 0, maxTs), fields });
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
  const maxTs = now + SYNC_SKEW_MS;
  const out: RecordOp[] = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const data: Record<string, unknown> =
      op.data && typeof op.data === 'object' ? { ...(op.data as Record<string, unknown>) } : {};
    const itemId = typeof data.item_id === 'string' ? data.item_id : null;
    const canWriteItem =
      !!itemId &&
      (hasWriteAccess(db, itemId, userId) || (!!justCreatedIds && justCreatedIds.has(itemId)));
    switch (op.entity) {
      case 'comment':
        // Read access is the right bar: comments (and their @mentions, which can
        // trigger agent runs) are visible to anyone who can see the item.
        if (!itemId || !hasReadAccess(db, itemId, userId)) continue;
        data.author_id = userId; // can't author as another user
        break;
      case 'share':
      case 'assignee':
        if (!canWriteItem) continue; // only share/assign what you can write (or just created)
        break;
      case 'attachment':
      case 'item_tag':
        if (!canWriteItem) continue;
        break;
      case 'item_dep': {
        // Edge touches two items (pred blocks succ); require write access to both
        // endpoints, mirroring the item_tag gate above.
        const predId = typeof data.pred_id === 'string' ? data.pred_id : null;
        const succId = typeof data.succ_id === 'string' ? data.succ_id : null;
        if (
          !predId ||
          !succId ||
          !hasWriteAccess(db, predId, userId) ||
          !hasWriteAccess(db, succId, userId)
        )
          continue;
        break;
      }
      case 'timelog':
      case 'plan':
        data.user_id = userId; // per-user rows: only your own
        break;
      case 'setting':
        // No matching case in packages/core's applyRecordOp — intentional, not a
        // gap. Settings are UI/localStorage blobs, not part of the CRDT item
        // graph; the client applies them directly off the raw record-op log
        // (see apps/web/src/lib/settings-sync.ts). This case only forces
        // ownership before the op is stored/relayed.
        data.user_id = userId;
        break;
      case 'tag':
        break; // global shared vocabulary
      case 'user':
        continue; // roster is server-managed (REST admin + roster pull); never client-pushed
      default:
        continue; // unknown entity
    }
    out.push({ ...op, ts: Math.min(Number(op.ts) || 0, maxTs), data });
  }
  return out;
}
