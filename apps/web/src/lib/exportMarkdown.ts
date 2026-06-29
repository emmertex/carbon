import { format } from 'date-fns';
import { getItem, getChildren, getItemTags, type Db, type Item } from '@carbon/core';
import { getDb } from './db';
import { isAllDay } from './date';

/** Markdown checkbox mark for each item status. */
const MARK = { active: ' ', done: 'x', dropped: '/' } as const;

/** One checklist line for `item`, indented two spaces per depth level. */
function lineFor(db: Db, item: Item, depth: number): string {
  const indent = '  '.repeat(depth);
  const tags = getItemTags(db, item.id).map((t) => `#${t.name}`);
  const due = item.due_date
    ? `@due:${format(
        new Date(item.due_date),
        isAllDay(item.due_date) ? 'yyyyMMdd' : 'yyyyMMddHHmm',
      )}`
    : null;
  const parts = [item.title || '(untitled)', ...tags, due].filter(Boolean);
  return `${indent}* [${MARK[item.status]}] ${parts.join(' ')}`;
}

/** Depth-first walk, children in sort order, skipping deleted descendants. */
function walk(db: Db, item: Item, depth: number, out: string[]): void {
  out.push(lineFor(db, item, depth));
  for (const child of getChildren(db, item.id)) {
    if (child.deleted) continue;
    walk(db, child, depth + 1, out);
  }
}

/**
 * Render `rootId` and all its descendants as a Markdown checklist —
 * `[ ]` active, `[x]` done, `[/]` dropped, with inline `#tags` and an `@due:`
 * attribute when present. Returns '' if the item is missing or deleted.
 */
export function treeToMarkdown(db: Db, rootId: string): string {
  const root = getItem(db, rootId);
  if (!root || root.deleted) return '';
  const out: string[] = [];
  walk(db, root, 0, out);
  return out.join('\n');
}

/** Same as {@link treeToMarkdown}, against the live app database. */
export function itemTreeToMarkdown(rootId: string): string {
  return treeToMarkdown(getDb(), rootId);
}
