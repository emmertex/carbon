import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { createItem, createTag, setItemTags, saveTimeLog, rowToTimeLog, getItem, deleteItem, getTimeLogs, taskActualMs } from './repo';
import type { TimeLog } from './types';
import {
  startSession,
  startTask,
  stopActive,
  pauseNow,
  pauseBefore,
  recordCompletion,
  removeCompletion,
  getTimeContext,
  getSessionBlock,
  toCsv,
  computeGaps,
  segmentBounds,
  findMergeCandidate,
  mergeSessions,
  deleteUntrackedGap,
  addSegment,
  updateSegment,
  removeSegment,
  trackedMs,
  listSessions,
  MERGE_QUICK_WINDOW_MS,
  MERGE_BLOCK_WINDOW_MS,
  addTimeNote,
  removeTimeNote,
} from './timetrack';

const A = 'device-a';
const U = 'user-1';

function pauseCount(db: ReturnType<typeof openMemoryDb>): number {
  return db.all<{ n: number }>("SELECT COUNT(*) AS n FROM time_logs WHERE kind = 'pause'")[0]!.n;
}

// M4 — a zero/negative pause is meaningless and previously could invert a span
// (start > end), making trackedMs *add* time. The guards make it a no-op.
test('pauseNow / pauseBefore ignore non-positive durations', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'proj', type: 'project' });
  startSession(db, A, proj.id, U);

  pauseNow(db, A, U, -10);
  pauseNow(db, A, U, 0);
  pauseBefore(db, A, U, -10);
  pauseBefore(db, A, U, 0);

  assert.equal(pauseCount(db), 0, 'no pause rows created for non-positive durations');
  // And no inverted spans exist anywhere.
  const inverted = db.all(
    'SELECT 1 FROM time_logs WHERE end_time IS NOT NULL AND end_time < start_time',
  );
  assert.equal(inverted.length, 0);
});

test('pauseBefore with a positive duration does carve out a pause', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'proj', type: 'project' });
  startSession(db, A, proj.id, U);
  pauseBefore(db, A, U, 5);
  assert.ok(pauseCount(db) >= 1, 'a positive pause is recorded');
});

test('completing tracked tasks records completion markers and stops the segment', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'proj', type: 'project' });
  const taskA = createItem(db, A, { title: 'A', type: 'task', parentId: proj.id });
  const taskB = createItem(db, A, { title: 'B', type: 'task', parentId: proj.id });

  startTask(db, A, taskA.id, U);
  startTask(db, A, taskB.id, U); // A stopped, B running
  recordCompletion(db, A, taskB.id, U); // B completed while active → segment stops + marker
  recordCompletion(db, A, taskA.id, U); // A completed while not the active segment → just a marker

  const session = getTimeContext(db, U).session!;
  assert.ok(session, 'session still open (block keeps running)');
  // The active B segment was closed by completion; no task segment is open now.
  const openTasks = db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM time_logs WHERE kind = 'task' AND end_time IS NULL AND deleted = 0",
  )[0]!.n;
  assert.equal(openTasks, 0, 'completing the active task stops its segment');

  const block = getSessionBlock(db, session);
  assert.equal(block.completions.length, 2, 'two completion markers');
  assert.equal(block.segments.length, 2, 'two task segments (A and B)');
  const completedIds = block.completions.map((c) => c.log.item_id).sort();
  assert.deepEqual(completedIds, [taskA.id, taskB.id].sort());

  // Reopening a task retracts its completion marker.
  removeCompletion(db, A, taskA.id, U);
  assert.equal(getSessionBlock(db, session).completions.length, 1);
});

test('completing a task outside any open block is a no-op', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'proj', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  recordCompletion(db, A, task.id, U);
  const markers = db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM time_logs WHERE kind = 'complete'",
  )[0]!.n;
  assert.equal(markers, 0, 'no marker without an open session');
});

