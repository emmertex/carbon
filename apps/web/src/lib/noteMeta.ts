import { getItem, updateItem, type Item } from '@carbon/core';
import { mutate } from './mutate';
import type { NoteMode, UnitMode } from './recipe';

// Per-note settings stashed in the shared `items.metadata` JSON column.
//
// `metadata` is ONE whole-value LWW field: sync replaces the entire column, never
// individual keys, and more than one feature keeps state in there (these note
// settings, the GPS track summary). So every writer must read-modify-write and
// leave keys it doesn't own alone — otherwise the last feature to touch a note
// silently erases the other's state. The index signature below is that contract
// written down.

export interface NoteMeta {
  /** Editor mode for this note; absent = 'notes'. */
  noteMode?: NoteMode;
  /** Sticky scaling controls, so reopening a recipe restores what you last used. */
  recipe?: { servings?: number; units?: UnitMode };
  /** Keys owned by other features — preserved verbatim across a patch. */
  [k: string]: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse an item's metadata column. Never throws: malformed JSON, a JSON scalar or
 * array, and null all read as `{}`.
 *
 * Values come back as parsed, not validated — the column is hand-editable and
 * syncs from clients on other versions, so a known key can hold anything. That is
 * deliberate: it makes this the *verbatim* reader a merging writer needs, so a
 * value this build doesn't understand survives a round-trip instead of being
 * normalised away. Consumers must tolerate junk; `scaleRecipe` already degrades
 * safely on a nonsense factor.
 */
export function readNoteMeta(item: Pick<Item, 'metadata'>): NoteMeta {
  if (!item.metadata) return {};
  try {
    const parsed: unknown = JSON.parse(item.metadata);
    return isPlainObject(parsed) ? (parsed as NoteMeta) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into a note's metadata: shallow at the top level, one level deep
 * for `recipe` so patching `{ recipe: { servings: 2 } }` keeps a stored `units`.
 *
 * The read happens inside `mutate()` against live DB state rather than against a
 * render snapshot — the whole column is a single LWW value, so merging onto a
 * stale copy would resurrect keys someone else changed in between.
 */
export function patchNoteMeta(id: string, patch: NoteMeta): void {
  mutate((db, dev) => {
    const item = getItem(db, id);
    if (!item) return;
    const current = readNoteMeta(item);
    const next: Record<string, unknown> = { ...current, ...patch };
    if (isPlainObject(patch.recipe)) {
      const base = isPlainObject(current.recipe) ? current.recipe : {};
      next.recipe = { ...base, ...patch.recipe };
    }
    // An empty result goes back as null so the side panel's "See metadata" peek
    // doesn't appear for a note that carries no settings at all.
    const json = JSON.stringify(next);
    updateItem(db, dev, id, { metadata: json === '{}' ? null : json });
  }, 'noteMeta');
}
