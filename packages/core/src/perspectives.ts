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

/** True when two instants land on the same calendar day, as measured by the
 *  local timezone of whichever process evaluates this (`getFullYear`/`getMonth`/
 *  `getDate` are local-time getters). Both `a` and `b` must be compared in that
 *  same frame — see `isDueToday` below for why that isn't automatically true. */
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Due on today's calendar day, compared in the local timezone of whoever calls
 *  this (typically the browser tab currently rendering the perspective). Note
 *  this is a different frame than the one `due_date` was necessarily *written*
 *  in: an all-day due is encoded as local 23:59 on the authoring device, so if
 *  that device was in a different timezone than the one reading it here, the
 *  calendar day extracted from the UTC instant can disagree with the day the
 *  due date's author intended (same class of skew as CAL-1 for CalDAV, just
 *  scoped to this client-side perspective filter rather than sync). */
export function isDueToday(item: Item, now: Date = new Date()): boolean {
  if (item.due_date === null) return false;
  return sameLocalDay(new Date(item.due_date), now);
}
