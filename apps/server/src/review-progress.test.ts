import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createItem,
  createUser,
  shareItem,
  writeReviewEntry,
  getUnsyncedRecordOps,
  migrate,
  readReviewEntries,
  type RecordOp,
} from "@carbon/core";
import { openDb } from "./sqlite";
import { validateRecordOp, sessionCredentialFor } from "./authorize";
import { pullSyncPage } from "./sync-pull";
import { validateSyncBody } from "./sync-validate";

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  const alice = createUser(db, { username: "alice" });
  const bob = createUser(db, { username: "bob" });
  const project = createItem(db, "a", {
    type: "project",
    title: "Review",
    ownerId: alice.id,
  });
  shareItem(db, "a", project.id, bob.id, "read");
  writeReviewEntry(db, "a", alice.id, project, "check:tasksRelevant", {
    checked: true,
  });
  const op = getUnsyncedRecordOps(db).find(
    (op) => op.entity === "review_progress",
  )!;
  return { db, alice, bob, project, op };
}
const limits = { count: 100, bytes: 1000000, scan: 1000 };

test("review entries are private and cannot be forged even for a shared project", () => {
  const { db, alice, bob, op } = setup();
  assert.ok(validateRecordOp(db, sessionCredentialFor(alice.id), op));
  assert.equal(validateRecordOp(db, sessionCredentialFor(bob.id), op), null);
  assert.equal(
    validateRecordOp(db, sessionCredentialFor(bob.id), {
      ...op,
      data: { ...(op.data as object), user_id: bob.id },
    }),
    null,
  );
  assert.equal(
    validateRecordOp(db, sessionCredentialFor(alice.id), {
      ...op,
      row_id: "forged",
    }),
    null,
  );
  const peer = pullSyncPage(db, bob.id, 0, 0, [], undefined, limits, 0);
  assert.equal(
    peer.recordOps.some((op) => op.entity === "review_progress"),
    false,
  );
  const own = pullSyncPage(db, alice.id, 0, 0, [], undefined, limits, 0);
  assert.equal(
    own.recordOps.filter((op) => op.entity === "review_progress").length,
    1,
  );
});

test("legacy clients never receive review records; upgraded clients recover them with an independent cursor", () => {
  const { db, alice, project } = setup();
  const legacy = pullSyncPage(
    db,
    alice.id,
    0,
    0,
    [project.id],
    undefined,
    limits,
  );
  assert.equal(
    legacy.recordOps.some((op) => op.entity === "review_progress"),
    false,
  );
  assert.equal(legacy.reviewCursor, undefined);
  assert.ok(legacy.rcursor > 0);
  const upgraded = pullSyncPage(
    db,
    alice.id,
    legacy.cursor,
    legacy.rcursor,
    [],
    undefined,
    limits,
    0,
  );
  assert.equal(
    upgraded.recordOps.filter((op) => op.entity === "review_progress").length,
    1,
  );
  const caughtUp = pullSyncPage(
    db,
    alice.id,
    upgraded.cursor,
    upgraded.rcursor,
    [],
    undefined,
    limits,
    upgraded.reviewCursor,
  );
  assert.equal(caughtUp.recordOps.length, 0);
  assert.ok(
    readReviewEntries(db, alice.id, project)["check:tasksRelevant"].checked,
  );
});

test("bounded review pages do not skip progress entries", () => {
  const { db, alice, project } = setup();
  for (let i = 0; i < 8; i++)
    writeReviewEntry(db, "a", alice.id, project, `task:${i}`, {
      checked: true,
    });
  let since = 0,
    rsince = 0,
    reviewSince = 0;
  const received: RecordOp[] = [];
  for (let i = 0; i < 30; i++) {
    const page = pullSyncPage(
      db,
      alice.id,
      since,
      rsince,
      [],
      undefined,
      { ...limits, count: 2, scan: 5 },
      reviewSince,
    );
    received.push(
      ...page.recordOps.filter((op) => op.entity === "review_progress"),
    );
    since = page.cursor;
    rsince = page.rcursor;
    reviewSince = page.reviewCursor!;
    if (!page.truncated) break;
  }
  assert.equal(received.length, 9);
  assert.equal(new Set(received.map((op) => op.id)).size, 9);
  assert.equal(
    validateSyncBody({ reviewSince: -1 }),
    "reviewSince must be a non-negative number",
  );
  assert.equal(validateSyncBody({ since: 0, rsince: 0 }), null);
});
