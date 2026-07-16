import { v4 as uuidv4 } from 'uuid';
import type { Db, Row } from './db';
import type { Item, TimeLog, TimeLogKind } from './types';
import { getItem, getItemTags, rowToTimeLog, recordRecordOp, createItem, encodeMetadata, deleteItem } from './repo';
import { causalNowIso } from './crdt';

// Time tracking v2 — see docs/time-tracking-design.md.
// A *session* (kind 'session', item_id = project) contains *task segments*
// (kind 'task') and *pauses* (kind 'pause'). Switching to another project
// *suspends* the current session (a pause with note 'suspend'); re-entering a
// project resumes its suspended session. Break pauses have note null.
// A *completion* (kind 'complete') is a zero-duration marker recorded at the
// moment a task inside an open session is finished — a data point, not a span.
// A *time note* (kind 'note') is a zero-duration marker pointing at a note item
// created while tracking (child of the active task, or project root if no task).

const SUSPEND = 'suspend';
const iso = () => new Date().toISOString();
const ms = (s: string) => new Date(s).getTime();

interface TLRow extends Row {
  id: string;
  item_id: string;
  user_id: string | null;
  start_time: string;
  end_time: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  kind: string;
  session_id: string | null;
  deleted: number;
}

function userClause(userId: string | null): { c: string; p: string[] } {
  return userId == null ? { c: 'user_id IS NULL', p: [] } : { c: 'user_id = ?', p: [userId] };
}

/** Stamps a fresh causal-clock `updated_at` on every record before persisting it —
 *  the single chokepoint all TimeLog writes in this file pass through, so callers
 *  (and makeLog) don't need to think about the LWW timestamp themselves. */
function emit(db: Db, dev: string, log: TimeLog): TimeLog {
  const stamped: TimeLog = { ...log, updated_at: causalNowIso(db) };
  recordRecordOp(db, dev, 'timelog', stamped.id, stamped);
  return stamped;
}

function makeLog(p: {
  kind: TimeLogKind;
  itemId: string;
  userId: string | null;
  sessionId: string | null;
  start: string;
  end: string | null;
  note?: string | null;
}): TimeLog {
  return {
    id: uuidv4(),
    item_id: p.itemId,
    user_id: p.userId,
    start_time: p.start,
    end_time: p.end,
    note: p.note ?? null,
    created_at: p.start,
    updated_at: p.start, // placeholder — emit() always overwrites with the causal clock
    kind: p.kind,
    session_id: p.sessionId,
    deleted: false,
  };
}

function closeLog(db: Db, dev: string, log: TimeLog, at: string): void {
  emit(db, dev, { ...log, end_time: at });
}

/** Nearest project ancestor, else top-most ancestor, else the task itself. */
export function sessionAnchor(db: Db, taskId: string): string {
  let anchor = taskId;
  let pid = getItem(db, taskId)?.parent_id ?? null;
  while (pid) {
    const p = getItem(db, pid);
    if (!p) break;
    if (p.type === 'project') return p.id;
    anchor = p.id;
    pid = p.parent_id;
  }
  return anchor;
}

// ----- low-level row lookups (all filter deleted) ---------------------------

function openSessions(db: Db, userId: string | null): TimeLog[] {
  const uw = userClause(userId);
  return db
    .all<TLRow>(
      `SELECT * FROM time_logs WHERE kind = 'session' AND end_time IS NULL AND deleted = 0 AND ${uw.c}
       ORDER BY start_time DESC`,
      uw.p,
    )
    .map(rowToTimeLog);
}
function suspendPause(db: Db, sessionId: string): TimeLog | null {
  const r = db.get<TLRow>(
    `SELECT * FROM time_logs WHERE kind = 'pause' AND session_id = ? AND note = ? AND end_time IS NULL AND deleted = 0
     ORDER BY start_time DESC LIMIT 1`,
    [sessionId, SUSPEND],
  );
  return r ? rowToTimeLog(r) : null;
}
function breakPause(db: Db, sessionId: string): TimeLog | null {
  const now = iso();
  const r = db.get<TLRow>(
    `SELECT * FROM time_logs WHERE kind = 'pause' AND session_id = ? AND (note IS NULL OR note <> ?)
       AND deleted = 0 AND start_time <= ? AND (end_time IS NULL OR end_time > ?)
     ORDER BY start_time DESC LIMIT 1`,
    [sessionId, SUSPEND, now, now],
  );
  return r ? rowToTimeLog(r) : null;
}
function openTaskRow(db: Db, sessionId: string): TimeLog | null {
  const r = db.get<TLRow>(
    `SELECT * FROM time_logs WHERE kind = 'task' AND session_id = ? AND end_time IS NULL AND deleted = 0
     ORDER BY start_time DESC LIMIT 1`,
    [sessionId],
  );
  return r ? rowToTimeLog(r) : null;
}

