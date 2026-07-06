import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlParams } from './db';
import { migrate } from './migrate';
import { MIGRATIONS } from './schema';
import {
  createItem,
  updateItem,
  getItem,
  setCompleted,
  setCompletedCascade,
  getChildren,
  allItems,
  moveItem,
  queryItems,
} from './repo';
import { isBlocked } from './availability';
import { today, flagged, inbox } from './perspectives';

function makeDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  return {
    run: (sql: string, params: SqlParams = []) => void sqlite.prepare(sql).run(...params),
    all: <T>(sql: string, params: SqlParams = []) => sqlite.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: SqlParams = []) =>
      sqlite.prepare(sql).get(...params) as T | undefined,
    exec: (sql: string) => sqlite.exec(sql),
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const r = fn();
        sqlite.exec('COMMIT');
        return r;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function openDb(): Db {
  const db = makeDb();
  migrate(db);
  return db;
}

/** A db migrated only up to `version`, leaving later migrations unapplied. */
function openDbAtVersion(version: number): Db {
  const db = makeDb();
  for (const m of MIGRATIONS) {
    if (m.version <= version) db.exec(m.up);
  }
  db.run(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(version)],
  );
  return db;
}

const DEV = 'test-device';

// ----- migration v20 --------------------------------------------------------

test('migration v20 preserves v19 data losslessly and admits type=note', () => {
  const db = openDbAtVersion(19);

  // A representative v19 row across many columns, inserted raw to mimic pre-upgrade
  // data. (v19's items CHECK is type IN ('project','task','folder').)
  db.run(
    `INSERT INTO items
       (id, parent_id, type, title, note, status, flagged, priority, defer_date,
        due_date, completed_at, review_interval, reviewed_at, recurrence, color,
        sort_order, created_at, updated_at, deleted, clocks, owner_id, geo, alerts,
        reminder_at, estimate_minutes, order_mode, folder_id, sys_kind)
     VALUES
       ('p1', NULL, 'project', 'Legacy', 'the note body', 'active', 1, 2, NULL,
        '2026-02-01T00:00:00.000Z', NULL, 30, NULL, NULL, '#abc',
        7, '2026-01-01', '2026-01-02', 0, '{"title":{"ts":1,"dev":"d"}}', 'u1', NULL, NULL,
        NULL, 45, 'sequential', 'fld1', 'billing')`,
  );
  db.run(
    `INSERT INTO items
       (id, parent_id, type, title, status, sort_order, created_at, updated_at, deleted, clocks)
     VALUES ('t1', 'p1', 'task', 'child', 'done', 3, '2026-01-01', '2026-01-02', 0, '{}')`,
  );

  // Pre-migration, type='note' must be rejected by the v19 CHECK constraint.
  assert.throws(() =>
    db.run(
      `INSERT INTO items (id, type, title, status, sort_order, created_at, updated_at, deleted, clocks)
       VALUES ('n0', 'note', 'X', 'active', 0, '2026-01-01', '2026-01-01', 0, '{}')`,
    ),
  );

  migrate(db);

  // Existing rows survived the table rebuild with every field intact.
  const p = getItem(db, 'p1')!;
  assert.equal(p.title, 'Legacy');
  assert.equal(p.note, 'the note body');
  assert.equal(p.flagged, true);
  assert.equal(p.priority, 2);
  assert.equal(p.due_date, '2026-02-01T00:00:00.000Z');
  assert.equal(p.review_interval, 30);
  assert.equal(p.color, '#abc');
  assert.equal(p.sort_order, 7);
  assert.equal(p.owner_id, 'u1');
  assert.equal(p.estimate_minutes, 45);
  assert.equal(p.order_mode, 'sequential');
  assert.equal(p.folder_id, 'fld1');
  assert.equal(p.sys_kind, 'billing');
  const t = getItem(db, 't1')!;
  assert.equal(t.title, 'child');
  assert.equal(t.status, 'done');
  assert.equal(t.parent_id, 'p1');

  // type='note' now inserts cleanly, both via raw SQL and createItem.
  db.run(
    `INSERT INTO items (id, type, title, status, sort_order, created_at, updated_at, deleted, clocks)
     VALUES ('n1', 'note', 'raw note', 'active', 0, '2026-01-01', '2026-01-01', 0, '{}')`,
  );
  assert.equal(getItem(db, 'n1')?.type, 'note');
  const note = createItem(db, DEV, { type: 'note', title: 'A note' });
  assert.equal(getItem(db, note.id)?.type, 'note');
});

