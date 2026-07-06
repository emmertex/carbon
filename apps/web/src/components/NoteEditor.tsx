import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { Markdown } from './Markdown';
import { cn } from '@/lib/cn';

// Tiptap + tiptap-markdown is a large dependency (ProseMirror + its schema/markdown
// bridge). It must NOT be on the critical path of task-detail render: the read view
// stays `Markdown.tsx` (react-markdown, already loaded everywhere), and the rich
// editor is only fetched — via this `lazy()` — the first time the user clicks into
// the Notes field to edit. That click-triggered `import()` is what makes Vite split
// TiptapEditor.tsx (and its deps) into their own async chunk; see the Phase 2 build
// verification in docs/internal/notes-plan.md.
const TiptapEditor = lazy(() =>
  import('./TiptapEditor').then((m) => ({ default: m.TiptapEditor })),
);

const AUTOSAVE_MS = 1500;

/**
 * Normalize a draft to the value it will surface as in `remoteNote` after a save.
 * The persistence path (TaskDetail's `commitNote`) stores a whitespace-only draft as
 * `null`, which comes back through `data.item.note ?? ''` as `''`. The conflict
 * snapshot (`openedRemoteRef`) must be compared in that same normalized space, or a
 * whitespace-only autosave would leave the snapshot as e.g. `'   '` while `remoteNote`
 * becomes `''` — a spurious "changed elsewhere" banner.
 */
function normalizeNote(draft: string): string {
  return draft.trim() ? draft : '';
}

/**
 * Notes field for any item (task, project, folder, or note). Read view is the
 * existing `Markdown.tsx` preview; clicking it lazy-loads the Tiptap editor.
 *
 * Save semantics: debounced autosave (~1.5s of inactivity) while the editor is
 * open, plus save-on-blur so a quick click-away never loses the last burst. Each
 * save is one full-value `note` op (matches the existing per-field LWW op model —
 * no new sync machinery).
 *
 * Conflict banner: `remoteNote` is the live `items.note` value from the reactive
 * `useQuery` (recomputed on every DB revision bump, including sync pulls — see
 * apps/web/src/hooks/useQuery.ts and apps/web/src/lib/sync.ts). We snapshot the
 * note value at the moment the editor opens; if `remoteNote` changes to something
 * other than that snapshot while the editor is still open and has unsaved edits,
 * it can only be a concurrent sync-applied remote write (a local save would have
 * updated the snapshot itself), so we surface a non-destructive banner rather than
 * silently overwriting or clobbering either side. This is the v1 mitigation for
 * whole-field LWW called out in the plan's Yjs section.
 */
