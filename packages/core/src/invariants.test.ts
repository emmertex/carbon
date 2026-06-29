/**
 * Data integrity invariants: CRDT commutativity / idempotency, schema migration
 * safety, task-dependency cycle detection, and recurrence monotonicity.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createItem,
  updateItem,
  getItem,
  allItems,
  ingestOps,
  createTag,
  moveTag,
  setItemDepLink,
  depWouldCycle,
  setCompleted,
  parseRecurrence,
  nextOccurrence,
  isBlocked,
  type Op,
  type Db,
  type SqlParams,
} from './index';
import { openMemoryDb } from './test-helpers';
import { migrate } from './migrate';

// ─── CRDT commutativity ──────────────────────────────────────────────────────

/** Apply ops in the given order to a fresh DB; return the final title of itemId. */
function applyAndRead(ops: Op[], itemId: string): string | undefined {
  const db = openMemoryDb();
  ingestOps(db, ops, false);
  return getItem(db, itemId)?.title;
}

/** Simple deterministic shuffle (LCG, in-place copy). */
function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('CRDT commutativity', () => {
  test('all op orderings produce the same final title (LWW)', () => {
    const itemId = 'commutativity-item';
    const now = 1_750_000_000_000;
    // B has the highest ts and wins LWW for title.
    const ops: Op[] = [
      { id: 'op-create', item_id: itemId, ts: now,     device_id: 'A', fields: { type: 'task', title: 'Original', owner_id: null } },
      { id: 'op-B',      item_id: itemId, ts: now + 2, device_id: 'B', fields: { title: 'From B' } },
      { id: 'op-C',      item_id: itemId, ts: now + 1, device_id: 'C', fields: { title: 'From C' } },
    ];
    const expected = 'From B';

    for (let seed = 1; seed <= 20; seed++) {
      const result = applyAndRead(shuffle(ops, seed), itemId);
      assert.equal(result, expected, `ordering seed=${seed} gave "${result}", expected "${expected}"`);
    }
  });

  test('50 random orderings all converge to the same winner', () => {
    const itemId = 'fifty-orderings';
    const now = 2_000_000_000_000;
    const ops: Op[] = Array.from({ length: 5 }, (_, i) => ({
      id: `op-${i}`,
      item_id: itemId,
      ts: now + i,                        // op-4 wins (highest ts)
      device_id: `dev-${i}`,
      fields: { type: 'task', title: `Title ${i}`, owner_id: null } as Record<string, unknown>,
    }));
    const expected = applyAndRead(ops, itemId); // canonical order → winner
    for (let seed = 1; seed <= 50; seed++) {
      const result = applyAndRead(shuffle(ops, seed), itemId);
      assert.equal(result, expected, `seed ${seed}: got "${result}", expected "${expected}"`);
    }
  });
});

// ─── CRDT idempotency ────────────────────────────────────────────────────────

describe('CRDT idempotency', () => {
  test('replaying the same ops twice leaves state unchanged', () => {
    const itemId = 'idempotency-item';
    const now = 1_750_000_001_000;
    const ops: Op[] = [
      { id: 'op-1', item_id: itemId, ts: now,     device_id: 'A', fields: { type: 'task', title: 'Once', owner_id: null } },
      { id: 'op-2', item_id: itemId, ts: now + 1, device_id: 'A', fields: { title: 'Twice' } },
    ];
    const db = openMemoryDb();
    ingestOps(db, ops, false);
    const after1 = getItem(db, itemId);
    ingestOps(db, ops, false); // replay
    const after2 = getItem(db, itemId);
    assert.deepEqual(after1, after2, 'state must be identical after replay');
  });

  test('single op replayed 10 times is idempotent', () => {
    const db = openMemoryDb();
    const op: Op = {
      id: 'unique-id',
      item_id: 'idem-item',
      ts: 999,
      device_id: 'dev',
      fields: { type: 'task', title: 'Stable', owner_id: null },
    };
    for (let i = 0; i < 10; i++) ingestOps(db, [op], false);
    const items = allItems(db).filter((i) => i.id === 'idem-item');
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, 'Stable');
  });
});

