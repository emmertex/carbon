import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTags, getProjects } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { getCurrentUserId, useStore } from '@/lib/store';
import { queryRoots } from '@/lib/listQuery';
import { createFromQuickAdd } from '@/lib/quickadd';
import { QuickAdd } from '@/components/QuickAdd';
import { ViewRow } from '@/components/ViewRow';
import { VirtualTaskList } from '@/components/VirtualTaskList';
import { ViewControls } from '@/components/ViewControls';
import {
  getPrefs,
  savePrefs,
  getPerspective,
  addPerspective,
  updatePerspective,
  type Base,
  type ViewPrefs,
} from '@/lib/views';

export interface QuickAddDefaults {
  dueToday?: boolean;
  flagged?: boolean;
}

export function ListView({
  base,
  title,
  quickAdd,
  emptyText,
  perspectiveId,
}: {
  base: Base;
  title: string;
  quickAdd?: QuickAddDefaults;
  emptyText: string;
  perspectiveId?: string;
}) {
  const navigate = useNavigate();
  const settingsRevision = useStore((s) => s.settingsRevision);
  const saved = perspectiveId ? getPerspective(perspectiveId) : undefined;
  const effectiveBase: Base = saved?.base ?? base;
  const heading = saved?.name ?? title;

  const [prefs, setPrefs] = useState<ViewPrefs>(
    () => saved?.prefs ?? getPrefs(base),
  );
  useEffect(() => {
    setPrefs(
      perspectiveId
        ? (getPerspective(perspectiveId)?.prefs ?? getPrefs(base))
        : getPrefs(base),
    );
    // settingsRevision: re-read after inbound perspective/view-prefs sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, perspectiveId, settingsRevision]);

  function updatePrefs(p: ViewPrefs) {
    setPrefs(p);
    if (perspectiveId) updatePerspective(perspectiveId, { prefs: p });
    else savePrefs(base, p);
  }

  // Cheap: SQL-prefiltered, filtered, sorted top-level rows — no enrichment.
  // VirtualTaskList enriches + renders only the visible window.
  const rows = useQuery(
    (db) => queryRoots(db, effectiveBase, prefs),
    [effectiveBase, perspectiveId, JSON.stringify(prefs)],
    'listview.roots',
  );
  const tags = useQuery((db) => listTags(db), []) ?? [];
  const projects = useQuery((db) => getProjects(db), []) ?? [];

  function create(text: string) {
    mutate(
      (db, dev) =>
        createFromQuickAdd(db, dev, text, {
          ownerId: getCurrentUserId(),
          dueToday: quickAdd?.dueToday,
          flagged: quickAdd?.flagged,
        }),
      'create',
    );
  }

  function savePerspective(name: string) {
    const id = crypto.randomUUID();
    addPerspective({ id, name, base: effectiveBase, prefs });
    navigate(`/view/${id}`);
  }

  const count = rows?.length ?? 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-3">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="active-view">
          {heading}
        </h1>
        <p className="mt-0.5 text-sm text-text-muted">
          {count} {count === 1 ? 'task' : 'tasks'}
        </p>
      </div>

      <ViewControls
        prefs={prefs}
        onChange={updatePrefs}
        onSavePerspective={perspectiveId ? undefined : savePerspective}
        tags={tags}
        projects={projects}
      />

      <ViewRow grouping className="mb-3" />

      {quickAdd && (
        <div className="mb-3">
          <QuickAdd onCreate={create} />
        </div>
      )}

      {count === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
          {emptyText}
        </div>
      ) : (
        <VirtualTaskList items={rows!} reorderable={prefs.sort === 'manual'} />
      )}
    </div>
  );
}
