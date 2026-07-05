import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { createItem, createTag, setItemTags } from './repo';
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
