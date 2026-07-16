import { useRef } from 'react';
import type { SessionBlock, UntrackedGap } from '@carbon/core';
import { segmentBounds, updateSegment, MIN_SEGMENT_MS } from '@carbon/core';
import { mutate } from '@/lib/mutate';
import { formatDuration } from '@/lib/date';
import { cn } from '@/lib/cn';

/** Stable, evenly-spread hue per task id so segments are visually distinguishable. */
export function taskColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 50%)`;
}

export const HATCH =
  'repeating-linear-gradient(45deg, rgba(0,0,0,0.28) 0 3px, transparent 3px 6px)';

const SNAP_MS = 60_000; // segment drags snap to 1 minute

export interface SegPreview {
  id: string;
  s: number;
  e: number;
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * The tall, touch-friendly edit mode of a block's bar. Tapping a segment (or an
 * untracked gap) selects it; the selected segment grows start/end drag handles
 * that snap to whole minutes and clamp between its covered neighbors. Drags
 * report a live preview upward so the numeric fields in the panel below track
 * the handles in real time, then commit through updateSegment on release.
 */
export function BlockBarEditor({
  block,
  gaps,
  selectedSegId,
  onSelectSeg,
  selectedGap,
  onSelectGap,
  preview,
  onPreview,
}: {
  block: SessionBlock;
  gaps: UntrackedGap[];
  selectedSegId: string | null;
  onSelectSeg: (id: string | null) => void;
  /** Selected gap, identified by its start ISO. */
  selectedGap: string | null;
  onSelectGap: (startIso: string | null) => void;
  preview: SegPreview | null;
  onPreview: (p: SegPreview | null) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    segId: string;
    edge: 'start' | 'end';
    startX: number;
    origS: number;
    origE: number;
    width: number;
    minMs: number;
    maxMs: number;
    moved: boolean;
  } | null>(null);
  // The click that follows a handle drag must not toggle segment/gap selection.
  const suppressClickRef = useRef(false);

  const start = new Date(block.session.start_time).getTime();
  const endMs = start + Math.max(1, block.wallMs); // matches the computed wall span
  const span = endMs - start;
  const pct = (t: number) => ((t - start) / span) * 100;
  const snap = (v: number) => Math.round(v / SNAP_MS) * SNAP_MS;

  const segs = block.segments.map((seg) => ({
    seg,
    live: !seg.log.end_time,
    s: preview?.id === seg.log.id ? preview.s : new Date(seg.log.start_time).getTime(),
    e:
      preview?.id === seg.log.id
        ? preview.e
        : seg.log.end_time
          ? new Date(seg.log.end_time).getTime()
          : endMs,
  }));

  function onDown(e: React.PointerEvent, segId: string, edge: 'start' | 'end') {
    e.stopPropagation();
    const track = trackRef.current;
    const cur = segs.find((x) => x.seg.log.id === segId);
    if (!track || !cur || cur.live) return;
    track.setPointerCapture(e.pointerId);
    const bounds = segmentBounds(block, segId);
    dragRef.current = {
      segId,
      edge,
      startX: e.clientX,
      origS: cur.s,
      origE: cur.e,
      width: track.clientWidth || 1,
      minMs: bounds.minStartMs,
      maxMs: bounds.maxEndMs,
      moved: false,
    };
  }
  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 3) d.moved = true;
    if (!d.moved) return;
    const dms = (dx / d.width) * span;
    let s = d.origS;
    let en = d.origE;
    if (d.edge === 'start') {
      s = Math.min(Math.max(snap(d.origS + dms), d.minMs), d.origE - MIN_SEGMENT_MS);
    } else {
      en = Math.max(Math.min(snap(d.origE + dms), d.maxMs), d.origS + MIN_SEGMENT_MS);
    }
    onPreview({ id: d.segId, s, e: en });
  }
  function onUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    trackRef.current?.releasePointerCapture(e.pointerId);
    if (d.moved) suppressClickRef.current = true;
    if (d.moved && preview && preview.id === d.segId) {
      const { s, e: en } = preview;
      mutate((db, dev) =>
        updateSegment(db, dev, d.segId, new Date(s).toISOString(), new Date(en).toISOString()),
      );
    }
    onPreview(null);
  }

  return (
    <div className="mt-2">
      <div
        ref={trackRef}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="relative h-16 touch-none select-none overflow-visible rounded-lg border border-border bg-surface-2"
      >
        {/* Untracked gaps: bare track, tappable. */}
        {gaps.map((g) => {
          const gs = new Date(g.start).getTime();
          const ge = new Date(g.end).getTime();
          return (
            <button
              key={g.start}
              type="button"
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onSelectGap(selectedGap === g.start ? null : g.start);
              }}
              title={`Untracked · ${formatDuration(g.ms)}`}
              style={{ left: `${pct(gs)}%`, width: `${Math.max(0.5, pct(ge) - pct(gs))}%` }}
              className={cn(
                'absolute inset-y-0',
                selectedGap === g.start && 'rounded ring-2 ring-inset ring-accent',
              )}
            />
          );
        })}
        {segs.map(({ seg, live, s, e }) => {
          const sel = seg.log.id === selectedSegId;
          return (
            <div
              key={seg.log.id}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                if (!live) onSelectSeg(sel ? null : seg.log.id);
              }}
              title={`${seg.item?.title || 'Task'} · ${formatDuration(e - s)}`}
              style={{
                left: `${pct(s)}%`,
                width: `${Math.max(0.5, pct(e) - pct(s))}%`,
                backgroundColor: taskColor(seg.log.item_id),
              }}
              className={cn(
                'absolute inset-y-1 rounded',
                live ? 'animate-pulse' : 'cursor-pointer',
                sel && 'z-10 ring-2 ring-accent',
              )}
            >
              {sel && !live && (
                <>
                  {/* Wide transparent hit areas around slim visual handles (touch-friendly). */}
                  <span
                    onPointerDown={(ev) => onDown(ev, seg.log.id, 'start')}
                    className="absolute -left-3 inset-y-0 z-20 flex w-6 cursor-ew-resize items-center justify-center"
                  >
                    <span className="h-full w-1 rounded bg-accent" />
                  </span>
                  <span
                    onPointerDown={(ev) => onDown(ev, seg.log.id, 'end')}
                    className="absolute -right-3 inset-y-0 z-20 flex w-6 cursor-ew-resize items-center justify-center"
                  >
                    <span className="h-full w-1 rounded bg-accent" />
                  </span>
                </>
              )}
            </div>
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
              className="pointer-events-none absolute inset-y-0 bg-surface"
            />
          );
        })}
        {block.completions.map((c) => (
          <span
            key={c.log.id}
            title={`${c.item?.title || 'Task'} completed`}
            style={{ left: `${pct(new Date(c.log.start_time).getTime())}%` }}
            className="pointer-events-none absolute inset-y-0 -ml-px w-0.5 bg-success"
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-text-faint">
        <span>{fmtTime(start)}</span>
        <span>
          {preview
            ? `${fmtTime(preview.s)}–${fmtTime(preview.e)}`
            : 'tap a segment to edit · drag handles to re-time'}
        </span>
        <span>{fmtTime(endMs)}</span>
      </div>
    </div>
  );
}
