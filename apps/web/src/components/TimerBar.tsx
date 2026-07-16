import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Square, Timer, Pause, Play, ChevronRight, StickyNote, Satellite } from 'lucide-react';
import {
  getTimeContext,
  getItem,
  trackedMs,
  pauseNow,
  pauseBefore,
  resume,
  resumeSuspended,
  findMergeCandidate,
  mergeSessions,
  MERGE_QUICK_WINDOW_MS,
  addTimeNote,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useTicker } from '@/hooks/useTicker';
import { mutate } from '@/lib/mutate';
import { useStore } from '@/lib/store';
import { formatDuration } from '@/lib/date';
import { cn } from '@/lib/cn';
import { trackingStopActive, trackingResumeSuspended } from '@/lib/trackingLifecycle';
import { gpsTrackRecording, gpsTrackPointCount } from '@/lib/gpsTrack';

const DURATIONS = [5, 10, 15, 30];

// How long after starting a session the quick-merge offer stays visible.
const MERGE_CHIP_WINDOW_MS = 15 * 60_000;

export function TimerBar() {
  const select = useStore((s) => s.select);
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  const interrupt = useStore((s) => s.interrupt);
  const setInterrupt = useStore((s) => s.setInterrupt);
  const uid = currentUser?.id ?? null;
  const [menu, setMenu] = useState(false);
  const [custom, setCustom] = useState('');
  const [mergeDismissed, setMergeDismissed] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');

  const data = useQuery(
    (db) => {
      const ctx = getTimeContext(db, uid);
      if (!ctx.session) return null;
      const startMs = new Date(ctx.session.start_time).getTime();
      // Pause total up to query time = elapsed-span minus tracked; stable while running.
      const pausedMs = Date.now() - startMs - trackedMs(db, ctx.session, Date.now());
      const mergeCandidate = findMergeCandidate(db, ctx.session, MERGE_QUICK_WINDOW_MS);
      return {
        ctx,
        startMs,
        pausedMs,
        project: getItem(db, ctx.session.item_id),
        task: ctx.task ? getItem(db, ctx.task.item_id) : null,
        suspended: ctx.suspended.map((s) => ({ id: s.id, title: getItem(db, s.item_id)?.title || 'Project' })),
        merge: mergeCandidate ? { id: mergeCandidate.id, endMs: new Date(mergeCandidate.end_time!).getTime() } : null,
      };
    },
    [uid],
  );
  useTicker(1000, !!data);
  const gpsOn = gpsTrackRecording();
  const gpsPoints = gpsTrackPointCount();

  if (!data) return null;
  const { ctx, project, task, startMs, pausedMs, suspended, merge } = data;
  // Recomputed every render (ticker drives 1s updates), unlike the query result.
  const elapsed = Math.max(0, Date.now() - startMs - pausedMs);
  // The candidate is a query-time fact; visibility decays render-side via the ticker.
  const showMerge =
    merge != null &&
    mergeDismissed !== ctx.session!.id &&
    Date.now() - startMs < MERGE_CHIP_WINDOW_MS;

  function openRunning() {
    if (task) {
      if (task.parent_id) navigate(`/focus/${task.parent_id}`);
      select(task.id); // open the running task in the detail pane
    } else if (project) {
      navigate(`/project/${project.id}`);
    }
  }

  const act = (fn: (db: never, dev: string) => void) => {
    mutate(fn as never);
    setMenu(false);
    setCustom('');
  };

  function submitNote(e: React.FormEvent) {
    e.preventDefault();
    const title = noteTitle.trim();
    if (!title) return;
    mutate((db, dev) => {
      addTimeNote(db, dev, uid, { title });
    });
    setNoteTitle('');
    setNoteOpen(false);
  }

  return (
    <div className="border-b border-border bg-accent-soft">
      <div className="relative flex items-center gap-2 px-4 py-1.5 text-sm">
        <Timer size={15} className={cn('shrink-0', ctx.paused ? 'text-text-muted' : 'text-accent')} />

      <button
        className="flex min-w-0 flex-1 items-center gap-1 truncate text-left hover:underline"
        onClick={openRunning}
      >
        <span className="truncate font-medium text-accent">{project?.title || 'Project'}</span>
        {task && (
          <>
            <ChevronRight size={13} className="shrink-0 text-text-faint" />
            <span className="truncate text-text-muted">{task.title || 'Task'}</span>
          </>
        )}
        {!task && !ctx.paused && <span className="shrink-0 text-text-faint">· general</span>}
      </button>

      {ctx.paused ? (
        <span className="shrink-0 text-xs text-text-muted">
          Paused{ctx.pauseEndsAt ? ` · resumes ${new Date(ctx.pauseEndsAt).toLocaleTimeString()}` : ''}
        </span>
      ) : (
        <span className="shrink-0 tabular-nums text-accent">{formatDuration(elapsed)}</span>
      )}

      {gpsOn && (
        <span
          title={`GPS track recording${gpsPoints ? ` · ${gpsPoints} points` : ''}`}
          className="flex shrink-0 items-center gap-0.5 text-accent"
        >
          <Satellite size={12} />
          {gpsPoints > 0 && <span className="tabular-nums text-[10px]">{gpsPoints}</span>}
        </span>
      )}

      <button
        type="button"
        onClick={() => {
          setNoteOpen((o) => !o);
          setMenu(false);
        }}
        title="Add time note"
        className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs font-medium hover:bg-surface-2"
      >
        <StickyNote size={11} /> Note
      </button>

      {ctx.paused ? (
        <button
          onClick={() => act((db, dev) => resume(db, dev, uid))}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg hover:bg-accent-hover"
        >
          <Play size={11} fill="currentColor" /> Resume
        </button>
      ) : (
        <button
          onClick={() => setMenu((m) => !m)}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs font-medium hover:bg-surface-2"
        >
          <Pause size={11} /> Pause
        </button>
      )}

      <button
        onClick={() => void trackingStopActive()}
        className="flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg hover:bg-accent-hover"
      >
        <Square size={11} fill="currentColor" /> Stop
      </button>

      {noteOpen && (
        <form
          onSubmit={submitNote}
          className="absolute right-4 top-full z-50 mt-1 flex w-72 items-center gap-1 rounded-lg border border-border bg-surface p-2 text-xs shadow-lg"
        >
          <input
            autoFocus
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
            placeholder="Time note…"
            className="w-full rounded border border-border bg-surface px-2 py-1 outline-none"
          />
          <button
            type="submit"
            disabled={!noteTitle.trim()}
            className="shrink-0 rounded bg-accent px-2 py-1 font-medium text-accent-fg disabled:opacity-40"
          >
            Add
          </button>
        </form>
      )}

      {menu && !ctx.paused && (
        <div className="absolute right-4 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-surface p-2 text-xs shadow-lg">
          <PauseRow
            label="Pause now"
            infinite
            onPick={(m) => act((db, dev) => pauseNow(db, dev, uid, m))}
          />
          <PauseRow
            label="Pause last (retroactive)"
            onPick={(m) => act((db, dev) => pauseBefore(db, dev, uid, m ?? 0))}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const m = Number(custom);
              if (m > 0) act((db, dev) => pauseNow(db, dev, uid, m));
            }}
            className="mt-1 flex items-center gap-1"
          >
            <input
              type="number"
              min={1}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="custom min (now)"
              className="w-full rounded border border-border bg-surface px-2 py-1 outline-none"
            />
          </form>
        </div>
      )}
      </div>

      {/* Quick merge: this block started moments after the previous one ended */}
      {showMerge && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-1 text-xs">
          <span className="text-text-muted">
            Continue previous block? Ended {Math.max(1, Math.round((Date.now() - merge.endMs) / 60_000))}m ago
          </span>
          <button
            onClick={() => act((db, dev) => mergeSessions(db, dev, merge.id, ctx.session!.id))}
            className="rounded border border-border px-2 py-0.5 font-medium hover:bg-surface-2"
          >
            Merge
          </button>
          <button
            onClick={() => setMergeDismissed(ctx.session!.id)}
            className="font-medium text-text-muted hover:text-text"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Complete-elsewhere interrupt prompt */}
      {interrupt && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-1 text-xs">
          <span className="text-text-muted">Pause {interrupt.project} for the interruption?</span>
          {[5, 10, 15, 30].map((m) => (
            <button
              key={m}
              onClick={() => {
                mutate((db, dev) => pauseBefore(db, dev, uid, m));
                setInterrupt(null);
              }}
              className="rounded border border-border px-2 py-0.5 hover:bg-surface-2"
            >
              {m}m
            </button>
          ))}
          <button onClick={() => setInterrupt(null)} className="font-medium text-text-muted hover:text-text">
            No
          </button>
        </div>
      )}

      {/* Suspended (parked) sessions */}
      {suspended.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 px-4 py-1 text-xs">
          <span className="text-text-faint">Parked:</span>
          {suspended.map((s) => (
            <button
              key={s.id}
              onClick={() =>
                void trackingResumeSuspended((db, dev) => resumeSuspended(db, dev, uid, s.id))
              }
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-text-muted hover:bg-surface-2"
              title="Resume"
            >
              <Play size={9} fill="currentColor" /> {s.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PauseRow({
  label,
  infinite,
  onPick,
}: {
  label: string;
  infinite?: boolean;
  onPick: (minutes: number | null) => void;
}) {
  return (
    <div className="mb-1">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-faint">
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {DURATIONS.map((m) => (
          <button
            key={m}
            onClick={() => onPick(m)}
            className="rounded border border-border px-2 py-0.5 hover:bg-surface-2"
          >
            {m}m
          </button>
        ))}
        {infinite && (
          <button
            onClick={() => onPick(null)}
            title="Until I resume"
            className="rounded border border-border px-2 py-0.5 hover:bg-surface-2"
          >
            ∞
          </button>
        )}
      </div>
    </div>
  );
}
