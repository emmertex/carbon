import { getChildren, type Db, type Item } from '@carbon/core';

export interface FlatItem {
  id: string;
  item: Item;
  parentId: string; // actual DB parent (the root id for top-level entries)
  depth: number;
}

export const INDENT_WIDTH = 24;

/** Depth-first flatten of a container's descendant tree, in sort order. */
export function flattenTree(db: Db, rootId: string): FlatItem[] {
  const acc: FlatItem[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const child of getChildren(db, parentId)) {
      acc.push({ id: child.id, item: child, parentId, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(rootId, 0);
  return acc;
}

/** Remove the dragged item's descendants so it can't be dropped inside itself. */
export function removeDescendants(items: FlatItem[], id: string): FlatItem[] {
  const excluded = new Set<string>([id]);
  return items.filter((i) => {
    if (i.parentId && excluded.has(i.parentId)) {
      excluded.add(i.id);
      return false;
    }
    return true;
  });
}

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const copy = arr.slice();
  copy.splice(to < 0 ? copy.length + to : to, 0, copy.splice(from, 1)[0]!);
  return copy;
}

export interface Projection {
  depth: number;
  parentId: string;
}

/**
 * Given the current drag, compute where the item would land: its new depth and
 * the DB parent_id it should adopt. Mirrors dnd-kit's sortable-tree projection.
 */
export function getProjection(
  items: FlatItem[],
  rootId: string,
  activeId: string,
  overId: string,
  dragOffsetX: number,
): Projection {
  const overIndex = items.findIndex((i) => i.id === overId);
  const activeIndex = items.findIndex((i) => i.id === activeId);
  if (overIndex < 0 || activeIndex < 0) return { depth: 0, parentId: rootId };

  const activeItem = items[activeIndex]!;
  const newItems = arrayMove(items, activeIndex, overIndex);
  const prev = newItems[overIndex - 1];
  const next = newItems[overIndex + 1];

  const dragDepth = Math.round(dragOffsetX / INDENT_WIDTH);
  const projectedDepth = activeItem.depth + dragDepth;
  const maxDepth = prev ? prev.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.max(minDepth, Math.min(projectedDepth, maxDepth));

  const parentId = (() => {
    if (depth === 0 || !prev) return rootId;
    if (depth === prev.depth) return prev.parentId;
    if (depth > prev.depth) return prev.id;
    const ancestor = newItems
      .slice(0, overIndex)
      .reverse()
      .find((i) => i.depth === depth);
    return ancestor?.parentId ?? rootId;
  })();

  return { depth, parentId };
}

/** A fractional sort_order that places `activeId` under `parentId` at the drop point. */
export function computeSortOrder(
  items: FlatItem[],
  activeId: string,
  overId: string,
  parentId: string,
): number {
  const siblings = items.filter((i) => i.parentId === parentId && i.id !== activeId);
  const overIdx = items.findIndex((i) => i.id === overId);

  let prevOrder: number | undefined;
  let nextOrder: number | undefined;
  for (const s of siblings) {
    const idx = items.findIndex((i) => i.id === s.id);
    if (idx <= overIdx) prevOrder = s.item.sort_order;
    else {
      nextOrder = s.item.sort_order;
      break;
    }
  }

  if (prevOrder === undefined && nextOrder === undefined) return 1;
  if (prevOrder === undefined) return nextOrder! - 1;
  if (nextOrder === undefined) return prevOrder + 1;
  return (prevOrder + nextOrder) / 2;
}
