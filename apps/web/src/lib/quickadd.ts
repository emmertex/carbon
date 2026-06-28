import {
  listUsers,
  createItem,
  createTag,
  setItemTags,
  getItemTags,
  updateItem,
  assignItem,
  shareItem,
  hasWriteAccess,
  type Db,
  type User,
} from '@carbon/core';
import { todayDueISO } from './enrich';

export const PRIORITY_WORDS: Record<string, number> = {
  '0': 0,
  none: 0,
  n: 0,
  '1': 1,
  low: 1,
  l: 1,
  '2': 2,
  med: 2,
  medium: 2,
  m: 2,
  '3': 3,
  high: 3,
  h: 3,
};

export function parsePriorityWord(s: string): number | undefined {
  return PRIORITY_WORDS[s.toLowerCase()];
}

export interface ParsedQuickAdd {
  title: string;
  tagNames: string[];
  assigneeIds: string[];
  priority?: number;
}

/**
 * Extract `#tag`, `@user`, and `!priority` tokens from quick-add text. Recognized
 * tokens are removed from the title; an `@user` that doesn't match a known user is
 * kept as literal text (it wasn't a real mention).
 */
export function parseQuickAdd(raw: string, roster: User[]): ParsedQuickAdd {
  const tagNames: string[] = [];
  const assigneeIds: string[] = [];
  let priority: number | undefined;
  const kept: string[] = [];

  for (const tok of raw.split(/\s+/)) {
    const trigger = tok[0];
    const rest = tok.slice(1);
    if (rest && trigger === '#') {
      if (!tagNames.some((t) => t.toLowerCase() === rest.toLowerCase())) tagNames.push(rest);
      continue;
    }
    if (rest && trigger === '@') {
      const u = roster.find((r) => r.username.toLowerCase() === rest.toLowerCase());
      if (u) {
        if (!assigneeIds.includes(u.id)) assigneeIds.push(u.id);
        continue;
      }
      kept.push(tok); // unknown user → keep as text
      continue;
    }
    if (rest && trigger === '!') {
      const p = parsePriorityWord(rest);
      if (p !== undefined) {
        priority = p;
        continue;
      }
      kept.push(tok); // unknown priority → keep as text
      continue;
    }
    kept.push(tok);
  }

  return { title: kept.join(' ').trim(), tagNames, assigneeIds, priority };
}

export interface QuickAddOpts {
  parentId?: string | null;
  dueToday?: boolean;
  flagged?: boolean;
  ownerId?: string | null;
}

/** Create a task from quick-add text, applying inline tags/assignees/priority. */
export function createFromQuickAdd(db: Db, deviceId: string, raw: string, opts: QuickAddOpts) {
  const parsed = parseQuickAdd(raw, listUsers(db));
  const item = createItem(db, deviceId, {
    title: parsed.title || raw.trim(),
    parentId: opts.parentId ?? null,
    ownerId: opts.ownerId ?? null,
    dueDate: opts.dueToday ? todayDueISO() : null,
    flagged: opts.flagged ?? false,
    priority: parsed.priority ?? 0,
  });
  if (parsed.tagNames.length) {
    setItemTags(
      db,
      deviceId,
      item.id,
      parsed.tagNames.map((n) => createTag(db, deviceId, n).id),
    );
  }
  for (const uid of parsed.assigneeIds) {
    assignItem(db, deviceId, item.id, uid);
    if (!hasWriteAccess(db, item.id, uid)) shareItem(db, deviceId, item.id, uid, 'write');
  }
  return item;
}

/**
 * Apply inline `#tag`/`@user`/`!priority` tokens to an EXISTING item, used by the
 * outliner's inline edit so its behaviour matches the quick-add box. The cleaned
 * title (and any priority) is written via updateItem; tags and assignees are merged
 * with what the item already has rather than replacing them.
 */
export function updateFromQuickAdd(db: Db, deviceId: string, itemId: string, raw: string) {
  const parsed = parseQuickAdd(raw, listUsers(db));
  updateItem(db, deviceId, itemId, {
    title: parsed.title,
    ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
  });
  if (parsed.tagNames.length) {
    const existing = getItemTags(db, itemId).map((t) => t.id);
    const added = parsed.tagNames.map((n) => createTag(db, deviceId, n).id);
    setItemTags(db, deviceId, itemId, [...new Set([...existing, ...added])]);
  }
  for (const uid of parsed.assigneeIds) {
    assignItem(db, deviceId, itemId, uid);
    if (!hasWriteAccess(db, itemId, uid)) shareItem(db, deviceId, itemId, uid, 'write');
  }
}