// ----- behavior rules -------------------------------------------------------

test('completing a parent cascade leaves note children untouched', () => {
  const db = openDb();
  const project = createItem(db, DEV, { type: 'project', title: 'P' });
  const task = createItem(db, DEV, { title: 'sub task', parentId: project.id });
  const note = createItem(db, DEV, { type: 'note', title: 'sub note', parentId: project.id });

  setCompletedCascade(db, DEV, project.id);

  assert.equal(getItem(db, task.id)?.status, 'done', 'task child completes');
  const noteAfter = getItem(db, note.id)!;
  assert.equal(noteAfter.type, 'note', 'note stays a note');
  assert.equal(noteAfter.status, 'active', 'note child is not completed');
  assert.equal(noteAfter.completed_at, null);
});

test('a note child does not gate a sequential parent', () => {
  const db = openDb();
  const p = createItem(db, DEV, { type: 'project', title: 'P', orderMode: 'sequential' });
  // A note placed FIRST must not block the task that follows it.
  const note = createItem(db, DEV, { type: 'note', title: 'N', parentId: p.id });
  const a = createItem(db, DEV, { title: 'A', parentId: p.id });
  const b = createItem(db, DEV, { title: 'B', parentId: p.id });

  assert.equal(isBlocked(db, a.id), false, 'first task is available despite the preceding note');
  assert.equal(isBlocked(db, b.id), true, 'the second task is still sequentially blocked');
  // The note itself is never "blocked" in a meaningful sense (it is inert), and it
  // certainly must not gate on a task.
  assert.equal(isBlocked(db, note.id), false);
});

test('an active sub-project still gates a later task sibling in a sequential parent', () => {
  // Regression test for f3d28c1 ("fix(availability): restore note/project behavior in
  // sequencing and filters"): Phase 1 narrowed firstActiveChildId to type==='task', which
  // broke sub-project sequential gating entirely (a sub-project could never be "first").
  // The fix widened it back to type!=='note' — this pins that a non-note, non-task child
  // (a project) still gates exactly like a task would.
  const db = openDb();
  const parent = createItem(db, DEV, { type: 'project', title: 'Parent', orderMode: 'sequential' });
  const sub = createItem(db, DEV, { type: 'project', title: 'Sub-project', parentId: parent.id });
  const b = createItem(db, DEV, { type: 'task', title: 'B', parentId: parent.id });

  assert.equal(isBlocked(db, sub.id), false, 'the active sub-project is first and available');
  assert.equal(isBlocked(db, b.id), true, 'B waits behind the still-active sub-project');

  setCompleted(db, DEV, sub.id, true);
  assert.equal(isBlocked(db, b.id), false, 'B is freed once the sub-project completes');
});

