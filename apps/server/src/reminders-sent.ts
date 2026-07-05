import { type Db } from '@carbon/core';

/** Dedup helpers for the `reminders_sent` table (schema/GC live in push.ts, which owns
 *  `ensurePushTables`). Shared by every per-tick sweep that fires a one-shot
 *  notification for a given (item, kind, marker) — reminders/due/defer (push.ts) and
 *  GPS proximity (auth.ts) — so they don't re-notify on the next tick. */

export function alreadySent(db: Db, itemId: string, kind: string, marker: string): boolean {
  return !!db.get('SELECT 1 AS x FROM reminders_sent WHERE item_id = ? AND kind = ? AND marker = ?', [
    itemId,
    kind,
    marker,
  ]);
}

export function markSent(db: Db, itemId: string, kind: string, marker: string): void {
  db.run(
    `INSERT INTO reminders_sent (item_id, kind, marker, sent_at) VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [itemId, kind, marker, new Date().toISOString()],
  );
}
