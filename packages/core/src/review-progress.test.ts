import assert from "node:assert/strict";
import { test } from "node:test";
import { openMemoryDb } from "./test-helpers";
import {
  createItem,
  updateItem,
  getItem,
  ingestRecordOps,
  markReviewed,
} from "./repo";
import { getUnsyncedRecordOps } from "./records";
import {
  startReview,
  writeReviewEntry,
  readReviewEntries,
  reviewChanges,
} from "./review-progress";
import { recordOpShapeError } from "./field-shape";
import { rebuildSyncLogFromMaterialization } from "./sync-epoch";
import { migrate } from "./migrate";

test("review migration and writes leave task rows and item op history unchanged", () => {
  const db = openMemoryDb();
  const project = createItem(db, "a", { type: "project", title: "Project" });
  createItem(db, "a", { title: "Child", parentId: project.id });
  const items = db.all("SELECT * FROM items");
  const ops = db.all("SELECT * FROM ops");
  db.exec("DROP TABLE review_progress");
  db.run("UPDATE meta SET value = '23' WHERE key = 'schema_version'");
  assert.equal(migrate(db).to, 24);
  startReview(db, "a", "alice", project);
  writeReviewEntry(db, "a", "alice", project, "check:tasksRelevant", {
    checked: true,
  });
  assert.deepEqual(db.all("SELECT * FROM items"), items);
  assert.deepEqual(db.all("SELECT * FROM ops"), ops);
  for (const op of getUnsyncedRecordOps(db))
    assert.equal(recordOpShapeError(op), null);
});

test("offline checks merge independently, unchecking converges, users and cycles stay separate", () => {
  const a = openMemoryDb(),
    b = openMemoryDb();
  const project = createItem(a, "a", { type: "project", title: "Project" });
  writeReviewEntry(a, "a", "alice", project, "check:first", { checked: true });
  writeReviewEntry(b, "b", "alice", project, "task:second", { checked: true });
  const aOps = getUnsyncedRecordOps(a),
    bOps = getUnsyncedRecordOps(b);
  ingestRecordOps(a, bOps, true);
  ingestRecordOps(b, aOps, true);
  assert.deepEqual(
    readReviewEntries(a, "alice", project),
    readReviewEntries(b, "alice", project),
  );
  writeReviewEntry(b, "b", "alice", project, "check:first", { checked: false });
  ingestRecordOps(a, getUnsyncedRecordOps(b).reverse(), true);
  assert.equal(
    readReviewEntries(a, "alice", project)["check:first"]?.checked,
    false,
  );
  assert.deepEqual(readReviewEntries(a, "bob", project), {});
  markReviewed(a, "a", project.id);
  assert.deepEqual(readReviewEntries(a, "alice", getItem(a, project.id)!), {});
  // A delayed old-cycle write cannot fill in the next cycle's checklist.
  writeReviewEntry(b, "b", "alice", project, "check:late", { checked: true });
  ingestRecordOps(a, getUnsyncedRecordOps(b), true);
  assert.deepEqual(readReviewEntries(a, "alice", getItem(a, project.id)!), {});
});

test("summary includes additions, completed work and sidebar edits and survives log rebuild", () => {
  const db = openMemoryDb();
  const project = createItem(db, "a", { type: "project", title: "Project" });
  const task = createItem(db, "a", { title: "Task", parentId: project.id });
  startReview(db, "a", "alice", project);
  const added = createItem(db, "a", { title: "New child", parentId: task.id });
  updateItem(db, "a", task.id, {
    status: "done",
    note: "Sidebar edit",
    due_date: "2030-01-01T12:00:00.000Z",
  });
  const before = readReviewEntries(db, "alice", project);
  const summary = reviewChanges(db, project, before);
  assert.deepEqual(summary.find((row) => row.id === task.id)?.changes, [
    "Completed",
    "Notes edited",
    "Due date changed",
  ]);
  assert.deepEqual(summary.find((row) => row.id === added.id)?.changes, [
    "Added",
  ]);
  rebuildSyncLogFromMaterialization(db);
  const restored = openMemoryDb();
  const records = db
    .all<any>("SELECT * FROM record_ops")
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  assert.equal(
    ingestRecordOps(restored, records.reverse(), true).skipped.length,
    0,
  );
  assert.deepEqual(readReviewEntries(restored, "alice", project), before);
});

test("concurrent review starts retain one coherent baseline", () => {
  const a = openMemoryDb(),
    b = openMemoryDb();
  const project = createItem(a, "a", { type: "project", title: "Project" });
  startReview(a, "a", "alice", project);
  // Another offline device starts later with different local content.
  createItem(b, "b", { title: "Added later", parentId: project.id });
  startReview(b, "b", "alice", project);
  const first = readReviewEntries(a, "alice", project);
  const aOps = getUnsyncedRecordOps(a),
    bOps = getUnsyncedRecordOps(b);
  ingestRecordOps(a, bOps, true);
  ingestRecordOps(b, aOps.reverse(), true);
  assert.deepEqual(readReviewEntries(a, "alice", project), first);
  assert.deepEqual(readReviewEntries(b, "alice", project), first);
});