test('notes never appear in today / flagged / inbox', () => {
  const db = openDb();
  // A note that would qualify for every perspective if it were a task: flagged,
  // due today, top-level (inbox-shaped).
  const note = createItem(db, DEV, { type: 'note', title: 'N', flagged: true });
  updateItem(db, DEV, note.id, { due_date: new Date().toISOString(), flagged: true });
  // A control task that DOES qualify, so we know the perspectives aren't just empty.
  const task = createItem(db, DEV, { title: 'T', flagged: true });

  const all = allItems(db);
  const noteIn = (list: { id: string }[]) => list.some((i) => i.id === note.id);
  const taskIn = (list: { id: string }[]) => list.some((i) => i.id === task.id);

  assert.equal(noteIn(today(all)), false, 'note not in Today');
  assert.equal(noteIn(flagged(all)), false, 'note not in Flagged');
  assert.equal(noteIn(inbox(all)), false, 'note not in Inbox');
  // Sanity: the control task lands in all three.
  assert.equal(taskIn(today(all)), true);
  assert.equal(taskIn(flagged(all)), true);
  assert.equal(taskIn(inbox(all)), true);
});

test('recurrence never spawns from a note completed via cascade', () => {
  const db = openDb();
  const project = createItem(db, DEV, { type: 'project', title: 'P' });
  const note = createItem(db, DEV, { type: 'note', title: 'recurring note', parentId: project.id });
  // Give the note a recurrence + due date so that IF it were ever completed, a
  // successor would spawn. The cascade must skip it entirely.
  updateItem(db, DEV, note.id, {
    recurrence: JSON.stringify({ type: 'daily', interval: 1 }),
    due_date: new Date().toISOString(),
  });

  const before = getChildren(db, project.id).length;
  setCompletedCascade(db, DEV, project.id);
  const after = getChildren(db, project.id);

  assert.equal(after.length, before, 'no successor spawned');
  assert.equal(getItem(db, note.id)?.status, 'active', 'note never reached setCompleted');
});

test('conversion task↔note preserves fields; status restored on convert-back', () => {
  const db = openDb();
  const task = createItem(db, DEV, { title: 'T', flagged: true, priority: 3 });
  updateItem(db, DEV, task.id, { status: 'dropped', due_date: '2026-03-01T00:00:00.000Z' });

  // task -> note: only `type` flips; everything else is preserved (inert).
  updateItem(db, DEV, task.id, { type: 'note' });
  let it = getItem(db, task.id)!;
  assert.equal(it.type, 'note');
  assert.equal(it.status, 'dropped', 'status preserved while a note');
  assert.equal(it.flagged, true);
  assert.equal(it.priority, 3);
  assert.equal(it.due_date, '2026-03-01T00:00:00.000Z');

  // note -> task: flipping type back restores the still-present status.
  updateItem(db, DEV, task.id, { type: 'task' });
  it = getItem(db, task.id)!;
  assert.equal(it.type, 'task');
  assert.equal(it.status, 'dropped', 'prior status is restored (never cleared)');
  assert.equal(it.flagged, true);
  assert.equal(it.priority, 3);
});

test('converting a note child to an active task reopens a done parent, just like create/move', () => {
  // Regression test for 46683c4 ("fix(core): preserve parent/task visibility invariants
  // during note conversions"): createItem/moveItem already skip reopenParentIfNeeded for
  // note children (a note can't hide unfinished work), and updateItem was fixed to run it
  // when a note converts back into an active task — otherwise an active task could sit
  // hidden under a still-"done" parent.
  const db = openDb();
  const parent = createItem(db, DEV, { title: 'Parent' });
  setCompleted(db, DEV, parent.id, true);
  assert.equal(getItem(db, parent.id)?.status, 'done');

  const note = createItem(db, DEV, { type: 'note', title: 'N', parentId: parent.id });
  // Adding the note itself must NOT reopen the done parent (notes are inert).
  assert.equal(getItem(db, parent.id)?.status, 'done', 'a note child does not reopen its parent');

  updateItem(db, DEV, note.id, { type: 'task' });
  assert.equal(getItem(db, note.id)?.type, 'task');
  assert.equal(getItem(db, note.id)?.status, 'active');
  assert.equal(getItem(db, parent.id)?.status, 'active', 'parent reopens once the child becomes an active task');
  assert.equal(getItem(db, parent.id)?.completed_at, null);
});

