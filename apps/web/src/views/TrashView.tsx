import { formatDistanceToNow } from 'date-fns';
import { RotateCcw, Trash2, Folder, FileText, CheckSquare } from 'lucide-react';
import {
  deletedRoots,
  getItem,
  restorableIds,
  TRASH_WINDOW_DAYS,
  type Item,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { restoreTask } from '@/lib/taskActions';
import { ProjectGlyph } from '@/components/ProjectGlyph';

/** Type badge for a deleted row. Deleted items aren't navigable, so this is the
 *  only cue for what kind of thing (and how much of it) is coming back. */
function TypeIcon({ item }: { item: Item }) {
  if (item.type === 'project')
    return <ProjectGlyph mode={item.order_mode} size={15} color={item.color} />;
  if (item.type === 'folder') return <Folder size={15} className="text-text-muted" />;
  if (item.type === 'note') return <FileText size={15} className="text-text-muted" />;
  return <CheckSquare size={15} className="text-text-muted" />;
}

/**
 * Recently Deleted — the safety net behind the delete undo snackbar. A left swipe
 * or a mis-aimed tap is easy, and the snackbar is gone within seconds; this lists
 * the last {@link TRASH_WINDOW_DAYS} days of deletes so anything can still come
 * back. Each row is one delete *event*: deleting a project or a task with
 * sub-tasks restores the whole subtree in one click, not one row at a time.
 */
export function TrashView() {
  const entries = useQuery((db) =>
    deletedRoots(db).map((e) => {
      const parent = e.item.parent_id ? getItem(db, e.item.parent_id) : undefined;
      return {
        item: e.item,
        deletedAt: e.deletedAt,
        count: restorableIds(db, e.item.id).length,
        parentTitle: parent?.title || null,
      };
    }),
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Recently Deleted</h1>
        <p className="mt-0.5 text-sm text-text-muted">
          Anything deleted in the last {TRASH_WINDOW_DAYS} days, newest first. Restoring puts a
          task back where it was, with its sub-tasks.
        </p>
      </div>

      {entries && entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
          <Trash2 size={20} className="mx-auto mb-2 text-text-faint" />
          Nothing deleted recently.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {entries?.map(({ item, deletedAt, count, parentTitle }) => (
            <div
              key={item.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3"
            >
              <span className="shrink-0">
                <TypeIcon item={item} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{item.title || 'Untitled'}</p>
                <p className="text-xs text-text-muted">
                  {formatDistanceToNow(new Date(deletedAt), { addSuffix: true })}
                  {count > 1 && ` · ${count} items`}
                  {parentTitle && ` · in ${parentTitle}`}
                </p>
              </div>
              <button
                onClick={() => restoreTask(item)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
              >
                <RotateCcw size={15} /> Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
