import type { Db } from '@carbon/core';

/** Count all overdue tasks, including descendants hidden by list-root deduplication. */
export function countOverdueTasks(db: Db, now = new Date()): number {
  return db.get<{ n: number }>(
    `SELECT count(*) AS n FROM items
     WHERE deleted = 0 AND type = 'task' AND status = 'active'
       AND julianday(due_date) < julianday(?)`,
    [now.toISOString()],
  )?.n ?? 0;
}