export interface TimeContext {
  session: TimeLog | null;
  task: TimeLog | null;
  paused: boolean;
  pauseEndsAt: string | null;
  /** Other open sessions parked in the background. */
  suspended: TimeLog[];
}

export function getTimeContext(db: Db, userId: string | null): TimeContext {
  const open = openSessions(db, userId);
  const suspended = open.filter((s) => suspendPause(db, s.id));
  const suspendedIds = new Set(suspended.map((s) => s.id));
  const active = open.find((s) => !suspendedIds.has(s.id)) ?? null;
  if (!active) return { session: null, task: null, paused: false, pauseEndsAt: null, suspended };
  const bp = breakPause(db, active.id);
  const task = bp ? null : openTaskRow(db, active.id);
  return { session: active, task, paused: !!bp, pauseEndsAt: bp ? bp.end_time : null, suspended };
}

// ----- actions --------------------------------------------------------------

function suspend(db: Db, dev: string, session: TimeLog): void {
  const at = iso();
  const t = openTaskRow(db, session.id);
  if (t) closeLog(db, dev, t, at);
  const bp = breakPause(db, session.id);
  if (bp) closeLog(db, dev, bp, at); // collapse any break pause before suspending
  emit(db, dev, makeLog({ kind: 'pause', itemId: session.item_id, userId: session.user_id, sessionId: session.id, start: at, end: null, note: SUSPEND }));
}

/** Start / continue a project session with no active task (general project time). */
export function startSession(db: Db, dev: string, projectId: string, userId: string | null): TimeLog {
  const ctx = getTimeContext(db, userId);
  if (ctx.session && ctx.session.item_id === projectId) {
    if (ctx.paused) {
      const bp = breakPause(db, ctx.session.id);
      if (bp) closeLog(db, dev, bp, iso());
    }
    const t = openTaskRow(db, ctx.session.id);
    if (t) closeLog(db, dev, t, iso());
    return ctx.session;
  }
  if (ctx.session) suspend(db, dev, ctx.session); // park current (resumable)
  const resumable = ctx.suspended.find((s) => s.item_id === projectId);
  if (resumable) {
    const sp = suspendPause(db, resumable.id);
    if (sp) closeLog(db, dev, sp, iso()); // resume the parked session
    return resumable;
  }
  return emit(db, dev, makeLog({ kind: 'session', itemId: projectId, userId, sessionId: null, start: iso(), end: null }));
}

/** Resume a specific parked session (for the UI's suspended chips). */
export function resumeSuspended(db: Db, dev: string, userId: string | null, sessionId: string): void {
  const target = openSessions(db, userId).find((s) => s.id === sessionId);
  if (!target) return;
  startSession(db, dev, target.item_id, userId);
}

/** Start a task timer — opens/keeps the task's project session and a segment. */
export function startTask(db: Db, dev: string, taskId: string, userId: string | null): TimeLog {
  const session = startSession(db, dev, sessionAnchor(db, taskId), userId);
  const t = openTaskRow(db, session.id);
  if (t && t.item_id === taskId) return t; // already tracking this task
  if (t) closeLog(db, dev, t, iso());
  return emit(db, dev, makeLog({ kind: 'task', itemId: taskId, userId, sessionId: session.id, start: iso(), end: null }));
}

/** Stop the active session entirely (closes any open task and pause). */
export function stopActive(db: Db, dev: string, userId: string | null): void {
  const ctx = getTimeContext(db, userId);
  if (!ctx.session) return;
  const at = iso();
  const t = openTaskRow(db, ctx.session.id);
  if (t) closeLog(db, dev, t, at);
  const bp = breakPause(db, ctx.session.id);
  if (bp) closeLog(db, dev, bp, at);
  closeLog(db, dev, ctx.session, at);
}

