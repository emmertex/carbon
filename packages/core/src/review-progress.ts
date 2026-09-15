import { v5 as uuidv5, v4 as uuidv4 } from "uuid";
import type { Db } from "./db";
import type { Item } from "./types";
import type { RecordOp } from "./records";
import { getChildren, getItem, recordRecordOp } from "./repo";

export interface ReviewEntry {
  id: string;
  user_id: string;
  /** The project, used by sync access checks and backfill. */
  item_id: string;
  cycle: string;
  entry_key: string;
  value: Record<string, unknown>;
}
export const reviewEntryId = (
  user: string,
  project: string,
  cycle: string,
  key: string,
): string => uuidv5(JSON.stringify([user, project, cycle, key]), uuidv5.URL);
export const reviewCycle = (project: Item): string =>
  project.reviewed_at ?? project.created_at;

/** Independent entries avoid losing another device's checks when editing offline.
 * Baselines retain the earliest snapshot; other entries use deterministic LWW. */
export function applyReviewEntry(db: Db, op: RecordOp): void {
  const entry = op.data as ReviewEntry;
  if (
    entry.id !== op.row_id ||
    entry.id !==
      reviewEntryId(entry.user_id, entry.item_id, entry.cycle, entry.entry_key)
  )
    throw new Error("Invalid review entry identity");
  const first =
    entry.entry_key.startsWith("baseline:") || entry.entry_key === "started";
  const comparison = first ? "<" : ">";
  db.run(
    `INSERT INTO review_progress (id, user_id, item_id, cycle, entry_key, value, ts, device_id, op_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET value = excluded.value, ts = excluded.ts, device_id = excluded.device_id, op_id = excluded.op_id
    WHERE (excluded.ts, excluded.device_id, excluded.op_id) ${comparison} (review_progress.ts, review_progress.device_id, review_progress.op_id)`,
    [
      entry.id,
      entry.user_id,
      entry.item_id,
      entry.cycle,
      entry.entry_key,
      JSON.stringify(entry.value),
      op.ts,
      op.device_id,
      op.id,
    ],
  );
}
export function writeReviewEntry(
  db: Db,
  dev: string,
  user: string,
  project: Item,
  key: string,
  value: Record<string, unknown>,
): void {
  const cycle = reviewCycle(project);
  const id = reviewEntryId(user, project.id, cycle, key);
  recordRecordOp(db, dev, "review_progress", id, {
    id,
    user_id: user,
    item_id: project.id,
    cycle,
    entry_key: key,
    value,
  } satisfies ReviewEntry);
}
export function readReviewEntries(
  db: Db,
  user: string,
  project: Item,
): Record<string, Record<string, unknown>> {
  const entries = Object.fromEntries(
    db
      .all<{ entry_key: string; value: string }>(
        "SELECT entry_key, value FROM review_progress WHERE user_id = ? AND item_id = ? AND cycle = ?",
        [user, project.id, reviewCycle(project)],
      )
      .map((row) => [row.entry_key, JSON.parse(row.value)]),
  );
  // Concurrent offline starts retain the first session's baseline as a whole.
  const baselinePrefix = `baseline:${entries.started?.session}:`;
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, value]) =>
      key.startsWith("baseline:")
        ? key.startsWith(baselinePrefix)
          ? [[`baseline:${key.slice(baselinePrefix.length)}`, value]]
          : []
        : [[key, value]],
    ),
  ) as Record<string, Record<string, unknown>>;
}

// A compact fingerprint avoids duplicating potentially large notes in review state.
function fingerprint(text: string | null): string {
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < (text?.length ?? 0); i++) {
    const c = text!.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b, 33) ^ c;
  }
  return `${text?.length ?? 0}:${a >>> 0}:${b >>> 0}`;
}
export function reviewSnapshot(item: Item): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    due_date: item.due_date,
    defer_date: item.defer_date,
    parent_id: item.parent_id,
    priority: item.priority,
    flagged: item.flagged,
    estimate_minutes: item.estimate_minutes,
    note: fingerprint(item.note),
    deleted: item.deleted,
    type: item.type,
  };
}
export function reviewItems(db: Db, project: Item): Item[] {
  const items: Item[] = [project];
  const seen = new Set([project.id]);
  for (let i = 0; i < items.length; i++) {
    for (const item of getChildren(db, items[i]!.id)) {
      if (
        seen.has(item.id) ||
        item.type === "project" ||
        item.type === "folder"
      )
        continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}
export function startReview(
  db: Db,
  dev: string,
  user: string,
  project: Item,
): void {
  if (readReviewEntries(db, user, project).started) return;
  db.transaction(() => {
    const session = uuidv4();
    const items = reviewItems(db, project);
    writeReviewEntry(db, dev, user, project, "started", {
      at: new Date().toISOString(),
      session,
      baselineCount: items.length,
    });
    for (const item of items)
      writeReviewEntry(
        db,
        dev,
        user,
        project,
        `baseline:${session}:${item.id}`,
        reviewSnapshot(item),
      );
  });
}
export function hasReviewProgress(
  entries: Record<string, Record<string, unknown>>,
): boolean {
  return (
    !!entries.started ||
    Object.entries(entries).some(
      ([key, value]) =>
        (key.startsWith("check:") || key.startsWith("task:")) &&
        value.checked === true,
    )
  );
}
export interface ReviewChange {
  id: string;
  title: string;
  changes: string[];
}
/** Compare with the initial snapshot, including edits made through the detail pane. */
export function reviewChanges(
  db: Db,
  project: Item,
  entries: Record<string, Record<string, unknown>>,
): ReviewChange[] {
  const current = reviewItems(db, project);
  const ids = new Set(current.map((item) => item.id));
  const result: ReviewChange[] = [];
  const labels: Record<string, string> = {
    title: "Title edited",
    note: "Notes edited",
    due_date: "Due date changed",
    defer_date: "Defer date changed",
    priority: "Priority changed",
    flagged: "Flag changed",
    estimate_minutes: "Estimate changed",
    parent_id: "Moved",
    type: "Type changed",
  };
  for (const [key, before] of Object.entries(entries)) {
    if (!key.startsWith("baseline:")) continue;
    const id = key.slice(9);
    const item = getItem(db, id);
    const changes: string[] = [];
    if (!item || item.deleted) changes.push("Deleted");
    else {
      const after = reviewSnapshot(item);
      if (!ids.has(id)) changes.push("Moved out of project");
      if (before.status !== after.status)
        changes.push(
          item.status === "done"
            ? "Completed"
            : item.status === "dropped"
              ? "Dropped"
              : "Reopened",
        );
      for (const [field, label] of Object.entries(labels))
        if (before[field] !== after[field]) changes.push(label);
    }
    if (changes.length)
      result.push({
        id,
        title: item?.title ?? String(before.title ?? "Untitled task"),
        changes,
      });
  }
  for (const item of current)
    if (!entries[`baseline:${item.id}`])
      result.push({ id: item.id, title: item.title, changes: ["Added"] });
  return result;
}
