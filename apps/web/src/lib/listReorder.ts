import { reorderItem, type Db, type Item } from '@carbon/core';

/** Move to a precise zero-based position. Repair tied/exhausted fractional ranks
 * only when needed, so imported lists with identical ranks still reorder correctly. */
export function moveListItem(db: Db, device: string, items: Item[], id: string, position: number): void {
  const from = items.findIndex((i) => i.id === id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(items.length - 1, Math.trunc(position)));
  if (!Number.isFinite(to) || from === to) return;
  const ordered = [...items];
  ordered.splice(to, 0, ordered.splice(from, 1)[0]!);
  const prev = ordered[to - 1]?.sort_order;
  const next = ordered[to + 1]?.sort_order;
  const rank = prev == null ? (next ?? 1) - 1 : next == null ? prev + 1 : (prev + next) / 2;
  if (!Number.isFinite(rank) || (prev != null && rank <= prev) || (next != null && rank >= next)) {
    ordered.forEach((item, index) => { if (item.sort_order !== index) reorderItem(db, device, item.id, index); });
  } else reorderItem(db, device, id, rank);
}
