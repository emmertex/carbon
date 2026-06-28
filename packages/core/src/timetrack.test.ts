import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { createItem } from './repo';
import { startSession, pauseNow, pauseBefore } from './timetrack';

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
