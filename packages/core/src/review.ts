import type { Item } from './types';

/** Projects with a review_interval become due for review once enough days pass. */
export function reviewDueAt(item: Item): Date | null {
  if (item.type !== 'project' || !item.review_interval) return null;
  const base = item.reviewed_at ?? item.created_at;
  const d = new Date(base);
  d.setDate(d.getDate() + item.review_interval);
  return d;
}

export function needsReview(item: Item, now: Date = new Date()): boolean {
  const due = reviewDueAt(item);
  return due !== null && due.getTime() <= now.getTime();
}
