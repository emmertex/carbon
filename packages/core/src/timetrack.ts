import { v4 as uuidv4 } from 'uuid';
import type { Db, Row } from './db';
import type { Item, TimeLog, TimeLogKind } from './types';
import { getItem, rowToTimeLog, recordRecordOp } from './repo';

// Time tracking v2 — see docs/time-tracking-design.md.
// A *session* (kind 'session', item_id = project) contains *task segments*
// (kind 'task') and *pauses* (kind 'pause'). Switching to another project
// *suspends* the current session (a pause with note 'suspend'); re-entering a
// project resumes its suspended session. Break pauses have note null.

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
  kind: string;
  session_id: string | null;
  deleted: number;
}

function userClause(userId: string | null): { c: string; p: string[] } {
  return userId == null ? { c: 'user_id IS NULL', p: [] } : { c: 'user_id = ?', p: [userId] };
}

function emit(db: Db, dev: string, log: TimeLog): TimeLog {
  recordRecordOp(db, dev, 'timelog', log.id, log);
  return log;
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
  trackedMs: number;
}

export function getSessionBlock(db: Db, session: TimeLog, upToMs: number = Date.now()): SessionBlock {
  const segments = sessionRows(db, session.id, 'task').map((log) => ({
    log,
    item: getItem(db, log.item_id),
    ms: Math.max(0, (log.end_time ? ms(log.end_time) : upToMs) - ms(log.start_time)),
  }));
  return {
    session,
    project: getItem(db, session.item_id),
    segments,
    pauses: sessionRows(db, session.id, 'pause'),
    trackedMs: trackedMs(db, session, upToMs),
  };
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