/** Pause from now. `minutes` = auto-resume after N min; null = indefinite (manual). */
export function pauseNow(db: Db, dev: string, userId: string | null, minutes: number | null): void {
  const ctx = getTimeContext(db, userId);
  if (!ctx.session || ctx.paused) return;
  if (minutes != null && minutes <= 0) return; // a zero/negative pause is meaningless (M4)
  const at = iso();
  const t = openTaskRow(db, ctx.session.id);
  if (t) closeLog(db, dev, t, at);
  const end = minutes != null ? new Date(ms(at) + minutes * 60_000).toISOString() : null;
  emit(db, dev, makeLog({ kind: 'pause', itemId: ctx.session.item_id, userId, sessionId: ctx.session.id, start: at, end }));
}

/** Retroactively carve out the last `minutes` as a pause; tracking stays active now. */
export function pauseBefore(db: Db, dev: string, userId: string | null, minutes: number): void {
  const ctx = getTimeContext(db, userId);
  if (!ctx.session || ctx.paused) return;
  if (!(minutes > 0)) return; // guard zero/negative/NaN — would invert the pause span (M4)
  const now = iso();
  const start = new Date(Math.max(ms(ctx.session.start_time), ms(now) - minutes * 60_000)).toISOString();
  const t = openTaskRow(db, ctx.session.id);
  emit(db, dev, makeLog({ kind: 'pause', itemId: ctx.session.item_id, userId, sessionId: ctx.session.id, start, end: now }));
  if (t) {
    closeLog(db, dev, t, start); // split: ran until the gap began…
    emit(db, dev, makeLog({ kind: 'task', itemId: t.item_id, userId, sessionId: ctx.session.id, start: now, end: null })); // …resume now
  }
}

/** Resume from a break pause: end it now and reopen a segment for the prior task. */
export function resume(db: Db, dev: string, userId: string | null): void {
  const ctx = getTimeContext(db, userId);
  if (!ctx.session || !ctx.paused) return;
  const bp = breakPause(db, ctx.session.id);
  if (!bp) return;
  const now = iso();
  closeLog(db, dev, bp, now);
  const prior = db.get<TLRow>(
    `SELECT * FROM time_logs WHERE kind = 'task' AND session_id = ? AND end_time = ? AND deleted = 0
     ORDER BY start_time DESC LIMIT 1`,
    [ctx.session.id, bp.start_time],
  );
  if (prior) {
    emit(db, dev, makeLog({ kind: 'task', itemId: prior.item_id, userId, sessionId: ctx.session.id, start: now, end: null }));
  }
}

/** The open (active or suspended) session that anchors this task, if any. */
function anchoringSession(db: Db, taskId: string, userId: string | null): TimeLog | null {
  const anchor = sessionAnchor(db, taskId);
  return openSessions(db, userId).find((s) => s.item_id === anchor) ?? null;
}

/**
 * Record a task's completion as a data point. If the task is the actively-tracked
 * segment, stop that segment now (the block keeps running, untracked). Only records
 * when an open session anchors the task — completing a task outside any tracked
 * block is a no-op here.
 */
export function recordCompletion(db: Db, dev: string, taskId: string, userId: string | null): void {
  const session = anchoringSession(db, taskId, userId);
  if (!session) return;
  const at = iso();
  const open = openTaskRow(db, session.id);
  if (open && open.item_id === taskId) closeLog(db, dev, open, at); // stop the segment
  emit(db, dev, makeLog({ kind: 'complete', itemId: taskId, userId, sessionId: session.id, start: at, end: at }));
}

/** Undo the most recent completion marker for a task in its open session (on reopen). */
export function removeCompletion(db: Db, dev: string, taskId: string, userId: string | null): void {
  const session = anchoringSession(db, taskId, userId);
  if (!session) return;
  const r = db.get<TLRow>(
    `SELECT * FROM time_logs WHERE kind = 'complete' AND session_id = ? AND item_id = ? AND deleted = 0
     ORDER BY start_time DESC LIMIT 1`,
    [session.id, taskId],
  );
  if (r) emit(db, dev, { ...rowToTimeLog(r), deleted: true });
}

export interface AddTimeNoteInput {
  title: string;
  /** Optional note body (items.note column). */
  body?: string | null;
  /** Arbitrary JSON for the note item. */
  metadata?: string | Record<string, unknown> | null;
  /** Prefer this open session; otherwise the active session for `userId`. */
  sessionId?: string | null;
}

