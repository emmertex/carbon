import { getItem, type Db, type Item, type SqlValue } from "@carbon/core";

export function taskPage(
  db: Db,
  userId: string,
  unrestricted: boolean,
  query: {
    projectIds?: string[] | null;
    perspective?: string;
    project?: string;
    status?: string;
    limit: number;
    offset: number;
  },
  maxBytes = 16 * 1024 * 1024,
) {
  const params: SqlValue[] = unrestricted ? [] : [userId, userId];
  let visibility = unrestricted
    ? ""
    : `WITH RECURSIVE visible(id) AS (
    SELECT id FROM items WHERE owner_id = ? UNION SELECT item_id FROM shares WHERE user_id = ? AND deleted = 0
    UNION SELECT i.id FROM items i JOIN visible v ON i.parent_id = v.id) `;
  const where = [
    "deleted = 0",
    "type = 'task'",
    ...(unrestricted ? [] : ["id IN (SELECT id FROM visible)"]),
  ];
  if (query.projectIds != null) {
    const roots = query.projectIds;
    const cte = `key_visible(id) AS (
      SELECT id FROM items WHERE deleted = 0 AND id IN (${roots.map(() => '?').join(',') || 'NULL'})
      UNION SELECT i.id FROM items i JOIN key_visible k ON i.parent_id = k.id WHERE i.deleted = 0) `;
    visibility = visibility ? visibility.trimEnd() + ', ' + cte : 'WITH RECURSIVE ' + cte;
    params.push(...roots);
    where.push('id IN (SELECT id FROM key_visible)');
  }
  if (query.perspective === "inbox")
    where.push("status = 'active'", "parent_id IS NULL");
  if (query.perspective === "flagged")
    where.push("status = 'active'", "flagged = 1");
  if (query.perspective === "today") {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    where.push(
      "status = 'active'",
      "(defer_date IS NULL OR julianday(defer_date) <= julianday(?))",
      "(flagged = 1 OR julianday(due_date) <= julianday(?))",
    );
    params.push(new Date().toISOString(), end.toISOString());
  }
  if (query.project) {
    where.push("parent_id = ?");
    params.push(query.project);
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  const filter = where.join(" AND ");
  const total = db.get<{ n: number }>(
    `${visibility}SELECT COUNT(*) AS n FROM items WHERE ${filter}`,
    params,
  )!.n;
  const columns = ["note", "metadata", "geo", "recurrence", "thumb", "title"];
  const rows = db.all<{ id: string; size: number }>(
    `${visibility}SELECT id,
    ${columns.map((c) => `COALESCE(length(CAST(${c} AS BLOB)),0)`).join(" + ")} AS size
    FROM items WHERE ${filter} ORDER BY sort_order, created_at, id LIMIT ? OFFSET ?`,
    [...params, query.limit, query.offset],
  );
  const tasks: Item[] = [];
  let bytes = 1024;
  for (const row of rows) {
    if (row.size + 4096 > maxBytes) {
      if (tasks.length) break;
      throw new Error(
        `Task ${row.id} exceeds the list response limit; fetch it individually or reduce its content`,
      );
    }
    if (bytes + row.size + 4096 > maxBytes) break;
    const item = getItem(db, row.id)!;
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > maxBytes) break;
    tasks.push(item);
    bytes += size;
  }
  const has_more = query.offset + tasks.length < total;
  return {
    tasks,
    total,
    limit: query.limit,
    offset: query.offset,
    has_more,
    next_offset: has_more ? query.offset + tasks.length : null,
  };
}
