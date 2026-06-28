import { useParams } from 'react-router-dom';
import { Pencil, Pause } from 'lucide-react';
import {
  listTags,
  getItemsByTag,
  expandTagIds,
  effectiveTagColor,
  type Item,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { getCurrentUserId, useStore } from '@/lib/store';
import { enrichItems } from '@/lib/enrich';
import { createFromQuickAdd } from '@/lib/quickadd';
import { QuickAdd } from '@/components/QuickAdd';
import { TaskList } from '@/components/TaskList';
import { TagMark } from '@/components/TagMark';
import { abbreviateTagPath } from '@/lib/tagLabel';

export function TagsView() {
  const { id } = useParams();
  const openTagsPanel = useStore((s) => s.openTagsPanel);
  const tagsPanelOpen = useStore((s) => s.tagsPanelOpen);

  const data = useQuery(
    (db) => {
      const tags = listTags(db);
      const selected = id ? tags.find((t) => t.id === id) : undefined;
      if (!selected) return { selected: undefined, color: null, rows: [] };
      // Descendant-inclusive: a parent tag surfaces its children's tasks too.
      const ids = expandTagIds(db, [id!]);
      const seen = new Map<string, Item>();
      for (const tid of ids) for (const it of getItemsByTag(db, tid)) seen.set(it.id, it);
      return {
        selected,
        color: effectiveTagColor(db, selected.name),
        rows: enrichItems(db, [...seen.values()]),
      };
    },
    [id],
  );

  function create(text: string) {
    if (!data?.selected) return;
    // Tag every captured task with this tag (its colon-path is one quick-add token).
    mutate((db, dev) =>
      createFromQuickAdd(db, dev, `${text} #${data.selected!.name}`, {
        ownerId: getCurrentUserId(),
      }),
    );
  }

  if (!data?.selected) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">Tags</h1>
        <p className="mt-2 text-sm text-text-muted">
          Pick a tag from the Tags panel to see everything filed under it (including nested tags).
        </p>
        {!tagsPanelOpen && (
          <button
            onClick={openTagsPanel}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            <Pencil size={15} /> Open Tags panel
          </button>
        )}
      </div>
    );
  }

  const { selected, color, rows } = data;
  const onHold = selected.status === 'on-hold';

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-1.5 text-2xl font-bold tracking-tight">
            <TagMark color={color} className="text-xl" />
            <span title={selected.name}>{abbreviateTagPath(selected.name)}</span>
          </h1>
          <p className="mt-0.5 flex items-center gap-2 text-sm text-text-muted">
            {rows.length} {rows.length === 1 ? 'task' : 'tasks'} (incl. nested)
            {onHold && (
              <span className="inline-flex items-center gap-1 text-text-faint">
                <Pause size={12} /> on hold
              </span>
            )}
          </p>
        </div>
        {!tagsPanelOpen && (
          <button
            onClick={openTagsPanel}
            title="Manage tags"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-muted hover:bg-surface-2"
          >
            <Pencil size={14} /> Manage
          </button>
        )}
      </div>

      <div className="mb-3">
        <QuickAdd onCreate={create} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
          No tasks with this tag yet.
        </div>
      ) : (
        <TaskList items={rows} showProject reorderable={false} />
      )}
    </div>
  );
}