/**
 * Create a note under the currently tracked task (or the project root when only
 * a session is running) and pin a zero-duration `kind:'note'` marker into the
 * open session. Does not stop the running task segment. Returns null when there
 * is no open (non-suspended) session to attach to.
 */
export function addTimeNote(
  db: Db,
  dev: string,
  userId: string | null,
  input: AddTimeNoteInput,
): { note: Item; log: TimeLog } | null {
  const title = input.title.trim();
  if (!title) return null;
  const ctx = getTimeContext(db, userId);
  let session = ctx.session;
  if (input.sessionId) {
    const wanted = openSessions(db, userId).find((s) => s.id === input.sessionId);
    if (!wanted) return null;
    session = wanted;
  }
  if (!session) return null;
  // Parent: active task segment's item, else the session's project.
  const parentId = ctx.session?.id === session.id && ctx.task ? ctx.task.item_id : session.item_id;
  const note = createItem(db, dev, {
    type: 'note',
    title,
    note: input.body ?? null,
    parentId,
    ownerId: userId,
    metadata: encodeMetadata(input.metadata),
  });
  const at = iso();
  const log = emit(
    db,
    dev,
    makeLog({
      kind: 'note',
      itemId: note.id,
      userId,
      sessionId: session.id,
      start: at,
      end: at,
    }),
  );
  return { note, log };
}

export type RemoveTimeNoteMode = 'reference' | 'note';

/**
 * Remove a time-note marker from its block.
 * - `reference`: soft-delete only the time_log row (note item stays in the task list).
 * - `note`: soft-delete the note item as well (and the marker).
 * Returns false if the log id is not a live `kind:'note'` marker.
 */
export function removeTimeNote(
  db: Db,
  dev: string,
  logId: string,
  mode: RemoveTimeNoteMode = 'reference',
): boolean {
  const r = db.get<TLRow>(
    "SELECT * FROM time_logs WHERE id = ? AND kind = 'note' AND deleted = 0",
    [logId],
  );
  if (!r) return false;
  const log = rowToTimeLog(r);
  emit(db, dev, { ...log, deleted: true });
  if (mode === 'note') {
    const item = getItem(db, log.item_id);
    if (item && !item.deleted) deleteItem(db, dev, log.item_id);
  }
  return true;
}

// ----- read models ----------------------------------------------------------

function sessionRows(db: Db, sessionId: string, kind: TimeLogKind): TimeLog[] {
  return db
    .all<TLRow>(
      'SELECT * FROM time_logs WHERE kind = ? AND session_id = ? AND deleted = 0 ORDER BY start_time',
      [kind, sessionId],
    )
    .map(rowToTimeLog);
}

/** Pause-adjusted tracked milliseconds for a session, up to `upToMs` (default now). */
export function trackedMs(db: Db, session: TimeLog, upToMs: number = Date.now()): number {
  const start = ms(session.start_time);
  const end = session.end_time ? ms(session.end_time) : upToMs;
  let span = Math.max(0, end - start);
  for (const p of sessionRows(db, session.id, 'pause')) {
    const ps = Math.max(start, ms(p.start_time));
    const pe = Math.min(end, p.end_time ? ms(p.end_time) : end);
    if (pe > ps) span -= pe - ps;
  }
  return Math.max(0, span);
}

export interface SessionBlock {
  session: TimeLog;
  project: Item | undefined;
  segments: { log: TimeLog; item: Item | undefined; ms: number }[];
  pauses: TimeLog[];
  /** Zero-duration completion markers, with the task they finished. */
  completions: { log: TimeLog; item: Item | undefined }[];
  /** Zero-duration time-note markers; `item` may be deleted (tombstoned). */
  notes: { log: TimeLog; item: Item | undefined }[];
  /** Pause-adjusted time actually tracked (per {@link trackedMs}). */
  trackedMs: number;
  /** Wall-clock span start→end (or now), pauses included. */
  wallMs: number;
  /** Tracked time not attributed to any task segment (session-level work). */
  untrackedMs: number;
}