test('toCsv includes every entry type plus tags', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'Proj', type: 'project' });
  const task = createItem(db, A, { title: 'Task A', type: 'task', parentId: proj.id });
  const tag = createTag(db, A, 'urgent');
  setItemTags(db, A, task.id, [tag.id]);

  startTask(db, A, task.id, U);
  pauseNow(db, A, U, null);
  recordCompletion(db, A, task.id, U);
  stopActive(db, A, U);

  const session = db
    .all<{ id: string; item_id: string; start_time: string; end_time: string | null; kind: string }>(
      "SELECT * FROM time_logs WHERE kind = 'session'",
    )
    .map((r) => ({
      id: r.id,
      item_id: r.item_id,
      user_id: U,
      start_time: r.start_time,
      end_time: r.end_time,
      note: null,
      created_at: r.start_time,
      updated_at: r.start_time,
      kind: 'session' as const,
      session_id: null,
      deleted: false,
    }))[0]!;
  const csv = toCsv(db, [getSessionBlock(db, session)]);

  assert.match(csv, /"Session"/);
  assert.match(csv, /"Task"/);
  assert.match(csv, /"Completed"/);
  assert.match(csv, /"urgent"/, 'task tags appear in the CSV');
  assert.match(csv, /Wall \(min\)/, 'header carries the block-level columns');
});

// ----- post-hoc editing: merge, gaps, segments -------------------------------

type Mem = ReturnType<typeof openMemoryDb>;

// Fixtures use explicit timestamps: minute offsets from a fixed origin.
const T0 = Date.parse('2026-01-05T09:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const minOf = (iso: string) => (Date.parse(iso) - T0) / 60_000;

function mkLog(
  db: Mem,
  p: {
    kind: TimeLog['kind'];
    item: string;
    session?: string | null;
    start: string;
    end?: string | null;
    user?: string | null;
    note?: string | null;
  },
): TimeLog {
  return saveTimeLog(db, A, {
    id: randomUUID(),
    item_id: p.item,
    user_id: p.user === undefined ? U : p.user,
    start_time: p.start,
    end_time: p.end ?? null,
    note: p.note ?? null,
    created_at: p.start,
    updated_at: p.start, // saveTimeLog restamps from the causal clock
    kind: p.kind,
    session_id: p.session ?? null,
    deleted: false,
  });
}

function allSessions(db: Mem): TimeLog[] {
  return db
    .all("SELECT * FROM time_logs WHERE kind = 'session' AND deleted = 0 ORDER BY start_time")
    .map((r) => rowToTimeLog(r as never));
}
function childrenOf(db: Mem, sessionId: string): TimeLog[] {
  return db
    .all('SELECT * FROM time_logs WHERE session_id = ? AND deleted = 0 ORDER BY start_time', [
      sessionId,
    ])
    .map((r) => rowToTimeLog(r as never));
}
function assertNoInvertedSpans(db: Mem) {
  const inverted = db.all(
    'SELECT 1 FROM time_logs WHERE end_time IS NOT NULL AND end_time < start_time',
  );
  assert.equal(inverted.length, 0, 'no inverted spans');
}

test('computeGaps classifies leading/middle/trailing and drops sub-minute gaps', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(100) });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(10), end: at(30) });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(40), end: at(60) });
  mkLog(db, { kind: 'pause', item: proj.id, session: s.id, start: at(60), end: at(80) });
  // A 30-second sliver between two segments — rounding noise, not a gap.
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(80), end: at(90) });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(90.5), end: at(100) });

  const gaps = computeGaps(getSessionBlock(db, s));
  assert.deepEqual(
    gaps.map((g) => [minOf(g.start), minOf(g.end), g.position]),
    [
      [0, 10, 'leading'],
      [30, 40, 'middle'],
    ],
  );
});

test('computeGaps: open block has a live trailing gap; suspended block does not', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const open = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: null });
  mkLog(db, { kind: 'task', item: task.id, session: open.id, start: at(0), end: at(10) });
  const upTo = T0 + 20 * 60_000;
  const gaps = computeGaps(getSessionBlock(db, open, upTo), upTo);
  assert.deepEqual(
    gaps.map((g) => [minOf(g.start), minOf(g.end), g.position]),
    [[10, 20, 'trailing']],
  );

  // Suspend pause (open) covers to now → no phantom trailing gap.
  mkLog(db, { kind: 'pause', item: proj.id, session: open.id, start: at(10), end: null, note: 'suspend' });
  assert.deepEqual(computeGaps(getSessionBlock(db, open, upTo), upTo), []);
});

