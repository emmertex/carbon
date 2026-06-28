import type { Item } from '@carbon/core';

export type FolderRowKind = 'folder' | 'project' | 'empty-folder-slot';

/** A single flattened sidebar row. Folders and ungrouped projects share one
 *  top-level sort_order number-line; a folder's member projects share their own. */
export interface FolderRow {
  kind: FolderRowKind;
  /** Stable dnd id. For empty slots: `slot:<folderId>`. */
  id: string;
  /** The underlying item; null for an empty-folder drop slot. */
  item: Item | null;
  /** Containing folder (membership). null = top level. */
  folderId: string | null;
  depth: number;
  /** Open-task count (rollup across members for a folder row). */
  open: number;
}

const cmp = (a: Item, b: Item) =>
  a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);

/**
 * Build the flattened sidebar rows from folders + projects, honouring collapse
 * state. Folders and ungrouped projects are interleaved at the top level by
 * sort_order; each expanded folder is followed by its member projects (or an
 * empty drop slot). A project whose folder is missing/deleted falls back to top
 * level so it can never be lost.
 */
export function buildFolderRows(
  folders: Item[],
  projects: Item[],
  openById: Record<string, number>,
  collapsed: Set<string>,
): FolderRow[] {
  const folderIds = new Set(folders.map((f) => f.id));
  const byFolder = new Map<string, Item[]>();
  const topProjects: Item[] = [];
  for (const p of projects) {
    if (p.folder_id && folderIds.has(p.folder_id)) {
      const list = byFolder.get(p.folder_id) ?? [];
      list.push(p);
      byFolder.set(p.folder_id, list);
    } else {
      topProjects.push(p);
    }
  }

  const top = [...folders, ...topProjects].sort(cmp);
  const rows: FolderRow[] = [];
  for (const it of top) {
    if (it.type === 'folder') {
      const kids = (byFolder.get(it.id) ?? []).sort(cmp);
      const rollup = kids.reduce((s, k) => s + (openById[k.id] ?? 0), 0);
      rows.push({ kind: 'folder', id: it.id, item: it, folderId: null, depth: 0, open: rollup });
      if (!collapsed.has(it.id)) {
        if (kids.length === 0) {
          rows.push({
            kind: 'empty-folder-slot',
            id: `slot:${it.id}`,
            item: null,
            folderId: it.id,
            depth: 1,
            open: 0,
          });
        } else {
          for (const k of kids) {
            rows.push({
              kind: 'project',
              id: k.id,
              item: k,
              folderId: it.id,
              depth: 1,
              open: openById[k.id] ?? 0,
            });
          }
        }
      }
    } else {
      rows.push({
        kind: 'project',
        id: it.id,
        item: it,
        folderId: null,
        depth: 0,
        open: openById[it.id] ?? 0,
      });
    }
  }
  return rows;
}

/** The sort_order group a row participates in: top-level (null) for folders and
 *  ungrouped projects, else the containing folder id. Empty slots aren't ordered. */
export function rowGroup(r: FolderRow): string | null {
  return r.kind === 'folder' ? null : r.folderId;
}

/**
 * The group a dragged row should land in given its new index in the reordered
 * list — inferred from the row directly above it. Dropping just under an expanded
 * folder header puts the item inside that folder; a collapsed folder header (or a
 * top-level row) means top level.
 */
export function targetGroupAt(
  rows: FolderRow[],
  index: number,
  collapsed: Set<string>,
): string | null {
  const above = rows[index - 1];
  if (!above) return null;
  if (above.kind === 'folder') return collapsed.has(above.id) ? null : above.id;
  return above.folderId;
}
