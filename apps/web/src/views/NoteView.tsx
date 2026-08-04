import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, FileText } from 'lucide-react';
import { getItem, getChildren, updateItem } from '@carbon/core';
import { cn } from '@/lib/cn';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { useStore } from '@/lib/store';
import { enrichItems } from '@/lib/enrich';
import { readNoteMeta, patchNoteMeta } from '@/lib/noteMeta';
import { ensureNoteThumb } from '@/lib/thumbs';
import { RECIPE_TEMPLATE, type NoteMode } from '@/lib/recipe';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { NoteEditor } from '@/components/NoteEditor';
import { RecipeView } from '@/components/RecipeView';
import { TaskList } from '@/components/TaskList';
import { btnSecondary } from '@/components/ui/controls';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

/**
 * A note as a full-page document. Notes are the one item type that outgrows the
 * detail pane (380px docked, or a max-w-md overlay) — a recipe's ingredients and
 * procedure can't sit side by side in it — and the /focus container view is built
 * around a task list, not a document. So `useFocusItem` sends notes here instead.
 */
export function NoteView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);
  // Set by TaskDetail's expand button; lets Return restore the list/project we left.
  const returnTo =
    typeof (location.state as { from?: unknown } | null)?.from === 'string'
      ? (location.state as { from: string }).from
      : null;
  // Recipe mode renders a scaled, read-only view; Edit swaps the one editor in for
  // it. Exactly one of the two is ever mounted over this note — two live editors on
  // one field race their autosaves (see NoteEditor's expand-modal comment).
  const [editing, setEditing] = useState(false);
  // Router reuses this component across /note/a → /note/b, so an open editor would
  // otherwise carry over to the next note.
  useEffect(() => setEditing(false), [id]);

  const data = useQuery(
    (db) => {
      const item = getItem(db, id);
      if (!item || item.deleted) return null;
      // A note can legitimately have children, and /focus/:id listed them before
      // notes routed here — keep them on the page. Direct children only: they're
      // true siblings, so the list stays drag-reorderable.
      return { item, rows: enrichItems(db, getChildren(db, id)) };
    },
    [id],
    'note.data',
  );

  if (!data) {
    return <div className="p-8 text-sm text-text-muted">Not found.</div>;
  }
  const { item, rows } = data;
  const note = item.note ?? '';
  // Metadata is parsed, not validated (see noteMeta.ts) — anything but 'recipe'
  // reads as the default.
  const noteMode: NoteMode = readNoteMeta(item).noteMode === 'recipe' ? 'recipe' : 'notes';

  // Mirrors TaskDetail's commitNote, thumbnail refresh included — without it a note
  // edited here keeps the row thumbnail of its old first image.
  function commitNote(next: string) {
    const v = next.trim() ? next : null;
    if (v === item.note) return;
    mutate((db, dev) => updateItem(db, dev, id, { note: v }));
    void ensureNoteThumb(id);
  }

  function selectNoteMode(next: NoteMode) {
    if (next === noteMode) return;
    patchNoteMeta(id, { noteMode: next });
    // Seed the skeleton into an EMPTY body only: appending to real content would
    // destroy work on a mis-tap. Switching back to notes never touches the body.
    if (next === 'recipe' && !note.trim()) commitNote(RECIPE_TEMPLATE);
    setEditing(false);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-3 flex items-center gap-2">
        {returnTo && (
          <button
            type="button"
            onClick={() => navigate(returnTo)}
            className={cn(btnSecondary, 'shrink-0 px-2.5 py-1 text-xs')}
            aria-label="Return to previous view"
            title="Return to previous view"
          >
            <ArrowLeft size={13} />
            Return
          </button>
        )}
        <div className="min-w-0 flex-1">
          <Breadcrumbs id={id} className="mb-0" />
        </div>
      </div>

      <div className="mb-4 flex items-start gap-3">
        <span className="mt-1.5 shrink-0 text-text-faint" aria-hidden>
          <FileText size={20} />
        </span>
        <div className="min-w-0 flex-1">
          {/* The title opens the detail pane — title, tags, sharing and the rest of
              the item fields live there, same as clicking a project header. */}
          <h1
            onClick={() => {
              select(id);
              openDetail(); // compact: the overlay only renders on detailOpen
            }}
            className="cursor-pointer truncate text-2xl font-bold tracking-tight hover:text-accent"
            title="Note details"
          >
            {item.title || 'Untitled'}
          </h1>
          <div className="mt-2">
            <SegmentedControl<NoteMode>
              value={noteMode}
              onChange={selectNoteMode}
              options={[
                { value: 'notes', label: 'Notes' },
                {
                  value: 'recipe',
                  label: 'Recipe',
                  title: 'Scale ingredients and convert units',
                },
              ]}
            />
          </div>
        </div>
      </div>

      {noteMode === 'recipe' && !editing ? (
        <RecipeView id={id} body={note} onEdit={() => setEditing(true)} onReplace={commitNote} />
      ) : (
        <>
          {noteMode === 'recipe' && (
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className={cn(btnSecondary, 'px-2.5 py-1 text-xs')}
              >
                <Check size={13} /> Done
              </button>
            </div>
          )}
          <NoteEditor
            key={item.id}
            value={note}
            remoteNote={note}
            onSave={commitNote}
            placeholder="Write…  (Markdown supported)"
            minHeightClassName="min-h-[60vh]"
          />
        </>
      )}

      {rows.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">
            {rows.length} {rows.length === 1 ? 'item' : 'items'}
          </h2>
          <TaskList items={rows} />
        </div>
      )}
    </div>
  );
}