test('findMergeCandidate respects window, project, user and open/deleted state', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const other = createItem(db, A, { title: 'q', type: 'project' });
  const prev = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(60) });
  const cur = mkLog(db, { kind: 'session', item: proj.id, start: at(62), end: null });

  assert.equal(findMergeCandidate(db, cur, MERGE_QUICK_WINDOW_MS)?.id, prev.id);

  // 12-minute gap: outside the quick window, inside the block window.
  const late = mkLog(db, { kind: 'session', item: proj.id, start: at(72), end: null });
  db.run('DELETE FROM time_logs WHERE id = ?', [cur.id]);
  assert.equal(findMergeCandidate(db, late, MERGE_QUICK_WINDOW_MS), null);
  assert.equal(findMergeCandidate(db, late, MERGE_BLOCK_WINDOW_MS)?.id, prev.id);

  // Nearest of two candidates wins.
  const nearer = mkLog(db, { kind: 'session', item: proj.id, start: at(61), end: at(70) });
  assert.equal(findMergeCandidate(db, late, MERGE_BLOCK_WINDOW_MS)?.id, nearer.id);

  // Different project / different user / still open / deleted → no candidate.
  const curB = mkLog(db, { kind: 'session', item: other.id, start: at(62), end: null });
  assert.equal(findMergeCandidate(db, curB, MERGE_BLOCK_WINDOW_MS), null);
  const curC = mkLog(db, { kind: 'session', item: proj.id, start: at(62), end: null, user: 'user-2' });
  assert.equal(findMergeCandidate(db, curC, MERGE_BLOCK_WINDOW_MS), null);
  db.run('UPDATE time_logs SET end_time = NULL WHERE id = ?', [nearer.id]);
  db.run('UPDATE time_logs SET deleted = 1 WHERE id = ?', [prev.id]);
  assert.equal(findMergeCandidate(db, late, MERGE_BLOCK_WINDOW_MS), null);
});

test('mergeSessions absorbs a closed block: children re-parent, gap becomes untracked', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const older = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(60) });
  mkLog(db, { kind: 'task', item: task.id, session: older.id, start: at(0), end: at(30) });
  const newer = mkLog(db, { kind: 'session', item: proj.id, start: at(62), end: at(120) });
  mkLog(db, { kind: 'task', item: task.id, session: newer.id, start: at(70), end: at(80) });
  mkLog(db, { kind: 'pause', item: proj.id, session: newer.id, start: at(90), end: at(100) });
  mkLog(db, { kind: 'complete', item: task.id, session: newer.id, start: at(80), end: at(80) });

  const survivor = mergeSessions(db, A, older.id, newer.id);
  assert.ok(survivor);
  assert.equal(survivor.id, older.id);
  assert.equal(survivor.end_time, at(120));
  assert.equal(allSessions(db).length, 1, 'newer session tombstoned');
  assert.equal(childrenOf(db, older.id).length, 4, 'all children on the survivor');

  const block = getSessionBlock(db, survivor);
  assert.equal(block.segments.length, 2);
  assert.equal(block.pauses.length, 1);
  assert.equal(block.completions.length, 1);
  // 120 min wall − 10 min pause = 110 tracked; 40 min in segments → 70 untracked
  // (including the 2-minute merge gap).
  assert.equal(block.trackedMs, 110 * 60_000);
  assert.equal(block.untrackedMs, 70 * 60_000);
  assertNoInvertedSpans(db);
});

test('mergeSessions with an open newer block reopens the survivor (timer-bar case)', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const older = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(60) });
  const newer = mkLog(db, { kind: 'session', item: proj.id, start: at(62), end: null });
  mkLog(db, { kind: 'task', item: task.id, session: newer.id, start: at(62), end: null });

  const survivor = mergeSessions(db, A, older.id, newer.id);
  assert.ok(survivor);
  assert.equal(survivor.end_time, null, 'survivor reopened');
  const ctx = getTimeContext(db, U);
  assert.equal(ctx.session?.id, older.id, 'survivor is the active session');
  assert.equal(ctx.task?.item_id, task.id, 'open segment carried over');
});