export function NoteEditor({
  value,
  remoteNote,
  onSave,
  placeholder,
  className,
  minHeightClassName,
  autoFocus,
}: {
  /** Locally-held draft value (mirrors the parent's `note` state). */
  value: string;
  /** The live DB value of `note` for this item, recomputed on every dbRevision
   *  bump (local or remote). Used only for conflict detection. */
  remoteNote: string;
  onSave: (next: string) => void;
  placeholder?: string;
  className?: string;
  minHeightClassName?: string;
  autoFocus?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  // 'rendered' is the existing Tiptap WYSIWYG; 'source' is a plain textarea over the
  // raw Markdown string. Sticky for the life of this editor instance (not reset on
  // open/close) — switching modes mid-edit is the whole point of the toggle.
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  // Bumped to push new content into the already-mounted Tiptap editor (e.g. "Use
  // theirs"); TiptapEditor only reads its initial `content` at mount, so this
  // version-counter is how the live document gets replaced.
  const [externalVersion, setExternalVersion] = useState(0);
  const [externalValue, setExternalValue] = useState(value);

  const openedRemoteRef = useRef(value);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteChangedRef = useRef(remoteChanged);
  remoteChangedRef.current = remoteChanged;
  const readLatestDraftRef = useRef<(() => string) | null>(null);
  // Kept in sync every render so the mount-time-captured unmount cleanup (below)
  // can still flush a source-mode edit under its current mode/onSave, not whatever
  // they were when the effect first ran.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Re-seed the draft from the outside whenever no editor is open (inline or
  // modal) — mirrors the existing TaskDetail reseed guard (never stomp a live edit).
  useEffect(() => {
    if (!editing && !expanded) {
      setDraft(value);
      setDirty(false);
    }
  }, [value, editing, expanded]);

  // Conflict detection: while an editor is open, watch for the DB's note value moving
  // away from the snapshot taken at editor-open time. If there are unsaved local edits,
  // surface a non-destructive banner (there's something to lose). If there are NOT —
  // the user opened the field but hasn't typed yet — there's nothing of theirs to
  // protect, so just silently adopt the incoming value instead of blurring later and
  // clobbering it with the stale open-time snapshot.
  useEffect(() => {
    if (!editing && !expanded) return;
    if (remoteNote === openedRemoteRef.current) return;
    if (dirty) {
      setRemoteChanged(true);
    } else {
      openedRemoteRef.current = remoteNote;
      setDraft(remoteNote);
      setExternalValue(remoteNote);
      setExternalVersion((v) => v + 1);
    }
  }, [remoteNote, editing, expanded, dirty]);

  // Rendered -> source: Tiptap is about to unmount, so pull its live document out
  // first (readLatestDraftRef flushes it) and null the ref out — otherwise a
  // pending autosave/commit would keep re-invoking the now-stale Tiptap flush
  // closure instead of falling back to draftRef, replaying pre-switch content over
  // whatever the user types in the textarea.
  function switchToSource() {
    const latest = readLatestDraftRef.current?.() ?? draftRef.current;
    readLatestDraftRef.current = null;
    draftRef.current = latest;
    setDraft(latest);
    setMode('source');
  }

  // Source -> rendered: draft is already current (the textarea is fully
  // controlled), so TiptapEditor's fresh mount will seed from `initialValue={draft}`.
  function switchToRendered() {
    setMode('rendered');
  }

  function openEditor() {
    openedRemoteRef.current = value;
    setDraft(value);
    setDirty(false);
    setRemoteChanged(false);
    setEditing(true);
  }

  function scheduleAutosave() {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      if (remoteChangedRef.current) return;
      const next = readLatestDraftRef.current?.() ?? draftRef.current;
      draftRef.current = next;
      setDraft(next);
      onSave(next);
      // Snapshot the *normalized* value (what actually lands in remoteNote after the
      // save) so a whitespace-only draft doesn't trip a false conflict banner.
      openedRemoteRef.current = normalizeNote(next);
      setDirty(false);
    }, AUTOSAVE_MS);
  }

  function handleDirty() {
    setDirty(true);
    scheduleAutosave();
  }

  function commit(next: string = readLatestDraftRef.current?.() ?? draftRef.current, opts?: { force?: boolean }): boolean {
    if (remoteChangedRef.current && !opts?.force) return false;
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    draftRef.current = next;
    setDraft(next);
    onSave(next);
    openedRemoteRef.current = normalizeNote(next);
    setDirty(false);
    return true;
  }

  function handleBlur(next: string) {
    if (!commit(next)) return;
    setEditing(false);
  }

  function acceptRemote() {
    // Discard the local draft, take the server's value, stay in edit mode. Push it
    // into the live editor (bumping externalVersion) so the mounted ProseMirror doc
    // visibly shows the remote text — otherwise draft would update but the editor
    // would keep displaying the stale content and the next autosave would re-save it.
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    openedRemoteRef.current = remoteNote;
    setDraft(remoteNote);
    setExternalValue(remoteNote);
    setExternalVersion((v) => v + 1);
    setDirty(false);
    setRemoteChanged(false);
  }

  function keepMine() {
    // Overwrite the remote value with what's currently in the editor. Read the LIVE
    // document (via the default param's readLatestDraftRef), not draftRef — draftRef
    // is only refreshed at commit/autosave boundaries (see scheduleAutosave), so it
    // can be stale by up to AUTOSAVE_MS worth of keystrokes.
    commit(undefined, { force: true });
    setRemoteChanged(false);
  }

  function closeExpanded() {
    commit(undefined, { force: true });
    setExpanded(false);
  }

  useEffect(() => {
    return () => {
      // In rendered mode, any dirty content is flushed synchronously by
      // TiptapEditor's own unmount effect (it calls onBlur — commit/handleBlur —
      // with the live document right before destroying the editor instance, so
      // switching items or closing the panel mid-autosave-window never drops
      // keystrokes). Source mode has no such child component to do that, so flush
      // directly here instead of just cancelling the timer.
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current);
        if (modeRef.current === 'source' && !remoteChangedRef.current) {
          onSaveRef.current(draftRef.current);
        }
      }
      readLatestDraftRef.current = null;
    };
  }, []);

  // Escape closes the expand modal (committing first, via closeExpanded).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeExpanded();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Modal focus management: remember what had focus before opening so it can be
  // restored on close (standard dialog behaviour — closing shouldn't strand focus
  // on a removed/hidden element or silently reset it to the document body).
  const previouslyFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (expanded) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
    } else {
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    }
  }, [expanded]);

  const editorBody = (fullscreen: boolean) => (
    <div className="flex h-full flex-col">
      {remoteChanged && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <span className="flex-1">
            This note changed elsewhere while you were editing. Keep your version, or take the
            other one?
          </span>
          <button
            type="button"
            onClick={keepMine}
            onMouseDown={(e) => e.preventDefault()}
            className="rounded-md border border-warning/50 px-2 py-1 font-medium hover:bg-warning/20"
          >
            Keep mine
          </button>
          <button
            type="button"
            onClick={acceptRemote}
            onMouseDown={(e) => e.preventDefault()}
            className="rounded-md border border-warning/50 px-2 py-1 font-medium hover:bg-warning/20"
          >
            Use theirs
          </button>
        </div>
      )}
      <div className="mb-1 flex items-center gap-1 text-xs">
        <button
          type="button"
          data-testid="note-mode-rendered"
          onMouseDown={(e) => e.preventDefault()}
          onClick={switchToRendered}
          className={cn(
            'rounded-md px-2 py-0.5 font-medium',
            mode === 'rendered' ? 'bg-surface-2 text-text' : 'text-text-faint hover:text-text-muted',
          )}
        >
          Rendered
        </button>
        <button
          type="button"
          data-testid="note-mode-source"
          onMouseDown={(e) => e.preventDefault()}
          onClick={switchToSource}
          className={cn(
            'rounded-md px-2 py-0.5 font-medium',
            mode === 'source' ? 'bg-surface-2 text-text' : 'text-text-faint hover:text-text-muted',
          )}
        >
          Source
        </button>
      </div>
      {mode === 'source' ? (
        <textarea
          data-testid="note-source-textarea"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            handleDirty();
          }}
          onBlur={(e) => (fullscreen ? commit : handleBlur)(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus ?? true}
          className={cn(
            'w-full flex-1 resize-none bg-transparent p-0 font-mono text-sm text-text outline-none placeholder:text-text-faint',
            !fullscreen && minHeightClassName,
          )}
        />
      ) : (
        <Suspense
          fallback={
            <div className={cn('animate-pulse text-xs text-text-faint', minHeightClassName)}>
              Loading editor…
            </div>
          }
        >
          <TiptapEditor
            initialValue={draft}
            externalValue={externalValue}
            externalVersion={externalVersion}
            onDirty={handleDirty}
            onBlur={fullscreen ? commit : handleBlur}
            onReady={(readLatestDraft) => {
              readLatestDraftRef.current = readLatestDraft;
            }}
            autoFocus={autoFocus ?? true}
            placeholder={placeholder}
            className={cn('flex-1 overflow-y-auto', !fullscreen && minHeightClassName)}
          />
        </Suspense>
      )}
    </div>
  );

  return (
    <>
      <div className="group/note relative">
        {editing && !expanded ? (
          // Suppress the inline editor while the expand modal is open — otherwise two
          // live Tiptap instances mount and their autosaves race on the same field.
          <div className={cn('rounded-lg border border-border px-3 py-2', className)}>
            {editorBody(false)}
          </div>
        ) : (
          <div
            onClick={expanded ? undefined : openEditor}
            onKeyDown={
              expanded
                ? undefined
                : (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openEditor();
                    }
                  }
            }
            role={expanded ? undefined : 'button'}
            tabIndex={expanded ? undefined : 0}
            title={expanded ? undefined : 'Click to edit'}
            aria-label={expanded ? undefined : 'Notes, click or press Enter to edit'}
            className={cn(
              'rounded-lg border border-transparent px-3 py-2',
              !expanded && 'cursor-text hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              className,
            )}
          >
            {(expanded ? draft : value).trim() ? (
              <Markdown>{expanded ? draft : value}</Markdown>
            ) : (
              <span className="text-sm text-text-faint">{placeholder ?? 'Add notes…'}</span>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            // Persist any unsaved inline edits before opening the modal — never
            // reseed to the last-saved DB value, which would drop keystrokes the
            // 1.5s autosave hasn't flushed yet (data safety must not depend on
            // blur-before-click event ordering). Read the LIVE document (default
            // param), not the possibly-stale draftRef. The modal continues from `draft`.
            commit();
            setExpanded(true);
          }}
          aria-label="Expand note editor"
          title="Expand"
          className="absolute right-1.5 top-1.5 rounded-md p-1 text-text-faint opacity-0 hover:bg-surface-2 hover:text-text group-hover/note:opacity-100"
        >
          <Maximize2 size={13} />
        </button>
      </div>

      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeExpanded}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="note-editor-modal-title"
            className="flex h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-border bg-bg p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span id="note-editor-modal-title" className="text-sm font-medium text-text-muted">
                Notes
              </span>
              <button
                type="button"
                onClick={closeExpanded}
                aria-label="Close"
                className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-text"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1">{editorBody(true)}</div>
          </div>
        </div>
      )}
    </>
  );
}
