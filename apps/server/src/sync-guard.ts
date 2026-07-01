import { hasWriteAccess, type Db, type Op, type RecordOp, type ItemPatch } from '@carbon/core';

// ----- sync push validation (S1) --------------------------------------------
// The sync handler used to apply client-pushed ops verbatim. A client could then
// claim another user's ownership, author comments as someone else, or stamp a
// far-future timestamp that permanently wins all field-level LWW (and poisons the
// server's causal clock). These sanitizers run on every authenticated push.
export const SYNC_SKEW_MS = 5 * 60_000; // tolerate 5 min of legitimate clock skew

export function sanitizeOps(db: Db, userId: string, ops: Op[], now = Date.now()): Op[] {
  const maxTs = now + SYNC_SKEW_MS;
  const out: Op[] = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.item_id !== 'string') continue;
    const fields: ItemPatch = { ...(op.fields ?? {}) };
    const existing = db.get<{ owner_id: string | null }>(
      'SELECT owner_id FROM items WHERE id = ?',
      [op.item_id],
    );
    if (!existing) {
      // Brand-new item: whoever pushes the create op owns it.
      if ('owner_id' in fields) fields.owner_id = userId;
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
): RecordOp[] {
  const maxTs = now + SYNC_SKEW_MS;
  const out: RecordOp[] = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const data: Record<string, unknown> =
      op.data && typeof op.data === 'object' ? { ...(op.data as Record<string, unknown>) } : {};
    const itemId = typeof data.item_id === 'string' ? data.item_id : null;
    switch (op.entity) {
      case 'comment':
        data.author_id = userId; // can't author as another user
        break;
      case 'share':
      case 'assignee':
        if (!itemId || !hasWriteAccess(db, itemId, userId)) continue; // only share/assign what you can write
        break;
      case 'attachment':
      case 'item_tag':
        if (itemId && !hasWriteAccess(db, itemId, userId)) continue;
        break;
      case 'timelog':
      case 'plan':
      case 'setting':
        data.user_id = userId; // per-user rows: only your own
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