test('mergeSessions refuses invalid pairs without writing', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const other = createItem(db, A, { title: 'q', type: 'project' });
  const a = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(60) });
  const overlapping = mkLog(db, { kind: 'session', item: proj.id, start: at(50), end: at(90) });
  const foreign = mkLog(db, { kind: 'session', item: other.id, start: at(62), end: at(90) });
  const otherUser = mkLog(db, { kind: 'session', item: proj.id, start: at(62), end: at(90), user: 'user-2' });
  const openOlder = mkLog(db, { kind: 'session', item: proj.id, start: at(100), end: null });
  const afterOpen = mkLog(db, { kind: 'session', item: proj.id, start: at(120), end: at(130) });

  const before = db.all('SELECT id, end_time, deleted FROM time_logs ORDER BY id');
  assert.equal(mergeSessions(db, A, a.id, overlapping.id), null);
  assert.equal(mergeSessions(db, A, a.id, foreign.id), null);
  assert.equal(mergeSessions(db, A, a.id, otherUser.id), null);
  assert.equal(mergeSessions(db, A, openOlder.id, afterOpen.id), null, 'older must be closed');
  assert.equal(mergeSessions(db, A, a.id, 'missing'), null);
  assert.deepEqual(db.all('SELECT id, end_time, deleted FROM time_logs ORDER BY id'), before);
});

test('deleteUntrackedGap trims leading/trailing gaps and guards stale bounds', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(100) });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(10), end: at(20) });

  // Stale bounds (5 s off) → no-op.
  deleteUntrackedGap(db, A, s.id, new Date(T0 + 5_000).toISOString(), at(10));
  assert.equal(allSessions(db)[0]!.start_time, at(0));

  deleteUntrackedGap(db, A, s.id, at(0), at(10)); // leading
  assert.equal(allSessions(db)[0]!.start_time, at(10));
  deleteUntrackedGap(db, A, s.id, at(20), at(100)); // trailing
  assert.equal(allSessions(db)[0]!.end_time, at(20));
  assertNoInvertedSpans(db);
});

test('deleteUntrackedGap is a no-op on the live tail of an open block', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: null });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(0), end: at(10) });
  const gap = computeGaps(getSessionBlock(db, s))[0]!;
  assert.equal(gap.position, 'trailing');
  deleteUntrackedGap(db, A, s.id, gap.start, gap.end);
  assert.equal(allSessions(db)[0]!.end_time, null, 'open block untouched');
});

test('deleteUntrackedGap splits a block around a middle gap', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const t1 = createItem(db, A, { title: 't1', type: 'task', parentId: proj.id });
  const t2 = createItem(db, A, { title: 't2', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(60) });
  mkLog(db, { kind: 'task', item: t1.id, session: s.id, start: at(10), end: at(20) });
  mkLog(db, { kind: 'complete', item: t1.id, session: s.id, start: at(15), end: at(15) });
  mkLog(db, { kind: 'complete', item: t1.id, session: s.id, start: at(25), end: at(25) }); // inside the gap
  mkLog(db, { kind: 'task', item: t2.id, session: s.id, start: at(40), end: at(50) });
  mkLog(db, { kind: 'pause', item: proj.id, session: s.id, start: at(50), end: at(60) });

  const origTracked = trackedMs(db, s);
  deleteUntrackedGap(db, A, s.id, at(20), at(40));

  const sessions = allSessions(db);
  assert.equal(sessions.length, 2);
  const [left, right] = sessions as [TimeLog, TimeLog];
  assert.deepEqual([left.start_time, left.end_time], [at(0), at(20)]);
  assert.deepEqual([right.start_time, right.end_time], [at(40), at(60)]);
  assert.equal(left.id, s.id, 'left keeps the original id');

  const leftKinds = childrenOf(db, left.id).map((c) => [c.kind, minOf(c.start_time)]);
  const rightKinds = childrenOf(db, right.id).map((c) => [c.kind, minOf(c.start_time)]);
  assert.deepEqual(leftKinds, [
    ['task', 10],
    ['complete', 15],
  ]);
  assert.deepEqual(rightKinds, [
    ['complete', 25],
    ['task', 40],
    ['pause', 50],
  ]);

  // Conservation: tracked time is only reduced by the deleted gap.
  const gapMs = 20 * 60_000;
  assert.equal(trackedMs(db, left) + trackedMs(db, right), origTracked - gapMs);
  assertNoInvertedSpans(db);
});

test('deleteUntrackedGap split of an open block keeps the live tail on the right', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: null });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(0), end: at(20) });
  const live = mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(40), end: null });

  deleteUntrackedGap(db, A, s.id, at(20), at(40));
  const sessions = allSessions(db);
  assert.equal(sessions.length, 2);
  const right = sessions[1]!;
  assert.equal(right.end_time, null, 'right half stays open');
  assert.equal(childrenOf(db, right.id)[0]!.id, live.id, 'open segment moved right');
});