// ─── schema migration idempotency ────────────────────────────────────────────

describe('schema migration idempotency', () => {
  function freshDb(): Db {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = OFF');
    return {
      run: (sql: string, p: SqlParams = []) => { sqlite.prepare(sql).run(...p); },
      all: <T>(sql: string, p: SqlParams = []) => sqlite.prepare(sql).all(...p) as T[],
      get: <T>(sql: string, p: SqlParams = []) => sqlite.prepare(sql).get(...p) as T | undefined,
      exec: (sql: string) => sqlite.exec(sql),
      transaction: <T>(fn: () => T): T => {
        sqlite.exec('BEGIN');
        try { const r = fn(); sqlite.exec('COMMIT'); return r; }
        catch (e) { sqlite.exec('ROLLBACK'); throw e; }
      },
    };
  }

  test('running migrate twice on the same DB is safe', () => {
    const db = freshDb();
    migrate(db);
    assert.doesNotThrow(() => migrate(db), 'second migrate must not throw');
    const count = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM meta WHERE key = 'schema_version'`)?.n ?? 0;
    assert.equal(count, 1, 'schema_version must appear exactly once');
  });

  test('data survives a second migrate call', () => {
    const db = freshDb();
    migrate(db);
    const dev = 'dev';
    const item = createItem(db, dev, { type: 'task', title: 'Survivor' });
    migrate(db); // must not wipe data
    assert.equal(getItem(db, item.id)?.title, 'Survivor');
  });
});

// ─── tag hierarchy integrity (path-based) ────────────────────────────────────

describe('tag path hierarchy', () => {
  test('path-based parent is always a shorter prefix', () => {
    const db = openMemoryDb();
    const dev = 'dev';
    // Create a 3-level hierarchy via path names
    const root = createTag(db, dev, 'work');
    const child = createTag(db, dev, 'work:design');
    const grandchild = createTag(db, dev, 'work:design:ui');
    // Verify each tag's name is a proper extension of its parent
    assert.ok(child.name.startsWith(root.name + ':'), 'child has parent prefix');
    assert.ok(grandchild.name.startsWith(child.name + ':'), 'grandchild has child prefix');
  });

  test('moveTag renames the tag and its subtree', () => {
    const db = openMemoryDb();
    const dev = 'dev';
    createTag(db, dev, 'old');
    createTag(db, dev, 'old:sub');
    // Move the whole subtree under a new name
    const src = db.get<{ id: string }>('SELECT id FROM tags WHERE name = ?', ['old'])!;
    moveTag(db, dev, src.id, 'new');
    // 'old' should be gone, 'new' and 'new:sub' should exist
    const names = db.all<{ name: string }>('SELECT name FROM tags WHERE deleted = 0').map((r) => r.name);
    assert.ok(!names.includes('old'), 'old tag should be tombstoned');
    assert.ok(names.includes('new'), 'new root exists');
    assert.ok(names.includes('new:sub'), 'subtag was renamed');
  });
});

// ─── task dependency cycle detection ─────────────────────────────────────────

describe('dependency cycle detection', () => {
  test('depWouldCycle catches A→B→A', () => {
    const db = openMemoryDb();
    const dev = 'dev';
    const a = createItem(db, dev, { type: 'task', title: 'A' });
    const b = createItem(db, dev, { type: 'task', title: 'B' });
    setItemDepLink(db, dev, a.id, b.id, false); // A blocks B
    // B→A would create A→B→A cycle
    assert.ok(depWouldCycle(db, b.id, a.id), 'B→A should form a cycle');
    // A→B again is not a cycle (already exists)
    assert.ok(!depWouldCycle(db, a.id, b.id), 'A→B already exists — not a new cycle');
  });

  test('depWouldCycle catches transitive cycle A→B→C→A', () => {
    const db = openMemoryDb();
    const dev = 'dev';
    const a = createItem(db, dev, { type: 'task', title: 'A' });
    const b = createItem(db, dev, { type: 'task', title: 'B' });
    const c = createItem(db, dev, { type: 'task', title: 'C' });
    setItemDepLink(db, dev, a.id, b.id, false); // A blocks B
    setItemDepLink(db, dev, b.id, c.id, false); // B blocks C
    assert.ok(depWouldCycle(db, c.id, a.id), 'C→A closes the cycle A→B→C→A');
  });

  test('non-cyclic dep does not trigger the guard', () => {
    const db = openMemoryDb();
    const dev = 'dev';
    const a = createItem(db, dev, { type: 'task', title: 'A' });
    const b = createItem(db, dev, { type: 'task', title: 'B' });
    const c = createItem(db, dev, { type: 'task', title: 'C' });
    setItemDepLink(db, dev, a.id, b.id, false);
    // A→C is fine (no cycle)
    assert.ok(!depWouldCycle(db, a.id, c.id));
    // B→C is fine
    assert.ok(!depWouldCycle(db, b.id, c.id));
  });
});

// ─── availability monotonicity ───────────────────────────────────────────────

describe('availability monotonicity', () => {
  test('completing a blocking task unblocks its sequential successor', () => {
    const db = openMemoryDb();
    const dev = 'dev';
    const project = createItem(db, dev, { type: 'project', title: 'P', orderMode: 'sequential' });
    const first = createItem(db, dev, { type: 'task', title: 'First', parentId: project.id });
    const second = createItem(db, dev, { type: 'task', title: 'Second', parentId: project.id });

    assert.ok(isBlocked(db, second.id), 'second blocked while first is active');
    setCompleted(db, dev, first.id, true);
    assert.ok(!isBlocked(db, second.id), 'second unblocked once first is done');
  });

  test('completing a blocker never reduces available task count', () => {
    const db = openMemoryDb();
    const dev = 'dev';
    const project = createItem(db, dev, { type: 'project', title: 'P', orderMode: 'sequential' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(createItem(db, dev, { type: 'task', title: `T${i}`, parentId: project.id }).id);
    }
    const available = () => ids.filter((id) => !isBlocked(db, id)).length;
    const before = available();
    setCompleted(db, dev, ids[0]!, true); // complete the first (blocker)
    const after = available();
    assert.ok(after >= before, `available tasks must not decrease: before=${before} after=${after}`);
  });
});

// ─── recurrence monotonicity ─────────────────────────────────────────────────

describe('recurrence monotonicity', () => {
  const rules: Array<{ label: string; rule: import('./types').RecurrenceRule }> = [
    { label: 'daily',       rule: { type: 'daily',   interval: 1 } },
    { label: 'weekly',      rule: { type: 'weekly',  interval: 1 } },
    { label: 'monthly',     rule: { type: 'monthly', interval: 1 } },
    { label: 'yearly',      rule: { type: 'yearly',  interval: 1 } },
    { label: 'daily×3',     rule: { type: 'daily',   interval: 3 } },
    { label: 'weekly×2',    rule: { type: 'weekly',  interval: 2, daysOfWeek: [1, 3, 5] } },
  ];

  for (const { label, rule } of rules) {
    test(`nextOccurrence always returns a date after 'from': ${label}`, () => {
      const from = new Date('2026-01-15T10:00:00.000Z');
      const next = nextOccurrence(rule, from);
      assert.ok(next !== null, `should produce a next occurrence for ${label}`);
      assert.ok(next!.getTime() > from.getTime(), `${label}: next (${next}) must be after from (${from.toISOString()})`);
    });
  }

  test('nextOccurrence is monotone over 10 daily steps', () => {
    const rule: import('./types').RecurrenceRule = { type: 'daily', interval: 1 };
    let current = new Date('2026-01-01T12:00:00.000Z');
    for (let i = 0; i < 10; i++) {
      const next = nextOccurrence(rule, current);
      assert.ok(next !== null, `step ${i}: should have a next occurrence`);
      assert.ok(next!.getTime() > current.getTime(), `step ${i}: not monotone`);
      current = next!;
    }
  });
});
