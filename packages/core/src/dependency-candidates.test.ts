import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { createItem, setItemDepLink, allItems, projectAncestor, isLineage, depWouldCycle } from './repo';
import { dependencyCandidates } from './dependency-candidates';

test('paged dependency search matches lineage, project and cycle rules in both directions', () => {
  const db = openMemoryDb();
  const p = createItem(db, 'd', { type: 'project', title: 'p' });
  const a = createItem(db, 'd', { title: 'a', parentId: p.id });
  const b = createItem(db, 'd', { title: 'b', parentId: p.id });
  const c = createItem(db, 'd', { title: 'c', parentId: p.id });
  createItem(db, 'd', { title: 'child', parentId: a.id });
  createItem(db, 'd', { title: 'outside' });
  createItem(db, 'd', { title: 'available', parentId: p.id });
  setItemDepLink(db, 'd', a.id, b.id, false);
  setItemDepLink(db, 'd', b.id, c.id, false);
  for (const direction of ['predecessor', 'successor'] as const) {
    const expected = allItems(db).filter((t) => t.type === 'task' && t.id !== a.id && t.id !== b.id &&
      t.status !== 'done' && projectAncestor(db, t.id)?.id === p.id && !isLineage(db, t.id, a.id) &&
      !(direction === 'predecessor' ? depWouldCycle(db, t.id, a.id) : depWouldCycle(db, a.id, t.id))).map((t) => t.id).sort();
    assert.deepEqual(dependencyCandidates(db, a.id, direction, '', 50).map((t) => t.id).sort(), expected);
  }
});

test('100k historical workspace materializes only the matching candidate page', () => {
  const db = openMemoryDb();
  const p = createItem(db, 'd', { type: 'project', title: 'p' });
  const current = createItem(db, 'd', { title: 'current', parentId: p.id });
  db.run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 100000)
    INSERT INTO items(id,parent_id,type,title,status,created_at,updated_at)
    SELECT 'bulk-'||x, ?, 'task', 'Task '||x, CASE WHEN x <= 10000 THEN 'active' ELSE 'done' END,
      '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM n`, [p.id]);
  let rows = 0;
  const read = { ...db, all<T>(sql: string, params?: Parameters<typeof db.all>[1]) {
    const result = db.all<T>(sql, params); rows += result.length; return result;
  } };
  const candidates = dependencyCandidates(read, current.id, 'predecessor', 'Task 999');
  assert.ok(candidates.length > 0 && candidates.length <= 8);
  assert.ok(candidates.every((t) => t.status === 'active'));
  assert.ok(rows <= 8, `only candidate IDs cross the SQL/JS boundary, got ${rows}`);
});
