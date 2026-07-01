import { useMemo, useRef, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import {
  listSessions,
  getSessionBlock,
  getProjects,
  getItemTags,
  listTags,
  saveTimeLog,
  deleteTimeLog,
  toCsv,
  type TimeLog,
  type SessionBlock,
} from '@carbon/core';
import { getDb } from '@/lib/db';
import { TagMark } from '@/components/TagMark';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { getCurrentUserId } from '@/lib/store';
import { formatDuration, formatDay, toDateTimeInput, fromDateTimeInput } from '@/lib/date';
import { cn } from '@/lib/cn';

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Stable, evenly-spread hue per task id so segments are visually distinguishable. */
function taskColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 50%)`;
}

const HATCH =
  'repeating-linear-gradient(45deg, rgba(0,0,0,0.28) 0 3px, transparent 3px 6px)';

interface Group {
  key: string;
  label: string;
  ms: number;
  blocks: SessionBlock[];
}

/** Bucket session blocks by project or by day, with subtotals. */
function groupBlocks(blocks: SessionBlock[], by: 'project' | 'day'): Group[] {
  const map = new Map<string, Group>();
  for (const b of blocks) {
    const key =
      by === 'project' ? b.session.item_id : new Date(b.session.start_time).toISOString().slice(0, 10);
    const label = by === 'project' ? b.project?.title || 'Untitled' : formatDay(key);
    const g = map.get(key) ?? { key, label, ms: 0, blocks: [] };
    g.ms += b.trackedMs;
    g.blocks.push(b);
    map.set(key, g);
  }
  const arr = [...map.values()];
  arr.sort((a, b) => (by === 'day' ? a.key.localeCompare(b.key) : b.ms - a.ms));
  return arr;
}

export function TimeTrackedView() {
  const uid = getCurrentUserId();
  const today = startOfDay(new Date());
  const [fromStr, setFromStr] = useState(today.toISOString().slice(0, 10));
  const [toStr, setToStr] = useState(new Date().toISOString().slice(0, 10));
  const [projectFilter, setProjectFilter] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'list' | 'timeline' | 'chart'>('list');
  const [groupBy, setGroupBy] = useState<'none' | 'project' | 'day'>('none');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Guard against an empty/invalid date input (don't let new Date(...).toISOString() throw).
  const safeRange = (value: string, time: string, fallback: Date) => {
    const d = new Date(`${value}T${time}`);
    return (Number.isNaN(d.getTime()) ? fallback : d).toISOString();
  };
  const fromIso = safeRange(fromStr, '00:00:00', startOfDay(new Date()));
  const toIso = safeRange(toStr, '23:59:59', new Date());

  const data = useQuery(
    (db) => {
      const tagSet = tagIds.length ? new Set(tagIds) : null;
      const blockTags = (b: SessionBlock) => {
        const ids = new Set<string>();
        for (const t of getItemTags(db, b.session.item_id)) ids.add(t.id);
        for (const seg of b.segments) for (const t of getItemTags(db, seg.log.item_id)) ids.add(t.id);
        return ids;
      };
      const blocks = listSessions(db, fromIso, toIso, uid)
        .map((s) => getSessionBlock(db, s))
        .filter((b) => b.trackedMs > 0)
        .filter((b) => !projectFilter || b.session.item_id === projectFilter)
        .filter((b) => !tagSet || [...blockTags(b)].some((id) => tagSet.has(id)));
      return { blocks, projects: getProjects(db), allTags: listTags(db) };
    },
    [fromIso, toIso, projectFilter, JSON.stringify(tagIds), uid],
  );

  const total = useMemo(
    () => (data?.blocks ?? []).reduce((s, b) => s + b.trackedMs, 0),
    [data?.blocks],
  );

  // Subtotalled groups for list mode (per-project, ms desc; per-day, date asc).
  const groups = useMemo(
    () => (groupBy === 'none' ? null : groupBlocks(data?.blocks ?? [], groupBy)),
    [data?.blocks, groupBy],
  );
  // Chart always groups (defaults to project when no grouping is chosen).
  const chartDim: 'project' | 'day' = groupBy === 'day' ? 'day' : 'project';
  const chartData = useMemo(
    () => groupBlocks(data?.blocks ?? [], chartDim),
    [data?.blocks, chartDim],
  );

  if (!data) return null;
  const { blocks, projects, allTags } = data;

  function setTimes(log: TimeLog, patch: Partial<Pick<TimeLog, 'start_time' | 'end_time'>>) {
    mutate((db, dev) => saveTimeLog(db, dev, { ...log, ...patch }));
  }
  function remove(b: SessionBlock) {
    mutate((db, dev) => {
      deleteTimeLog(db, dev, b.session.id);
      for (const seg of b.segments) deleteTimeLog(db, dev, seg.log.id);
      for (const p of b.pauses) deleteTimeLog(db, dev, p.id);
    });
  }
  const toggleTag = (id: string) =>
    setTagIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  function addBlock(projectId: string, start: string, end: string) {
    mutate((db, dev) => {
      const now = new Date().toISOString();
      saveTimeLog(db, dev, {
        id: crypto.randomUUID(),
        item_id: projectId,
        user_id: uid,
        start_time: start,
        end_time: end,
        note: null,
        created_at: now,
        kind: 'session',
        session_id: null,
        deleted: false,
      });
    });
    setAdding(false);
  }

  function exportCsv() {
    const csv = toCsv(getDb(), blocks);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `carbon-time-${fromStr}_${toStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Time tracked</h1>
        <span className="text-sm tabular-nums text-text-muted">
          Total: <span className="font-semibold text-text">{formatDuration(total)}</span>
        </span>
      </div>

      {/* Report controls */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <input type="date" value={fromStr} onChange={(e) => setFromStr(e.target.value)} className={inputCls} />
        <span className="text-text-faint">to</span>
        <input type="date" value={toStr} onChange={(e) => setToStr(e.target.value)} className={inputCls} />
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className={inputCls}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || 'Untitled'}
            </option>
          ))}
        </select>
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
          className={inputCls}
          title="Group the list with subtotals"
        >
          <option value="none">No grouping</option>
          <option value="project">By project</option>
          <option value="day">By day</option>
        </select>
        <div className="flex-1" />
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(['list', 'timeline', 'chart'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn('px-2.5 py-1 capitalize', mode === m ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2')}
            >
              {m}
            </button>
          ))}
        </div>
        <button onClick={() => setAdding((a) => !a)} className={btnCls}>
          <Plus size={13} /> Add block
        </button>
        <button onClick={exportCsv} disabled={blocks.length === 0} className={cn(btnCls, 'disabled:opacity-50')}>
          <Download size={13} /> CSV
        </button>
      </div>

      {allTags.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-text-faint">Tags:</span>
          {allTags.map((t) => (
            <button
              key={t.id}
              onClick={() => toggleTag(t.id)}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5',
                tagIds.includes(t.id)
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border text-text-muted hover:bg-surface-2',
              )}
            >
              <TagMark color={t.color} /> {t.name}
            </button>
          ))}
        </div>
      )}

      {adding && <AddBlock projects={projects} onAdd={addBlock} onCancel={() => setAdding(false)} />}

      {blocks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
          No time tracked in this range.
        </div>
      ) : mode === 'chart' ? (
        <Chart data={chartData} dimension={chartDim} total={total} />
      ) : mode === 'timeline' ? (
        <>
          <Timeline
            blocks={blocks}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onSetTimes={setTimes}
          />
          {selectedId &&
            blocks
              .filter((b) => b.session.id === selectedId)
              .map((b) => (
                <div key={b.session.id} className="mt-3">
                  <Block block={b} onSetTimes={setTimes} onRemove={() => remove(b)} defaultOpen />
                </div>
              ))}
        </>
      ) : groups ? (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="mb-1.5 flex items-baseline justify-between border-b border-border pb-1">
                <span className="text-sm font-semibold">{g.label}</span>
                <span className="text-xs tabular-nums text-text-muted">
                  {formatDuration(g.ms)}
                </span>
              </div>
              <div className="space-y-2">
                {g.blocks.map((b) => (
                  <Block
                    key={b.session.id}
                    block={b}
                    onSetTimes={setTimes}
                    onRemove={() => remove(b)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {blocks.map((b) => (
            <Block key={b.session.id} block={b} onSetTimes={setTimes} onRemove={() => remove(b)} />
          ))}
        </div>
      )}
    </div>
  );
}

const inputCls = 'rounded-lg border border-border bg-surface px-2 py-1 outline-none focus:border-accent';
const btnCls = 'flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 hover:bg-surface-2';

/**
 * A compact horizontal bar showing how a block's wall-clock span was split: task
 * segments (coloured), pauses (hatched), untracked project time (the bare track),
 * and completion markers (ticks). Positions are relative to the block's own span.
 */
function BlockBar({ block }: { block: SessionBlock }) {
  const start = new Date(block.session.start_time).getTime();
  const endMs = start + Math.max(1, block.wallMs); // matches the computed wall span
  const span = endMs - start;
  const pct = (t: number) => ((t - start) / span) * 100;
  return (
    <div
      className="relative mt-2 h-3 w-full overflow-hidden rounded bg-surface-2"
      title={`Wall ${formatDuration(block.wallMs)} · tracked ${formatDuration(block.trackedMs)}`}
    >
      {block.segments.map((seg) => {
        const ss = new Date(seg.log.start_time).getTime();
        const se = seg.log.end_time ? new Date(seg.log.end_time).getTime() : endMs;
        return (
          <span
            key={seg.log.id}
            title={`${seg.item?.title || 'Task'} · ${formatDuration(seg.ms)}`}
            style={{ left: `${pct(ss)}%`, width: `${Math.max(0.5, pct(se) - pct(ss))}%`, backgroundColor: taskColor(seg.log.item_id) }}
            className="absolute inset-y-0"
          />
        );
      })}
      {block.pauses.map((p) => {
        const ps = new Date(p.start_time).getTime();
        const pe = p.end_time ? new Date(p.end_time).getTime() : endMs;
        return (
          <span
            key={p.id}
            title={p.note === 'suspend' ? 'Suspended' : 'Paused'}
            style={{ left: `${pct(ps)}%`, width: `${Math.max(0.8, pct(pe) - pct(ps))}%`, backgroundImage: HATCH }}
            className="absolute inset-y-0 bg-surface"
          />
        );
      })}
      {block.completions.map((c) => (
        <span
          key={c.log.id}
          title={`${c.item?.title || 'Task'} completed`}
          style={{ left: `${pct(new Date(c.log.start_time).getTime())}%` }}
          className="absolute inset-y-0 -ml-px w-0.5 bg-success"
        />
      ))}
    </div>
  );
}

function Block({
  block,
  onSetTimes,
  onRemove,
  defaultOpen = false,
}: {
  block: SessionBlock;
  onSetTimes: (log: TimeLog, patch: Partial<Pick<TimeLog, 'start_time' | 'end_time'>>) => void;
  onRemove: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const s = block.session;
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-medium">{block.project?.title || 'Untitled'}</div>
          <div className="text-xs text-text-muted">
            {fmtDay(s.start_time)} · {fmtTime(s.start_time)}–{s.end_time ? fmtTime(s.end_time) : 'now'}
            {block.pauses.length > 0 && ` · ${block.pauses.length} pause(s)`}
          </div>
        </button>
        <span className="shrink-0 tabular-nums text-sm font-semibold text-accent">
          {formatDuration(block.trackedMs)}
        </span>
      </div>

      <BlockBar block={block} />

      {open && (
        <div className="mt-2 space-y-2 border-t border-border pt-2 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-text-muted">
            <span>Wall clock <span className="font-medium text-text">{formatDuration(block.wallMs)}</span></span>
            <span>Tracked <span className="font-medium text-text">{formatDuration(block.trackedMs)}</span></span>
            {block.untrackedMs > 0 && (
              <span>Untracked <span className="font-medium text-text">{formatDuration(block.untrackedMs)}</span></span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-text-muted">
              Start
              <input
                type="datetime-local"
                className={inputCls}
                value={toDateTimeInput(s.start_time)}
                onChange={(e) =>
                  onSetTimes(s, { start_time: fromDateTimeInput(e.target.value) ?? s.start_time })
                }
              />
            </label>
            <label className="flex items-center gap-1 text-text-muted">
              End
              <input
                type="datetime-local"
                className={inputCls}
                value={toDateTimeInput(s.end_time)}
                onChange={(e) => onSetTimes(s, { end_time: fromDateTimeInput(e.target.value) })}
              />
            </label>
            <button onClick={onRemove} className="ml-auto text-danger hover:underline">
              Remove
            </button>
          </div>
          {block.segments.length > 0 && (
            <ul className="space-y-0.5">
              {block.segments.map((seg) => (
                <li key={seg.log.id} className="flex items-center gap-2 text-text-muted">
                  <span
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: taskColor(seg.log.item_id) }}
                  />
                  <span className="truncate">{seg.item?.title || 'Task'}</span>
                  <span className="ml-auto tabular-nums">{formatDuration(seg.ms)}</span>
                </li>
              ))}
              {block.untrackedMs > 0 && (
                <li className="flex items-center gap-2 text-text-faint">
                  <span className="size-2 shrink-0 rounded-sm bg-surface-2" />
                  <span className="truncate">Untracked project time</span>
                  <span className="ml-auto tabular-nums">{formatDuration(block.untrackedMs)}</span>
                </li>
              )}
            </ul>
          )}
          {block.completions.length > 0 && (
            <ul className="space-y-0.5">
              {block.completions.map((c) => (
                <li key={c.log.id} className="flex items-center gap-2 text-success">
                  <span className="truncate">✓ {c.item?.title || 'Task'} completed</span>
                  <span className="ml-auto tabular-nums">{fmtTime(c.log.start_time)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Timeline({
  blocks,
  selectedId,
  onSelect,
  onSetTimes,
}: {
  blocks: SessionBlock[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSetTimes: (log: TimeLog, patch: Partial<Pick<TimeLog, 'start_time' | 'end_time'>>) => void;
}) {
  const byDay = new Map<string, SessionBlock[]>();
  for (const b of blocks) {
    const k = new Date(b.session.start_time).toDateString();
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(b);
  }
  return (
    <div className="space-y-4">
      {[...byDay.values()].map((dayBlocks) => (
        <DayTimeline
          key={dayBlocks[0]!.session.id}
          dayBlocks={dayBlocks}
          selectedId={selectedId}
          onSelect={onSelect}
          onSetTimes={onSetTimes}
        />
      ))}
    </div>
  );
}

const SNAP_MS = 5 * 60_000; // drag snaps to 5 minutes

function DayTimeline({
  dayBlocks,
  selectedId,
  onSelect,
  onSetTimes,
}: {
  dayBlocks: SessionBlock[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSetTimes: (log: TimeLog, patch: Partial<Pick<TimeLog, 'start_time' | 'end_time'>>) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    edge: 'move' | 'start' | 'end';
    startX: number;
    origS: number;
    origE: number;
    width: number;
    moved: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<{ id: string; s: number; e: number } | null>(null);

  // Window is fixed from the real block times (+ padding) so it doesn't shift while
  // dragging — otherwise a lone block, auto-fit to the window, could never move.
  const baseSpans = dayBlocks.map((b) => ({
    s: new Date(b.session.start_time).getTime(),
    e: b.session.end_time ? new Date(b.session.end_time).getTime() : Date.now(),
  }));
  const rawStart = Math.min(...baseSpans.map((x) => x.s));
  const rawEnd = Math.max(...baseSpans.map((x) => x.e));
  const pad = Math.max(30 * 60_000, (rawEnd - rawStart) * 0.15);
  const winStart = rawStart - pad;
  const winEnd = rawEnd + pad;
  const span = Math.max(60_000, winEnd - winStart);
  const snap = (ms: number) => Math.round(ms / SNAP_MS) * SNAP_MS;

  const spans = dayBlocks.map((b, i) =>
    preview && preview.id === b.session.id ? { s: preview.s, e: preview.e } : baseSpans[i]!,
  );

  function onDown(e: React.PointerEvent, b: SessionBlock, i: number, edge: 'move' | 'start' | 'end') {
    e.stopPropagation();
    const track = trackRef.current;
    if (!track) return;
    track.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: b.session.id,
      edge,
      startX: e.clientX,
      origS: spans[i]!.s,
      origE: spans[i]!.e,
      width: track.clientWidth || 1,
      moved: false,
    };
  }
  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 3) d.moved = true;
    const dms = (dx / d.width) * span;
    let s = d.origS;
    let en = d.origE;
    if (d.edge === 'move') {
      s = snap(d.origS + dms);
      en = s + (d.origE - d.origS);
    } else if (d.edge === 'start') {
      s = Math.min(snap(d.origS + dms), d.origE - SNAP_MS);
    } else {
      en = Math.max(snap(d.origE + dms), d.origS + SNAP_MS);
    }
    setPreview({ id: d.id, s, e: en });
  }
  function onUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    trackRef.current?.releasePointerCapture(e.pointerId);
    const p = preview;
    setPreview(null);
    if (!d.moved) {
      onSelect(d.id === selectedId ? null : d.id); // a click, not a drag
      return;
    }
    if (p && p.id === d.id) {
      const b = dayBlocks.find((x) => x.session.id === d.id);
      if (b) {
        onSetTimes(b.session, {
          start_time: new Date(p.s).toISOString(),
          end_time: new Date(p.e).toISOString(),
        });
      }
    }
  }

  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-text-muted">
        {fmtDay(dayBlocks[0]!.session.start_time)}
      </div>
      <div
        ref={trackRef}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="relative h-9 touch-none rounded-lg border border-border bg-surface"
      >
        {dayBlocks.map((b, i) => {
          const left = ((spans[i]!.s - winStart) / span) * 100;
          const width = Math.max(2, ((spans[i]!.e - spans[i]!.s) / span) * 100);
          const sel = b.session.id === selectedId;
          return (
            <div
              key={b.session.id}
              onPointerDown={(e) => onDown(e, b, i, 'move')}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${b.project?.title || 'Untitled'} · ${formatDuration(b.trackedMs)}`}
              className={cn(
                'absolute bottom-1 top-1 cursor-grab select-none overflow-hidden rounded px-1 text-left text-[10px] text-white active:cursor-grabbing',
                sel ? 'bg-accent-hover ring-2 ring-accent' : 'bg-accent hover:bg-accent-hover',
              )}
            >
              {/* Pause gaps, hatched, positioned within this block's own span. */}
              {b.pauses.map((p) => {
                const blkSpan = Math.max(1, spans[i]!.e - spans[i]!.s);
                const ps = new Date(p.start_time).getTime();
                const pe = p.end_time ? new Date(p.end_time).getTime() : spans[i]!.e;
                const pl = ((ps - spans[i]!.s) / blkSpan) * 100;
                const pw = Math.max(1.5, ((pe - ps) / blkSpan) * 100);
                return (
                  <span
                    key={p.id}
                    title={p.note === 'suspend' ? 'Suspended' : 'Paused'}
                    style={{
                      left: `${pl}%`,
                      width: `${pw}%`,
                      backgroundImage:
                        'repeating-linear-gradient(45deg, rgba(0,0,0,0.35) 0 3px, transparent 3px 6px)',
                    }}
                    className="pointer-events-none absolute inset-y-0 bg-surface/25"
                  />
                );
              })}
              {/* resize handles */}
              <span
                onPointerDown={(e) => onDown(e, b, i, 'start')}
                className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-ew-resize bg-black/20"
              />
              <span
                onPointerDown={(e) => onDown(e, b, i, 'end')}
                className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize bg-black/20"
              />
              <span className="relative z-10 truncate">{b.project?.title || 'Untitled'}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-text-faint">
        <span>{fmtTime(new Date(winStart).toISOString())}</span>
        <span>{fmtTime(new Date(winEnd).toISOString())}</span>
      </div>
    </div>
  );
}

function Chart({
  data,
  dimension,
  total,
}: {
  data: Group[];
  dimension: 'project' | 'day';
  total: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.ms));
  return (
    <div>
      <div className="mb-2 text-xs text-text-faint">
        Time by {dimension === 'project' ? 'project' : 'day'}
      </div>
      <div className="space-y-1.5">
        {data.map((d) => (
          <div key={d.key} className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 truncate text-right text-text-muted" title={d.label}>
              {d.label}
            </span>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-surface-2">
              <div
                className="absolute inset-y-0 left-0 rounded bg-accent"
                style={{ width: `${(d.ms / max) * 100}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-right tabular-nums text-text">
              {formatDuration(d.ms)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-2 text-xs">
        <span className="text-text-muted">Total</span>
        <span className="w-16 text-right font-semibold tabular-nums">{formatDuration(total)}</span>
      </div>
    </div>
  );
}

function AddBlock({
  projects,
  onAdd,
  onCancel,
}: {
  projects: { id: string; title: string }[];
  onAdd: (projectId: string, start: string, end: string) => void;
  onCancel: () => void;
}) {
  const [project, setProject] = useState(projects[0]?.id ?? '');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const s = fromDateTimeInput(start);
        const en = fromDateTimeInput(end);
        if (project && s && en) onAdd(project, s, en);
      }}
      className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface p-3 text-xs"
    >
      <select value={project} onChange={(e) => setProject(e.target.value)} className={inputCls}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title || 'Untitled'}
          </option>
        ))}
      </select>
      <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} required />
      <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} required />
      <button type="submit" className="rounded-lg bg-accent px-3 py-1 font-medium text-accent-fg hover:bg-accent-hover">
        Add
      </button>
      <button type="button" onClick={onCancel} className={btnCls}>
        Cancel
      </button>
    </form>
  );
}
