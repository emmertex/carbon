import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Pause } from 'lucide-react';
import {
  listTags,
  getItemsByTag,
  getProjects,
  expandTagIds,
  effectiveTagColor,
  type Item,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { getCurrentUserId, useStore } from '@/lib/store';
import { enrichItems } from '@/lib/enrich';
import { applyFilters } from '@/lib/filter';
import { applySort, getPrefs, savePrefs, type ViewPrefs } from '@/lib/views';
import { createFromQuickAdd } from '@/lib/quickadd';
import { QuickAdd } from '@/components/QuickAdd';
import { TaskList } from '@/components/TaskList';
import { ViewControls } from '@/components/ViewControls';
import { ViewRow } from '@/components/ViewRow';
import { TagMark } from '@/components/TagMark';
import { abbreviateTagPath } from '@/lib/tagLabel';

export function TagsView() {
  const { id } = useParams();
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);

  // Deep-link / refresh on /tag/:id opens the tag's detail pane.
  useEffect(() => {
    if (id) select(id, 'tag');
  }, [id, select]);

  const [prefs, setPrefs] = useState<ViewPrefs>(() => getPrefs(`tag:${id}`));
  useEffect(() => setPrefs(getPrefs(`tag:${id}`)), [id]);
  function updatePrefs(p: ViewPrefs) {
    setPrefs(p);
    savePrefs(`tag:${id}`, p);
  }

  const data = useQuery(
    (db) => {
      const tags = listTags(db);
      const selected = id ? tags.find((t) => t.id === id) : undefined;
      if (!selected) return { selected: undefined, color: null, rows: [] };
      // Descendant-inclusive: a parent tag surfaces its children's tasks too.
      const ids = expandTagIds(db, [id!]);
      const seen = new Map<string, Item>();
      for (const tid of ids) for (const it of getItemsByTag(db, tid)) seen.set(it.id, it);
      const filtered = applySort(applyFilters(db, [...seen.values()], prefs.filters), prefs.sort);
      return {
        selected,
        color: effectiveTagColor(db, selected.name),
        rows: enrichItems(db, filtered),
      };
    },
    [id, JSON.stringify(prefs)],
  );
  const tags = useQuery((db) => listTags(db), []) ?? [];
  const projects = useQuery((db) => getProjects(db), []) ?? [];

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
          Pick a tag from the sidebar to see everything filed under it (including nested tags), or
          to edit its colour, hold status, and location.
        </p>
      </div>
    );
  }

  const { selected, color, rows } = data;
  const onHold = selected.status === 'on-hold';

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          {/* Tapping the title opens the tag detail pane (on compact screens the
              overlay only renders on detailOpen). */}
          <h1
            onClick={() => {
              select(selected.id, 'tag');
              openDetail();
            }}
            className="flex cursor-pointer items-center gap-1.5 text-2xl font-bold tracking-tight hover:text-accent"
            title="Tag details"
          >
            <TagMark color={color} className="text-xl" />
            <span>{abbreviateTagPath(selected.name)}</span>
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
      </div>

      <div className="mb-3">
        <QuickAdd onCreate={create} />
      </div>

      <ViewControls prefs={prefs} onChange={updatePrefs} tags={tags} projects={projects} />

      <ViewRow className="mb-3" />

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
