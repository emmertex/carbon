import type { Item } from './types';

export function endOfToday(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function isActive(item: Item): boolean {
  return !item.deleted && item.status === 'active';
}

/** Deferred items aren't actionable until their defer date passes. */
export function isAvailable(item: Item, now: Date = new Date()): boolean {
  if (!isActive(item)) return false;
  if (item.defer_date && new Date(item.defer_date).getTime() > now.getTime()) return false;
  return true;
}

/** Tasks with no parent project — the unsorted capture bucket. */
export function inbox(items: Item[]): Item[] {
  return items.filter((i) => i.type === 'task' && i.parent_id === null && isActive(i));
}

/** Due today or earlier (overdue), or flagged — the classic "Today" list. */
export function today(items: Item[], now: Date = new Date()): Item[] {
  const cutoff = endOfToday(now).getTime();
  return items.filter((i) => {
    if (i.type !== 'task' || !isAvailable(i, now)) return false;
    const due = i.due_date ? new Date(i.due_date).getTime() : null;
    return (due !== null && due <= cutoff) || i.flagged;
  });
}

export function flagged(items: Item[]): Item[] {
  return items.filter((i) => i.type === 'task' && isActive(i) && i.flagged);
}

/** Overdue means due on an earlier calendar day — not merely earlier today. */
export function isOverdue(item: Item, now: Date = new Date()): boolean {
  if (!isActive(item) || item.due_date === null) return false;
  // Due is a datetime: a timed due is overdue at its time; an all-day due (stored
  // at end-of-day) is overdue only once the day has passed.
  return new Date(item.due_date).getTime() < now.getTime();
}

/** Due on today's calendar day. */
export function isDueToday(item: Item, now: Date = new Date()): boolean {
  if (item.due_date === null) return false;
  const d = new Date(item.due_date);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}
