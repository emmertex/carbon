import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Timer, Square } from 'lucide-react';
import {
  getItem,
  getChildren,
  subtaskProgress,
  listTags,
  getProjects,
  getTimeContext,
  type Item,
} from '@carbon/core';
import { cn } from '@/lib/cn';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { useStore, getCurrentUserId } from '@/lib/store';
import { createFromQuickAdd } from '@/lib/quickadd';
import { trackingStartSession, trackingStopActive } from '@/lib/trackingLifecycle';
import { enrichItems } from '@/lib/enrich';
import { filterByPrefs } from '@/lib/filter-expr';
import { applySort, getPrefs, savePrefs, type ViewPrefs } from '@/lib/views';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { QuickAdd } from '@/components/QuickAdd';
import { TaskTree } from '@/components/TaskTree';
import { TaskList } from '@/components/TaskList';
import { ViewControls } from '@/components/ViewControls';
import { ViewRow } from '@/components/ViewRow';
import { ProjectGlyph } from '@/components/ProjectGlyph';
import { Markdown } from '@/components/Markdown';

/**
 * Renders any item as a container: breadcrumbs, header, view controls, and either a
 * drag-to-nest tree (default) or a filtered/sorted flat list when controls are active.
 */
export function ContainerView() {
  const { id = '' } = useParams();
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);

  const [prefs, setPrefs] = useState<ViewPrefs>(() => getPrefs(`project:${id}`));
  useEffect(() => setPrefs(getPrefs(`project:${id}`)), [id]);
  function updatePrefs(p: ViewPrefs) {
    setPrefs(p);
    savePrefs(`project:${id}`, p);
  }
  // Manual sort keeps the drag-to-nest tree (filtered in place, hierarchy intact);
  // any other sort flattens into a sorted list (hierarchy can't be preserved then).
  const flatMode = prefs.sort !== 'manual';
  const countScope = useStore((s) => s.uiPrefs.countScope);

  const data = useQuery(
    (db) => {
      const item = getItem(db, id);
      if (!item || item.deleted) return null;
      const progress = subtaskProgress(db, id, countScope);
      const remaining = progress.total - progress.done;
      // Flat list of descendant tasks for the filtered view.
      const desc: Item[] = [];
      const queue = [id];
      while (queue.length) {
        const parent = queue.shift()!;
        for (const c of getChildren(db, parent)) {
          desc.push(c);
          queue.push(c.id);
        }
      }
      // Container/list views include notes inline alongside tasks (they render
      // with a distinct icon and no checkbox). Projects/folders stay excluded.
      const tasks = desc.filter((c) => c.type === 'task' || c.type === 'note');
      const noteCount = desc.filter((c) => c.type === 'note').length;
      // Only the flat view renders `rows`; in tree mode (default) TaskTree renders
      // and enriches its own rows, so skip a full-subtree enrich that's discarded.
      const rows = flatMode
        ? enrichItems(db, applySort(filterByPrefs(db, tasks, prefs), prefs.sort))
        : [];
      const ctx = getTimeContext(db, getCurrentUserId());
      const tracking = ctx.session?.item_id === id && !ctx.paused;
      // Every id in the subtree that has at least one child — i.e. every row the
      // tree shows a collapse chevron for. Excludes the root itself, which is the
      // page header, not a collapsible row — collapsing it would hide everything.
      // Drives ViewRow's Collapse/Expand All.
      const containerIds = [
        ...new Set(desc.map((c) => c.parent_id).filter((p): p is string => !!p && p !== id)),
      ];
      return { item, remaining, noteCount, rows, tracking, containerIds };
    },
    [id, JSON.stringify(prefs), countScope],
    'container.data',
  );
  const tags = useQuery((db) => listTags(db), []) ?? [];
  const projects = useQuery((db) => getProjects(db), []) ?? [];

  if (!data) {
    return <div className="p-8 text-sm text-text-muted">Not found.</div>;
  }
  const { item, remaining, noteCount, rows, tracking, containerIds } = data;
  const isProject = item.type === 'project';
  // A notes container: adds default to notes rather than tasks. `createItem`
  // enforces the same rule for every other add surface (outliner, sibling/subtask
  // buttons); here it just picks the right side of the Task/Note toggle up front.
  const isNotesProject = isProject && item.notes_project;

  function toggleTrack() {
    if (tracking) void trackingStopActive();
    else void trackingStartSession(id);
  }

  function create(text: string, type: 'task' | 'note' = isNotesProject ? 'note' : 'task') {
    mutate((db, dev) =>
      createFromQuickAdd(db, dev, text, { parentId: id, ownerId: getCurrentUserId(), type }),
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <Breadcrumbs id={id} />

      <div className="mb-4 flex items-start gap-3">
        {/* Glyph reflects the project's order mode (sequential/parallel/single),
            tinted by its colour; a focused task keeps a simple colour dot. */}
        {isProject ? (
          <span className="mt-1 shrink-0">
            <ProjectGlyph mode={item.order_mode} color={item.color} size={22} />
          </span>
        ) : (
          <span
            className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
            style={{ background: item.color || 'var(--accent)' }}
          />
        )}
        <div className="min-w-0 flex-1">
          {/* The title opens the project/task detail sidebar (replaces the old
              settings button). */}
          <h1
            onClick={() => {
              select(item.id);
              openDetail(); // compact: the overlay only renders on detailOpen
            }}
            className="cursor-pointer truncate text-2xl font-bold tracking-tight hover:text-accent"
            title={isProject ? 'Project details' : 'Details'}
          >
            {item.title || (isProject ? 'Untitled project' : 'Untitled')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {isNotesProject ? (
              // A notebook has nothing "left" to do — count what's in it instead.
              <>
                {noteCount} {noteCount === 1 ? 'note' : 'notes'}
              </>
            ) : (
              <>
                {remaining} {remaining === 1 ? 'task' : 'tasks'} left
                {!isProject && ' · focused'}
              </>
            )}
          </p>
          {item.note && <Markdown className="mt-2 text-text-muted">{item.note}</Markdown>}
        </div>
        <button
          onClick={toggleTrack}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium',
            tracking
              ? 'border-danger text-danger hover:bg-surface-2'
              : 'border-border text-text-muted hover:bg-surface-2 hover:text-text',
          )}
          title={tracking ? 'Stop tracking time' : 'Record time on this project'}
        >
          {tracking ? <Square size={14} fill="currentColor" /> : <Timer size={14} />}
          {tracking ? 'Stop' : 'Record Time'}
        </button>
      </div>

      <div className="mb-3">
        <QuickAdd
          placeholder={
            isNotesProject
              ? 'Add a note to this notebook…'
              : isProject
                ? 'Add a task to this project…'
                : 'Add a sub-task…'
          }
          onCreate={create}
          allowNote
          defaultKind={isNotesProject ? 'note' : 'task'}
          currentProjectId={isProject ? id : null}
        />
      </div>

      <ViewControls prefs={prefs} onChange={updatePrefs} tags={tags} projects={projects} />

      <ViewRow className="mb-3" collapseIds={flatMode ? undefined : containerIds} />

      {flatMode ? (
        rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
            No tasks match these filters.
          </div>
        ) : (
          <TaskList items={rows} reorderable={false} />
        )
      ) : (
        <TaskTree
          rootId={id}
          filters={prefs.mode === 'advanced' ? undefined : prefs.filters}
          expr={prefs.mode === 'advanced' ? prefs.expr : null}
        />
      )}
    </div>
  );
}
