import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Settings2, Timer, Square } from 'lucide-react';
import {
  getItem,
  getChildren,
  subtaskProgress,
  listTags,
  getProjects,
  getTimeContext,
  startSession,
  stopActive,
  type Item,
} from '@carbon/core';
import { cn } from '@/lib/cn';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { useStore, getCurrentUserId } from '@/lib/store';
import { createFromQuickAdd } from '@/lib/quickadd';
import { enrichItems } from '@/lib/enrich';
import { applyFilters } from '@/lib/filter';
import { applySort, getPrefs, savePrefs, type ViewPrefs } from '@/lib/views';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { QuickAdd } from '@/components/QuickAdd';
import { TaskTree } from '@/components/TaskTree';
import { TaskList } from '@/components/TaskList';
import { ViewControls } from '@/components/ViewControls';
import { Markdown } from '@/components/Markdown';

/**
 * Renders any item as a container: breadcrumbs, header, view controls, and either a
 * drag-to-nest tree (default) or a filtered/sorted flat list when controls are active.
 */
export function ContainerView() {
  const { id = '' } = useParams();
  const select = useStore((s) => s.select);

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
      const tasks = desc.filter((c) => c.type === 'task');
      const rows = enrichItems(db, applySort(applyFilters(db, tasks, prefs.filters), prefs.sort));
      const ctx = getTimeContext(db, getCurrentUserId());
      const tracking = ctx.session?.item_id === id && !ctx.paused;
      return { item, remaining, rows, tracking };
    },
    [id, JSON.stringify(prefs), countScope],
  );
  const tags = useQuery((db) => listTags(db), []) ?? [];
  const projects = useQuery((db) => getProjects(db), []) ?? [];

  if (!data) {
    return <div className="p-8 text-sm text-text-muted">Not found.</div>;
  }
  const { item, remaining, rows, tracking } = data;
  const isProject = item.type === 'project';

  function toggleTrack() {
    const uid = getCurrentUserId();
    if (tracking) mutate((db, dev) => stopActive(db, dev, uid));
    else mutate((db, dev) => startSession(db, dev, id, uid));
  }

  function create(text: string) {
    mutate((db, dev) =>
      createFromQuickAdd(db, dev, text, { parentId: id, ownerId: getCurrentUserId() }),
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <Breadcrumbs id={id} />

      <div className="mb-4 flex items-start gap-3">
        <span
          className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
          style={{ background: item.color || 'var(--accent)' }}
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">
            {item.title || (isProject ? 'Untitled project' : 'Untitled')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {remaining} {remaining === 1 ? 'task' : 'tasks'} left
            {!isProject && ' · focused'}
          </p>
          {item.note && <Markdown className="mt-2 text-text-muted">{item.note}</Markdown>}
        </div>
        <button
          onClick={toggleTrack}
          className={cn(
            'rounded-lg p-2 hover:bg-surface-2',
            tracking ? 'text-danger' : 'text-text-muted hover:text-text',
          )}
          title={tracking ? 'Stop tracking' : 'Track this project'}
        >
          {tracking ? <Square size={18} fill="currentColor" /> : <Timer size={18} />}
        </button>
        <button
          onClick={() => select(item.id)}
          className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text"
          title="Details"
        >
          <Settings2 size={18} />
        </button>
      </div>

      <div className="mb-3">
        <QuickAdd
          placeholder={isProject ? 'Add a task to this project…' : 'Add a sub-task…'}
          onCreate={create}
        />
      </div>

      <ViewControls prefs={prefs} onChange={updatePrefs} tags={tags} projects={projects} />

      {flatMode ? (
        rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
            No tasks match these filters.
          </div>
        ) : (
          <TaskList items={rows} reorderable={false} />
        )
      ) : (
        <TaskTree rootId={id} filters={prefs.filters} />
      )}
    </div>
  );
}
