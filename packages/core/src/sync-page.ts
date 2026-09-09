import type { Db } from "./db";
import type { Op } from "./types";
import type { RecordOp } from "./records";

/** SQL-bounded pending selection. Inspect lengths before loading JSON, then count
 * actual UTF-8 wire bytes. Oversized entries remain pending with an actionable error. */
export function pendingSyncPage(
  db: Db,
  limit = 2500,
  maxBytes = 8 * 1024 * 1024,
  after = { ops: 0, recordOps: 0 },
): {
  ops: Op[];
  recordOps: RecordOp[];
  hasMore: boolean;
  next: { ops: number; recordOps: number };
  oversized: string[];
} {
  const ops: Op[] = [];
  const recordOps: RecordOp[] = [];
  const next = { ...after };
  const oversized: string[] = [];
  let bytes = 64;
  let hasMore = false;
  for (const table of ["ops", "record_ops"] as const) {
    const column = table === "ops" ? "fields" : "data";
    const rows = db.all<{ seq: number; id: string; bytes: number }>(
      `SELECT rowid AS seq, id, length(CAST(${column} AS BLOB)) AS bytes FROM ${table} WHERE synced = 0 AND rowid > ? ORDER BY rowid LIMIT ?`,
      [table === "ops" ? after.ops : after.recordOps, limit + 1],
    );
    for (const [i, row] of rows.entries()) {
      if (i >= limit) {
        hasMore = true;
        break;
      }
      if (row.bytes + 512 > maxBytes) {
        if (ops.length || recordOps.length) {
          hasMore = true;
          break;
        }
        oversized.push(row.id);
        if (table === "ops") next.ops = row.seq;
        else next.recordOps = row.seq;
        continue;
      }
      if (bytes + row.bytes + 512 > maxBytes) {
        hasMore = true;
        break;
      }
      const stored = db.get<Record<string, string | number>>(
        `SELECT * FROM ${table} WHERE id = ?`,
        [row.id],
      )!;
      const entry =
        table === "ops"
          ? ({
              id: stored.id,
              item_id: stored.item_id,
              ts: stored.ts,
              device_id: stored.device_id,
              fields: JSON.parse(String(stored.fields)),
            } as Op)
          : ({
              id: stored.id,
              entity: stored.entity,
              row_id: stored.row_id,
              ts: stored.ts,
              device_id: stored.device_id,
              data: JSON.parse(String(stored.data)),
            } as RecordOp);
      const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
      if (bytes + size > maxBytes) {
        hasMore = true;
        break;
      }
      bytes += size;
      if (table === "ops") next.ops = row.seq;
      else next.recordOps = row.seq;
      if (table === "ops") ops.push(entry as Op);
      else recordOps.push(entry as RecordOp);
    }
  }
  return { ops, recordOps, hasMore, next, oversized };
}