export function getSessionBlock(db: Db, session: TimeLog, upToMs: number = Date.now()): SessionBlock {
  const segments = sessionRows(db, session.id, 'task').map((log) => ({
    log,
    item: getItem(db, log.item_id),
    ms: Math.max(0, (log.end_time ? ms(log.end_time) : upToMs) - ms(log.start_time)),
  }));
  const completions = sessionRows(db, session.id, 'complete').map((log) => ({
    log,
    item: getItem(db, log.item_id),
  }));
  const notes = sessionRows(db, session.id, 'note').map((log) => ({
    log,
    item: getItem(db, log.item_id),
  }));
  const tracked = trackedMs(db, session, upToMs);
  const segTotal = segments.reduce((n, s) => n + s.ms, 0);
  const end = session.end_time ? ms(session.end_time) : upToMs;
  return {
    session,
    project: getItem(db, session.item_id),
    segments,
    pauses: sessionRows(db, session.id, 'pause'),
    completions,
    notes,
    trackedMs: tracked,
    wallMs: Math.max(0, end - ms(session.start_time)),
    untrackedMs: Math.max(0, tracked - segTotal),
  };
}

// ----- CSV export -----------------------------------------------------------

const CSV_HEADER = [
  'Date', 'Block', 'Project', 'Type', 'Item', 'Tags',
  'Start', 'End', 'Duration (min)', 'Wall (min)', 'Tracked (min)', 'Untracked (min)',
] as const;

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
const min = (msVal: number) => String(Math.round(msVal / 60_000));
const tagNames = (db: Db, itemId: string) => getItemTags(db, itemId).map((t) => t.name).join(', ');

/**
 * A row-per-entry CSV of the given blocks: one row for the session, then each
 * task segment, pause and completion within it. Wall/Tracked/Untracked minutes
 * are populated on the session row; each row carries the tags of its own item.
 */