test('addSegment inserts into a gap with rounding, clamping and project validation', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const other = createItem(db, A, { title: 'q', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const foreign = createItem(db, A, { title: 'f', type: 'task', parentId: other.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(100) });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(10), end: at(20) });

  // Rounds 30:20–45:40 to whole minutes.
  const seg = addSegment(db, A, s.id, task.id, new Date(T0 + 30 * 60_000 + 20_000).toISOString(), new Date(T0 + 45 * 60_000 + 40_000).toISOString());
  assert.ok(seg);
  assert.deepEqual([seg.start_time, seg.end_time], [at(30), at(46)]);

  // Overlapping request clamps into the gap (segment above now covers 30–46).
  const clamped = addSegment(db, A, s.id, task.id, at(44), at(54));
  assert.ok(clamped);
  assert.deepEqual([clamped.start_time, clamped.end_time], [at(46), at(54)]);

  assert.equal(addSegment(db, A, s.id, foreign.id, at(60), at(70)), null, 'foreign-project task');
  assert.equal(addSegment(db, A, s.id, task.id, at(12), at(18)), null, 'midpoint inside a segment');
  assertNoInvertedSpans(db);
});

test('updateSegment clamps to neighbors and block bounds, enforcing a 1-min minimum', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(100) });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(10), end: at(20) });
  const b = mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(30), end: at(40) });
  mkLog(db, { kind: 'pause', item: proj.id, session: s.id, start: at(50), end: at(60) });

  // Requested 15–55 clamps to neighbor A's end (20) and the pause start (50).
  const updated = updateSegment(db, A, b.id, at(15), at(55));
  assert.deepEqual([updated?.start_time, updated?.end_time], [at(20), at(50)]);

  // Zero-length request grows to the 1-minute minimum.
  const minimal = updateSegment(db, A, b.id, at(30), at(30));
  assert.deepEqual([minimal?.start_time, minimal?.end_time], [at(30), at(31)]);
  assertNoInvertedSpans(db);
});

test('updateSegment rejects the live segment and clamps against it in an open block', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: null });
  const closed = mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(10), end: at(20) });
  const live = mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(30), end: null });

  assert.equal(updateSegment(db, A, live.id, at(30), at(50)), null, 'live segment not editable');
  const updated = updateSegment(db, A, closed.id, at(10), at(50));
  assert.equal(updated?.end_time, at(30), 'clamped to the running segment');
});

test('removeSegment soft-deletes a closed segment; the live one is refused', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(60) });
  const seg = mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(10), end: at(20) });

  const before = getSessionBlock(db, s).untrackedMs;
  removeSegment(db, A, seg.id);
  const block = getSessionBlock(db, s);
  assert.equal(block.segments.length, 0);
  assert.equal(block.untrackedMs, before + 10 * 60_000);
  const row = db.all('SELECT deleted FROM time_logs WHERE id = ?', [seg.id])[0] as { deleted: number };
  assert.equal(row.deleted, 1, 'soft-deleted, tombstone kept');

  const s2 = mkLog(db, { kind: 'session', item: proj.id, start: at(70), end: null });
  const live = mkLog(db, { kind: 'task', item: task.id, session: s2.id, start: at(70), end: null });
  removeSegment(db, A, live.id);
  assert.equal(childrenOf(db, s2.id).length, 1, 'live segment kept');
});

test('segmentBounds windows a segment between covered neighbors', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'p', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  const s = mkLog(db, { kind: 'session', item: proj.id, start: at(0), end: at(100) });
  mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(10), end: at(20) });
  const b = mkLog(db, { kind: 'task', item: task.id, session: s.id, start: at(30), end: at(40) });
  mkLog(db, { kind: 'pause', item: proj.id, session: s.id, start: at(50), end: at(60) });

  const bounds = segmentBounds(getSessionBlock(db, s), b.id);
  assert.equal(bounds.minStartMs, T0 + 20 * 60_000);
  assert.equal(bounds.maxEndMs, T0 + 50 * 60_000);
});


