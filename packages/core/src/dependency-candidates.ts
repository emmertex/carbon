import type { Db } from './db';
import { getItem, projectAncestor } from './repo';

/** Search only while the picker is open. SQLite computes scope/reachability once;
 * no full item materialization or per-candidate ancestor/cycle query fan-out. */
export function dependencyCandidates(db: Db, itemId: string, direction: 'predecessor' | 'successor', query: string, limit = 8) {
  const projectId = projectAncestor(db, itemId)?.id ?? null;
  const from = direction === 'predecessor' ? 'pred_id' : 'succ_id';
  const to = direction === 'predecessor' ? 'succ_id' : 'pred_id';
  // Pin child expansion to the parent index: the trash index on deleted otherwise
  // makes SQLite scan all live rows for every node in this recursive walk.
  const rows = db.all<{ id: string }>(`WITH RECURSIVE
    scope(id) AS (
      SELECT id FROM items INDEXED BY idx_items_parent WHERE parent_id IS ? AND type != 'project' AND deleted = 0
      UNION SELECT i.id FROM items i INDEXED BY idx_items_parent JOIN scope s ON i.parent_id = s.id WHERE i.type != 'project' AND i.deleted = 0),
    ancestors(id) AS (SELECT ? UNION SELECT i.parent_id FROM items i JOIN ancestors a ON i.id = a.id WHERE i.parent_id IS NOT NULL),
    descendants(id) AS (SELECT ? UNION SELECT i.id FROM items i JOIN descendants d ON i.parent_id = d.id),
    cycles(id) AS (SELECT ? UNION SELECT e.${to} FROM item_deps e JOIN cycles c ON e.${from} = c.id WHERE e.deleted = 0)
    SELECT i.id FROM items i JOIN scope s ON i.id = s.id
    WHERE i.type = 'task' AND i.status != 'done' AND i.deleted = 0
      AND instr(lower(COALESCE(NULLIF(i.title, ''), 'Untitled')), lower(?)) > 0
      AND i.id NOT IN (SELECT id FROM ancestors) AND i.id NOT IN (SELECT id FROM descendants)
      AND i.id NOT IN (SELECT id FROM cycles)
      AND i.id NOT IN (SELECT pred_id FROM item_deps WHERE succ_id = ? AND deleted = 0
                      UNION SELECT succ_id FROM item_deps WHERE pred_id = ? AND deleted = 0)
    ORDER BY i.sort_order, i.created_at, i.id LIMIT ?`,
    [projectId, itemId, itemId, itemId, query.trim(), itemId, itemId, Math.max(1, Math.min(limit, 50))]);
  return rows.map((r) => getItem(db, r.id)!);
}
