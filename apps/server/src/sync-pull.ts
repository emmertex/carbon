import {
  getItem,
  hasReadAccess,
  type Db,
  type Op,
  type RecordOp,
} from "@carbon/core";
import { legacyRecordData } from "./sync-legacy";

export interface BackfillCursor {
  root: string;
  cursor: number;
  rcursor: number;
  done?: boolean;
}

/** Rows of log metadata fetched per SQL round trip while scanning. */
const SCAN_BATCH = 512;

/** Bounded, resumable log scans. Backfill uses a separate high-water cursor over
 * the logs and tests ancestry per candidate; it never materializes full subtrees
 * or entire item histories. Tags travel through the ordinary record cursor.
 *
 * Budget: `limits.scan` caps metadata rows read across the whole page, and
 * `limits.deadline` (epoch ms) stops the scan once wall time runs out — so a large
 * log drains in a few time-boxed rounds instead of many tiny fixed-row ones. At
 * least one row is always read so every page makes progress. Visibility and
 * ancestry answers are memoized for the request: a log revisits the same items
 * many times, and each uncached answer is a recursive share/ancestry query. */
export function pullSyncPage(
  db: Db,
  userId: string,
  since: number,
  rsince: number,
  need: string[],
  backfill: BackfillCursor | undefined,
  limits: { count: number; bytes: number; scan: number; deadline?: number },
  reviewSince?: number,
) {
  const ops: Op[] = [];
  const recordOps: RecordOp[] = [];
  let bytes = 0;
  let truncated = false;
  let scans = 0;
  const open = userId === "local";
  const visibility = new Map<string, boolean>();
  const visible = (id: string) => {
    if (open) return true;
    let v = visibility.get(id);
    if (v === undefined) {
      v = hasReadAccess(db, id, userId);
      visibility.set(id, v);
    }
    return v;
  };
  // Only one backfill root per page, so one memo suffices: every node on a walked
  // path shares the walk's answer (descendant of root, or not).
  const rootedMemo = new Map<string, boolean>();
  const rooted = (id: string, root: string): boolean => {
    const seen: string[] = [];
    const seenSet = new Set<string>();
    let next: string | null = id;
    let found = false;
    while (next && !seenSet.has(next) && seenSet.size < limits.scan) {
      if (next === root) {
        found = true;
        break;
      }
      const known = rootedMemo.get(next);
      if (known !== undefined) {
        found = known;
        break;
      }
      seen.push(next);
      seenSet.add(next);
      next = getItem(db, next)?.parent_id ?? null;
    }
    for (const n of seen) rootedMemo.set(n, found);
    return found;
  };
  const outOfBudget = () =>
    scans >= limits.scan ||
    (scans > 0 &&
      limits.deadline !== undefined &&
      Date.now() > limits.deadline);
  const scan = (
    table: "ops" | "record_ops",
    start: number,
    root?: string,
    reviewOnly = false,
  ) => {
    let cursor = start;
    let done = false;
    const column = table === "ops" ? "fields" : "data";
    type Meta = {
      seq: number;
      size: number;
      item_id: string | null;
      entity?: string;
      user_id?: string;
    };
    let batch: Meta[] = [];
    let at = 0;
    let exhausted = false;
    for (;;) {
      if (at >= batch.length && exhausted) {
        done = true;
        break;
      }
      if (outOfBudget()) break;
      if (at >= batch.length) {
        // Fetch metadata first so an oversized historical value is never buffered.
        const want = Math.min(SCAN_BATCH, limits.scan - scans);
        batch = db.all<Meta>(
          `SELECT rowid AS seq, length(CAST(${column} AS BLOB)) AS size, ${table === "ops" ? "item_id" : "entity, json_extract(data, '$.item_id') AS item_id, json_extract(data, '$.user_id') AS user_id"} FROM ${table} WHERE rowid > ? ${reviewOnly ? "AND entity = 'review_progress'" : ""} ORDER BY rowid LIMIT ?`,
          [cursor, want],
        );
        at = 0;
        exhausted = batch.length < want;
        if (!batch.length) {
          done = true;
          break;
        }
      }
      const meta = batch[at++];
      scans++;
      const itemId = meta.item_id;
      const personal = [
        "setting",
        "plan",
        "timelog",
        "review_progress",
      ].includes(meta.entity ?? "");
      const allowed =
        table === "ops"
          ? !!itemId && visible(itemId)
          : open ||
            (personal
              ? meta.user_id === userId &&
                (meta.entity !== "review_progress" ||
                  (!!itemId && visible(itemId)))
              : meta.entity === "tag" ||
                meta.user_id === userId ||
                (itemId && visible(itemId)));
      const supported =
        meta.entity !== "review_progress" ||
        reviewOnly ||
        (root && reviewSince !== undefined);
      if (
        !supported ||
        !allowed ||
        (root && (!itemId || !rooted(itemId, root)))
      ) {
        cursor = meta.seq;
        continue;
      }
      if (ops.length + recordOps.length >= limits.count) break;
      if (meta.size + 512 > limits.bytes)
        throw new Error(
          `Stored sync operation ${table}:${meta.seq} exceeds the response byte limit; reduce or repair this record on the server`,
        );
      if (bytes + meta.size + 512 > limits.bytes) break;
      const row = db.get<Record<string, string | number>>(
        `SELECT * FROM ${table} WHERE rowid = ?`,
        [meta.seq],
      )!;
      const data = JSON.parse(String(row[column]));
      if (allowed && (!root || (itemId && rooted(itemId, root)))) {
        const entry =
          table === "ops"
            ? {
                id: String(row.id),
                item_id: String(row.item_id),
                ts: Number(row.ts),
                device_id: String(row.device_id),
                fields: data,
              }
            : {
                id: String(row.id),
                entity: String(row.entity),
                row_id: String(row.row_id),
                ts: Number(row.ts),
                device_id: String(row.device_id),
                data: legacyRecordData(String(row.entity), data),
              };
        const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
        if (bytes + size > limits.bytes) break;
        bytes += size;
        if (table === "ops") ops.push(entry as Op);
        else recordOps.push(entry as RecordOp);
      }
      cursor = meta.seq;
    }
    if (!done) truncated = true;
    return { cursor, done };
  };
  const normal = scan("ops", since);
  const records = scan("record_ops", rsince);
  const review =
    reviewSince === undefined
      ? undefined
      : scan("record_ops", reviewSince, undefined, true);
  const root = need[0];
  let nextBackfill: BackfillCursor | undefined;
  if (root) {
    if (!visible(root))
      nextBackfill = { root, cursor: 0, rcursor: 0, done: true };
    else {
      const previous = backfill?.root === root ? backfill : undefined;
      const items = scan("ops", previous?.cursor ?? 0, root);
      const recs = scan("record_ops", previous?.rcursor ?? 0, root);
      nextBackfill = {
        root,
        cursor: items.cursor,
        rcursor: recs.cursor,
        done: items.done && recs.done,
      };
    }
  }
  return {
    ops,
    recordOps,
    cursor: normal.cursor,
    rcursor: records.cursor,
    ...(review ? { reviewCursor: review.cursor } : {}),
    truncated,
    backfill: nextBackfill,
  };
}