test('addTimeNote nests under the active task and pins a marker', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'proj', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  startTask(db, A, task.id, U);

  const result = addTimeNote(db, A, U, {
    title: 'Traffic',
    body: 'slow',
    metadata: { gpx: '<trk/>' },
  });
  assert.ok(result);
  assert.equal(result!.note.type, 'note');
  assert.equal(result!.note.parent_id, task.id);
  assert.equal(result!.note.note, 'slow');
  assert.ok(result!.note.metadata?.includes('gpx'));
  assert.equal(result!.log.kind, 'note');
  assert.equal(result!.log.item_id, result!.note.id);
  assert.equal(result!.log.start_time, result!.log.end_time);

  // Running task segment is undisturbed.
  const ctx = getTimeContext(db, U);
  assert.ok(ctx.task);
  assert.equal(ctx.task!.item_id, task.id);

  const block = getSessionBlock(db, ctx.session!);
  assert.equal(block.notes.length, 1);
  assert.equal(block.notes[0]!.item?.title, 'Traffic');

  // Remove reference only — note item survives.
  assert.equal(removeTimeNote(db, A, result!.log.id, 'reference'), true);
  assert.equal(getSessionBlock(db, ctx.session!).notes.length, 0);
  assert.equal(getItem(db, result!.note.id)?.deleted, false);
});

test('addTimeNote under project root when only a session is active', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'proj', type: 'project' });
  startSession(db, A, proj.id, U);
  const result = addTimeNote(db, A, U, { title: 'Break note' });
  assert.ok(result);
  assert.equal(result!.note.parent_id, proj.id);
});

test('removeTimeNote mode=note deletes the note item; deleted note stays labelled in block', () => {
  const db = openMemoryDb();
  const proj = createItem(db, A, { title: 'proj', type: 'project' });
  const task = createItem(db, A, { title: 't', type: 'task', parentId: proj.id });
  startTask(db, A, task.id, U);

  const a = addTimeNote(db, A, U, { title: 'A' })!;
  const b = addTimeNote(db, A, U, { title: 'B' })!;

  assert.equal(removeTimeNote(db, A, a.log.id, 'note'), true);
  assert.equal(getItem(db, a.note.id)?.deleted, true);

  // Delete note B from the task list; marker remains with deleted item.
  deleteItem(db, A, b.note.id);
  const session = getTimeContext(db, U).session!;
  const notes = getSessionBlock(db, session).notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.log.id, b.log.id);
  assert.equal(notes[0]!.item?.deleted, true);
});

test('addTimeNote is a no-op without an active session', () => {
  const db = openMemoryDb();
  assert.equal(addTimeNote(db, A, U, { title: 'x' }), null);
});

// Inbox/orphan tasks use sessionAnchor = the task itself, so session and task
// segments share item_id. Detail UIs must not sum every getTimeLogs row or they
// double-count (~2× vs the Time Tracked report's trackedMs).
test('inbox task: taskActualMs matches session trackedMs (no double-count)', () => {
  const db = openMemoryDb();
  const task = createItem(db, A, { title: 'inbox task', type: 'task' });
  const start = new Date(Date.now() - 14_000).toISOString();
  startTask(db, A, task.id, U);
  // Backdate the open rows so the closed span is deterministic.
  const ctx = getTimeContext(db, U);
  assert.ok(ctx.session);
  assert.ok(ctx.task);
  assert.equal(ctx.session!.item_id, task.id, 'session anchors on the inbox task');
  db.run(`UPDATE time_logs SET start_time = ? WHERE id = ?`, [start, ctx.session!.id]);
  db.run(`UPDATE time_logs SET start_time = ? WHERE id = ?`, [start, ctx.task!.id]);
  stopActive(db, A, U);

  const session = listSessions(db, start, new Date().toISOString(), U)[0]!;
  assert.ok(session);
  const reportMs = trackedMs(db, session);
  const detailMs = taskActualMs(db, task.id, U);
  assert.ok(reportMs >= 13_000 && reportMs <= 15_000, `report ~14s, got ${reportMs}`);
  assert.equal(detailMs, reportMs, 'detail must match report (not 2×)');

  // Raw sum of all getTimeLogs rows would be ~2× — document the trap.
  const raw = getTimeLogs(db, task.id).reduce((s, l) => {
    const end = l.end_time ? new Date(l.end_time).getTime() : Date.now();
    return s + Math.max(0, end - new Date(l.start_time).getTime());
  }, 0);
  assert.ok(raw >= reportMs * 1.5, 'raw all-kinds sum is roughly double');
});