test('queryItems({activeOnly: true}) keeps a note whose preserved status is "done"', () => {
  // A note converted from a completed task keeps its prior status (inert, never
  // cleared — see the conversion test above). The SQL `activeOnly` prefilter used by
  // list views (apps/web/src/lib/listQuery.ts) must not drop it: an "active" view
  // exempts notes from the status check, mirroring the JS-level filter's intent.
  const db = openDb();
  const task = createItem(db, DEV, { title: 'T' });
  setCompleted(db, DEV, task.id, true);
  updateItem(db, DEV, task.id, { type: 'note' });
  assert.equal(getItem(db, task.id)?.status, 'done');

  const activeIds = queryItems(db, { activeOnly: true }).map((i) => i.id);
  assert.ok(activeIds.includes(task.id), 'the done-status note is still returned');

  // A genuinely done TASK is still excluded — the exemption is note-specific.
  const doneTask = createItem(db, DEV, { title: 'Done task' });
  setCompleted(db, DEV, doneTask.id, true);
  const activeIds2 = queryItems(db, { activeOnly: true }).map((i) => i.id);
  assert.ok(!activeIds2.includes(doneTask.id), 'a done task is still excluded');
});

test('setCompleted on a note is a no-op at the function level, even with recurrence set', () => {
  // Defense in depth: notes are inert regardless of caller. Previously only the cascade
  // (setCompletedCascade) guarded notes, leaving setCompleted itself reachable (and
  // recurrence-spawning) for any direct caller — agent ops, sync replay, a future UI
  // path. setCompleted now guards at the function level too.
  const db = openDb();
  const note = createItem(db, DEV, {
    type: 'note',
    title: 'N',
  });
  updateItem(db, DEV, note.id, {
    recurrence: JSON.stringify({ type: 'daily', interval: 1 }),
    due_date: new Date().toISOString(),
  });
  const { item, spawned } = setCompleted(db, DEV, note.id, true);
  assert.equal(spawned, undefined, 'a note never spawns a recurrence successor');
  assert.equal(item?.status, 'active', 'a note\'s status is untouched by setCompleted');
  assert.equal(item?.completed_at, null);
  assert.equal(getItem(db, note.id)?.type, 'note');
});

test('a note child does not reopen a completed parent; a task child does', () => {
  const db = openDb();

  // --- creation path (createItem → reopenParentIfNeeded) ---
  const parent = createItem(db, DEV, { title: 'parent' });
  updateItem(db, DEV, parent.id, { status: 'done', completed_at: new Date().toISOString() });
  assert.equal(getItem(db, parent.id)?.status, 'done');

  // Creating a note child leaves the completed parent completed (inert child).
  createItem(db, DEV, { type: 'note', title: 'note child', parentId: parent.id });
  assert.equal(getItem(db, parent.id)?.status, 'done', 'note child does not reopen parent');

  // Creating a task child reopens it (the existing behavior, still intact).
  createItem(db, DEV, { title: 'task child', parentId: parent.id });
  assert.equal(getItem(db, parent.id)?.status, 'active', 'task child reopens parent');

  // --- move path (moveItem → reopenParentIfNeeded) ---
  const parent2 = createItem(db, DEV, { title: 'parent2' });
  updateItem(db, DEV, parent2.id, { status: 'done', completed_at: new Date().toISOString() });
  const loremNote = createItem(db, DEV, { type: 'note', title: 'floating note' });
  const loremTask = createItem(db, DEV, { title: 'floating task' });

  // Moving a note under the completed parent2 keeps it completed.
  moveItem(db, DEV, loremNote.id, parent2.id);
  assert.equal(getItem(db, parent2.id)?.status, 'done', 'moving a note does not reopen parent');

  // Moving an incomplete task under it reopens it.
  moveItem(db, DEV, loremTask.id, parent2.id);
  assert.equal(getItem(db, parent2.id)?.status, 'active', 'moving a task reopens parent');
});
