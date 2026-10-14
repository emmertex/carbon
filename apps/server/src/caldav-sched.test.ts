/**
 * CalDAV orchestration: runSync never rejects (callers fire-and-forget it), and the
 * scheduler skips a project whose sync is already queued or running.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, createItem } from "@carbon/core";
import { openDb } from "./sqlite";
import {
  ensureCaldavTables,
  ensureCaldavDeviceId,
  upsertCaldavConfig,
  runSync,
  syncDueProjects,
  isSyncQueued,
} from "./caldav";

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  ensureCaldavTables(db);
  const dev = ensureCaldavDeviceId(db);
  const project = createItem(db, dev, { type: "project", title: "P" });
  // Port 9 (discard) on loopback: the sync fails fast without real network.
  upsertCaldavConfig(db, project.id, {
    username: "u",
    password: "p",
    todo_url: "http://127.0.0.1:9/cal/",
    sync_tasks: true,
  });
  return { db, dev, projectId: project.id };
}

test("runSync resolves (does not reject) when the DB read itself throws", async () => {
  const { db, dev, projectId } = setup();
  db.raw.close(); // getCaldavConfigRow now throws
  const r = await runSync(db, dev, projectId, true);
  assert.equal(r.pulled, 0);
  assert.equal(r.errors.length, 1);
});

test("a finished sync is removed from the per-project queue", async () => {
  const { db, dev, projectId } = setup();
  await runSync(db, dev, projectId, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(isSyncQueued(projectId), false);
});

test("syncDueProjects skips a project whose sync is already queued/running", async () => {
  const { db, dev, projectId } = setup();
  const t = { db, deviceId: dev, allowPrivate: true };
  const manual = runSync(db, dev, projectId, true);
  assert.equal(isSyncQueued(projectId), true);
  assert.equal(await syncDueProjects(t), 0);
  await manual;
  await new Promise((r) => setImmediate(r));
  // last_sync_at was just set, so it's not due now — but it IS due an hour later.
  assert.equal(await syncDueProjects(t, Date.now() + 2 * 3600_000), 1);
});
