import { type Db, COMPLETED_PURGE_AGE_DAYS } from '@carbon/core';
import { createSystemNotice } from './notices';

// ----- "completed items are piling up" nudge --------------------------------
//
// Completed-but-undeleted tasks cost almost as much as active ones in every
// scan that only excludes `deleted=1` (see packages/core — the ancestor-dedup
// pass, allItems, etc.), so a workspace that never purges done tasks slowly
// degrades. This sweep nudges each user with a dismiss-only Inbox notice the
// first time their own purgeable count crosses a new +200 threshold, mirroring
// the `reminders_sent` dedup pattern in `push.ts` so it doesn't re-fire every
// tick once already over a threshold.

const THRESHOLD_STEP = 200;

/** Server-only per-tenant table (not part of the synced core schema). Tracks the
 *  highest +200 threshold already notified for a user, so dismissing doesn't get
 *  re-prompted every minute — only when the count grows past the next step. */
export function ensurePurgeNoticeTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS purge_notice_state (
      user_id        TEXT PRIMARY KEY,
      last_threshold INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/** What Settings → Data can actually purge (the same predicate as core's
 *  `completedBefore`, minus the whole-subtree qualification): the user's own
 *  real completed items old enough to purge. The age gate keeps the nudge from
 *  pointing at an empty purge section, and `sys_kind IS NULL` keeps dismissed
 *  system notices (which resolve as done tasks) from inflating the very count
 *  being nudged about. */
function completedCount(db: Db, userId: string, cutoffIso: string): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM items
      WHERE owner_id = ? AND status = 'done' AND deleted = 0 AND sys_kind IS NULL
        AND completed_at IS NOT NULL AND completed_at < ?`,
    [userId, cutoffIso],
  );
  return row?.n ?? 0;
}

function lastThreshold(db: Db, userId: string): number {
  const row = db.get<{ last_threshold: number }>(
    'SELECT last_threshold FROM purge_notice_state WHERE user_id = ?',
    [userId],
  );
  return row?.last_threshold ?? 0;
}

function setLastThreshold(db: Db, userId: string, threshold: number): void {
  db.run(
    `INSERT INTO purge_notice_state (user_id, last_threshold) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_threshold = excluded.last_threshold`,
    [userId, threshold],
  );
}

/**
 * For every real (non-bot, non-deleted, non-shadow) user in this tenant DB: if
 * their purgeable completed-item count has crossed a new `THRESHOLD_STEP`
 * multiple since the last notice, drop a dismiss-only Inbox "Carbon task"
 * nudging them toward Settings → Data. Whenever the count drops below the
 * last-notified band (a purge), the watermark is lowered to the current band so
 * the next crossing fires again rather than waiting for the old high-water mark.
 */
export function checkPurgeSuggestions(db: Db, deviceId: string): void {
  const cutoffIso = new Date(Date.now() - COMPLETED_PURGE_AGE_DAYS * 86_400_000).toISOString();
  // is_remote excludes federation shadow users — a notice addressed to one could
  // never be seen or dismissed by any local session.
  const users = db.all<{ id: string }>(
    'SELECT id FROM users WHERE deleted = 0 AND is_bot = 0 AND is_remote = 0',
  );
  for (const u of users) {
    const count = completedCount(db, u.id, cutoffIso);
    const crossed = Math.floor(count / THRESHOLD_STEP) * THRESHOLD_STEP;
    const last = lastThreshold(db, u.id);
    if (crossed > last) {
      createSystemNotice(db, deviceId, u.id, {
        kind: 'purge_suggestion',
        title: `${count} old completed tasks — time to tidy up?`,
        body: `You have ${count} completed tasks older than ${COMPLETED_PURGE_AGE_DAYS} days. Exporting a backup and purging them in Settings → Data keeps things fast.`,
      });
      setLastThreshold(db, u.id, crossed);
    } else if (crossed < last) {
      setLastThreshold(db, u.id, crossed);
    }
  }
}