export function toCsv(db: Db, blocks: SessionBlock[]): string {
  const rows: (string | number)[][] = [[...CSV_HEADER]];
  for (const b of blocks) {
    const s = b.session;
    const date = s.start_time.slice(0, 10);
    const project = b.project?.title || 'Untitled';
    const end = s.end_time ?? '';
    // Session row — carries the block-level totals.
    rows.push([
      date, s.id, project, 'Session', project, tagNames(db, s.item_id),
      s.start_time, end, min(b.wallMs), min(b.wallMs), min(b.trackedMs), min(b.untrackedMs),
    ]);
    // Interleave task segments, pauses, completions and time notes chronologically.
    const entries = [
      ...b.segments.map((seg) => ({ t: seg.log.start_time, kind: 'seg' as const, seg })),
      ...b.pauses.map((p) => ({ t: p.start_time, kind: 'pause' as const, p })),
      ...b.completions.map((c) => ({ t: c.log.start_time, kind: 'done' as const, c })),
      ...b.notes.map((n) => ({ t: n.log.start_time, kind: 'note' as const, n })),
    ].sort((a, z) => a.t.localeCompare(z.t));
    for (const e of entries) {
      if (e.kind === 'seg') {
        const segEnd = e.seg.log.end_time;
        rows.push([
          date, s.id, project, 'Task', e.seg.item?.title || 'Task', tagNames(db, e.seg.log.item_id),
          e.seg.log.start_time, segEnd ?? '', min(e.seg.ms), '', '', '',
        ]);
      } else if (e.kind === 'pause') {
        const pe = e.p.end_time;
        const dur = pe ? new Date(pe).getTime() - new Date(e.p.start_time).getTime() : 0;
        rows.push([
          date, s.id, project, e.p.note === SUSPEND ? 'Suspend' : 'Pause', project, '',
          e.p.start_time, pe ?? '', min(Math.max(0, dur)), '', '', '',
        ]);
      } else if (e.kind === 'done') {
        rows.push([
          date, s.id, project, 'Completed', e.c.item?.title || 'Task', tagNames(db, e.c.log.item_id),
          e.c.log.start_time, e.c.log.start_time, '', '', '', '',
        ]);
      } else {
        const title =
          !e.n.item || e.n.item.deleted ? '(deleted note)' : e.n.item.title || 'Note';
        rows.push([
          date, s.id, project, 'Note', title, e.n.item && !e.n.item.deleted ? tagNames(db, e.n.log.item_id) : '',
          e.n.log.start_time, e.n.log.start_time, '', '', '', '',
        ]);
      }
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

// ----- post-hoc editing: merge, gaps, segments -------------------------------
// Blocks stay editable after the fact: adjacent blocks of the same project can
// be merged (the gap between them becomes untracked time), untracked gaps can be
// deleted (trimming or splitting the block), and task segments can be added,
// re-timed or removed within the block's bounds. All writes go through emit().

/** A restart within this window of stopping the same project offers a quick merge. */
export const MERGE_QUICK_WINDOW_MS = 5 * 60_000;
/** The expanded-block view offers merging with a previous block within this window. */
export const MERGE_BLOCK_WINDOW_MS = 8 * 3_600_000;
/** Segments are at least one minute; edits round to whole minutes. */
export const MIN_SEGMENT_MS = 60_000;
const MIN_GAP_MS = 60_000; // gaps shorter than this are rounding noise, not shown
const GAP_MATCH_TOLERANCE_MS = 1_500; // stale-UI guard when deleting a gap
const roundMinute = (t: number) => Math.round(t / 60_000) * 60_000;
const isoAt = (t: number) => new Date(t).toISOString();

export interface UntrackedGap {
  start: string;
  end: string;
  ms: number;
  position: 'leading' | 'middle' | 'trailing';
}

/** Covered intervals (segments + pauses, minus `excludeId`) clamped to the block
 *  span, sorted and merged. Open entries extend to the block end (or `upToMs`). */
function coverage(
  block: SessionBlock,
  upToMs: number,
  excludeId?: string,
): { s: number; e: number }[] {
  const bs = ms(block.session.start_time);
  const be = block.session.end_time ? ms(block.session.end_time) : upToMs;
  const spans: { s: number; e: number }[] = [];
  for (const log of [...block.segments.map((x) => x.log), ...block.pauses]) {
    if (log.id === excludeId) continue;
    const s = Math.max(bs, ms(log.start_time));
    const e = Math.min(be, log.end_time ? ms(log.end_time) : be);
    if (e > s) spans.push({ s, e });
  }
  spans.sort((a, b) => a.s - b.s);
  const merged: { s: number; e: number }[] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.s <= last.e) last.e = Math.max(last.e, sp.e);
    else merged.push({ ...sp });
  }
  return merged;
}

/**
 * The block's untracked gaps — spans covered by neither a segment nor a pause.
 * A gap running to the end of an *open* block is its still-growing live tail
 * (position 'trailing', not deletable); a suspended block has no such tail
 * because its open suspend pause covers to now.
 */
export function computeGaps(block: SessionBlock, upToMs: number = Date.now()): UntrackedGap[] {
  const bs = ms(block.session.start_time);
  const be = block.session.end_time ? ms(block.session.end_time) : upToMs;
  const gaps: UntrackedGap[] = [];
  let cursor = bs;
  for (const c of [...coverage(block, upToMs), { s: be, e: be }]) {
    if (c.s - cursor >= MIN_GAP_MS) {
      gaps.push({
        start: isoAt(cursor),
        end: isoAt(c.s),
        ms: c.s - cursor,
        // A gap spanning the whole block counts as trailing (deleting it is an end-trim).
        position: c.s >= be ? 'trailing' : cursor <= bs ? 'leading' : 'middle',
      });
    }
    cursor = Math.max(cursor, c.e);
  }
  return gaps;
}

/** The window a segment may occupy: from the previous covered neighbor (or block
 *  start) to the next covered neighbor (or block end). `segmentId` null = no self
 *  to exclude, returns the block bounds. */
export function segmentBounds(
  block: SessionBlock,
  segmentId: string | null,
  upToMs: number = Date.now(),
): { minStartMs: number; maxEndMs: number } {
  const bs = ms(block.session.start_time);
  const be = block.session.end_time ? ms(block.session.end_time) : upToMs;
  const seg = segmentId ? block.segments.find((x) => x.log.id === segmentId) : undefined;
  let minStartMs = bs;
  let maxEndMs = be;
  if (seg) {
    const segS = ms(seg.log.start_time);
    const segE = seg.log.end_time ? ms(seg.log.end_time) : be;
    for (const c of coverage(block, upToMs, segmentId!)) {
      if (c.e <= segS) minStartMs = Math.max(minStartMs, c.e);
      if (c.s >= segE) maxEndMs = Math.min(maxEndMs, c.s);
    }
  }
  return { minStartMs, maxEndMs };
}

/** The most recent closed block of the same project/user ending within `windowMs`
 *  before `session` starts — the merge target for that session, if any. */
export function findMergeCandidate(db: Db, session: TimeLog, windowMs: number): TimeLog | null {
  const uw = userClause(session.user_id);
  const r = db.get<TLRow>(
    `SELECT * FROM time_logs
     WHERE kind = 'session' AND deleted = 0 AND ${uw.c}
       AND item_id = ? AND id <> ?
       AND end_time IS NOT NULL AND end_time <= ? AND end_time >= ?
     ORDER BY end_time DESC LIMIT 1`,
    [...uw.p, session.item_id, session.id, session.start_time, isoAt(ms(session.start_time) - windowMs)],
  );
  return r ? rowToTimeLog(r) : null;
}

function loadSession(db: Db, id: string): TimeLog | null {
  const r = db.get<TLRow>(
    "SELECT * FROM time_logs WHERE id = ? AND kind = 'session' AND deleted = 0",
    [id],
  );
  return r ? rowToTimeLog(r) : null;
}
function sessionChildren(db: Db, sessionId: string): TimeLog[] {
  return db
    .all<TLRow>('SELECT * FROM time_logs WHERE session_id = ? AND deleted = 0', [sessionId])
    .map(rowToTimeLog);
}

/**
 * Absorb the `newerId` block into `olderId` (same project, same user). The older
 * row survives, extended to the newer block's end — a null end reopens it, which
 * is the timer-bar case: the survivor becomes the active session. Children of the
 * newer block re-parent onto the survivor; the gap between the blocks is covered
 * by nothing and so becomes untracked time. Returns the survivor, or null (no
 * writes) if the pair isn't mergeable. Window checks are the caller's job via
 * {@link findMergeCandidate}.
 */
export function mergeSessions(db: Db, dev: string, olderId: string, newerId: string): TimeLog | null {
  const older = loadSession(db, olderId);
  const newer = loadSession(db, newerId);
  if (!older || !newer) return null;
  if (older.item_id !== newer.item_id || older.user_id !== newer.user_id) return null;
  if (!older.end_time) return null;
  if (ms(older.start_time) >= ms(newer.start_time) || ms(older.end_time) > ms(newer.start_time))
    return null;
  for (const child of sessionChildren(db, newerId)) {
    emit(db, dev, { ...child, session_id: olderId });
  }
  emit(db, dev, { ...newer, deleted: true });
  return emit(db, dev, { ...older, end_time: newer.end_time });
}

/**
 * Delete one untracked gap. Leading/trailing gaps trim the block's start/end; a
 * middle gap splits the block into two sessions, children going to the side that
 * contains them. The gap is re-derived and matched within a small tolerance, so a
 * stale UI snapshot is a no-op rather than a mis-cut — and because the matched gap
 * is uncovered by construction, no segment or pause can straddle it.
 */
export function deleteUntrackedGap(
  db: Db,
  dev: string,
  sessionId: string,
  gapStartIso: string,
  gapEndIso: string,
): void {
  const session = loadSession(db, sessionId);
  if (!session) return;
  const gap = computeGaps(getSessionBlock(db, session)).find(
    (g) =>
      Math.abs(ms(g.start) - ms(gapStartIso)) <= GAP_MATCH_TOLERANCE_MS &&
      Math.abs(ms(g.end) - ms(gapEndIso)) <= GAP_MATCH_TOLERANCE_MS,
  );
  if (!gap) return;
  if (gap.position === 'trailing') {
    if (!session.end_time) return; // an open block's live tail is still growing
    emit(db, dev, { ...session, end_time: gap.start });
  } else if (gap.position === 'leading') {
    emit(db, dev, { ...session, start_time: gap.end });
  } else {
    // Split: the existing row keeps the left half; a new session takes the right,
    // inheriting the original end (null keeps a live tail open on the right).
    const right = emit(
      db,
      dev,
      makeLog({
        kind: 'session',
        itemId: session.item_id,
        userId: session.user_id,
        sessionId: null,
        start: gap.end,
        end: session.end_time,
      }),
    );
    const gapStartMs = ms(gap.start);
    const gapEndMs = ms(gap.end);
    for (const c of sessionChildren(db, sessionId)) {
      const goesRight =
        c.kind === 'complete' || c.kind === 'note'
          ? ms(c.start_time) > gapStartMs
          : ms(c.start_time) >= gapEndMs;
      if (goesRight) emit(db, dev, { ...c, session_id: right.id });
    }
    emit(db, dev, { ...session, end_time: gap.start });
  }
}

/** Round to whole minutes and grow a too-short span to MIN_SEGMENT_MS within
 *  [lo, hi], preferring to extend the end. Null if it can't fit. */
function fitSpan(
  startIso: string,
  endIso: string,
  lo: number,
  hi: number,
): { s: number; e: number } | null {
  const s = Math.max(roundMinute(ms(startIso)), lo);
  const e = Math.min(roundMinute(ms(endIso)), hi);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  if (e - s >= MIN_SEGMENT_MS) return { s, e };
  if (s + MIN_SEGMENT_MS <= hi) return { s, e: s + MIN_SEGMENT_MS };
  if (e - MIN_SEGMENT_MS >= lo) return { s: e - MIN_SEGMENT_MS, e };
  return null;
}

/**
 * Insert a closed task segment into untracked space in a block. The task must
 * anchor to the block's project; times round to whole minutes and clamp into the
 * gap containing the requested midpoint. Returns the segment, or null.
 */
export function addSegment(
  db: Db,
  dev: string,
  sessionId: string,
  taskId: string,
  startIso: string,
  endIso: string,
): TimeLog | null {
  const session = loadSession(db, sessionId);
  if (!session) return null;
  if (sessionAnchor(db, taskId) !== session.item_id) return null;
  const mid = (ms(startIso) + ms(endIso)) / 2;
  const gap = computeGaps(getSessionBlock(db, session)).find(
    (g) => mid >= ms(g.start) && mid <= ms(g.end),
  );
  if (!gap) return null;
  const span = fitSpan(startIso, endIso, ms(gap.start), ms(gap.end));
  if (!span) return null;
  return emit(
    db,
    dev,
    makeLog({
      kind: 'task',
      itemId: taskId,
      userId: session.user_id,
      sessionId,
      start: isoAt(span.s),
      end: isoAt(span.e),
    }),
  );
}

/**
 * Re-time a closed segment. Times round to whole minutes and clamp between the
 * neighboring covered spans (segments/pauses — in an open block the running
 * segment is a neighbor) and the block bounds; at least a minute must remain.
 * The live (open) segment is never editable here — that's the timer bar's job.
 */
export function updateSegment(
  db: Db,
  dev: string,
  segmentId: string,
  startIso: string,
  endIso: string,
): TimeLog | null {
  const r = db.get<TLRow>(
    "SELECT * FROM time_logs WHERE id = ? AND kind = 'task' AND deleted = 0",
    [segmentId],
  );
  if (!r) return null;
  const seg = rowToTimeLog(r);
  if (!seg.end_time || !seg.session_id) return null;
  const session = loadSession(db, seg.session_id);
  if (!session) return null;
  const { minStartMs, maxEndMs } = segmentBounds(getSessionBlock(db, session), segmentId);
  const span = fitSpan(startIso, endIso, minStartMs, maxEndMs);
  if (!span) return null;
  if (isoAt(span.s) === seg.start_time && isoAt(span.e) === seg.end_time) return seg;
  return emit(db, dev, { ...seg, start_time: isoAt(span.s), end_time: isoAt(span.e) });
}

/** Soft-delete a closed segment; its span becomes untracked time. The live (open)
 *  segment can't be removed here. */
export function removeSegment(db: Db, dev: string, segmentId: string): void {
  const r = db.get<TLRow>(
    "SELECT * FROM time_logs WHERE id = ? AND kind = 'task' AND deleted = 0",
    [segmentId],
  );
  if (!r) return;
  const seg = rowToTimeLog(r);
  if (!seg.end_time) return;
  emit(db, dev, { ...seg, deleted: true });
}

/** Sessions overlapping [fromIso, toIso), most recent first. */
export function listSessions(db: Db, fromIso: string, toIso: string, userId?: string | null): TimeLog[] {
  const uw = userId === undefined ? { c: '1=1', p: [] as string[] } : userClause(userId);
  const now = iso();
  return db
    .all<TLRow>(
      `SELECT * FROM time_logs WHERE kind = 'session' AND deleted = 0 AND ${uw.c}
         AND start_time < ? AND COALESCE(end_time, ?) > ?
       ORDER BY start_time DESC`,
      [...uw.p, toIso, now, fromIso],
    )
    .map(rowToTimeLog);
}
