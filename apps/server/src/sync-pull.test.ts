import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createItem,
  createUser,
  migrate,
  shareItem,
  updateItem,
} from "@carbon/core";
import { openDb } from "./sqlite";
import { pullSyncPage, type BackfillCursor } from "./sync-pull";

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  const alice = createUser(db, { username: "alice" });
  const bob = createUser(db, { username: "bob" });
  const roots: string[] = [];
  for (let p = 0; p < 4; p++) {
    const proj = createItem(db, "a", {
      type: "project",
      title: `P${p}`,
      ownerId: alice.id,
    });
    if (p % 2 === 0) {
      shareItem(db, "a", proj.id, bob.id, "read");
      roots.push(proj.id);
    }
    for (let t = 0; t < 30; t++) {
      const task = createItem(db, "a", {
        type: "task",
        title: `T${t}`,
        parentId: proj.id,
        ownerId: alice.id,
      });
      updateItem(db, "a", task.id, { title: `T${t}!` });
    }
  }
  return { db, bob, roots };
}

/** Drain to completion with the given limits; returns every op/record id received. */
function drain(
  db: ReturnType<typeof setup>["db"],
  userId: string,
  need: string[],
  limits: () => Parameters<typeof pullSyncPage>[6],
) {
  let since = 0;
  let rsince = 0;
  let pending = [...need];
  let bf: BackfillCursor | undefined;
  const ids: string[] = [];
  let rounds = 0;
  for (;;) {
    rounds++;
    assert.ok(rounds < 10_000, "drain must terminate");
    const page = pullSyncPage(db, userId, since, rsince, pending, bf, limits());
    ids.push(...page.ops.map((o) => o.id), ...page.recordOps.map((o) => o.id));
    since = page.cursor;
    rsince = page.rcursor;
    if (page.backfill?.done) {
      pending = pending.filter((r) => r !== page.backfill!.root);
      bf = undefined;
    } else bf = page.backfill;
    if (!page.truncated && !pending.length) break;
  }
  return { ids: ids.sort(), rounds };
}

test("small-batch and expired-deadline paging deliver exactly the single-page result", () => {
  const { db, bob, roots } = setup();
  const big = { count: 50_000, bytes: 16 << 20, scan: 200_000 };
  const whole = drain(db, bob.id, roots, () => big);
  assert.ok(whole.ids.length > 0);
  // Tiny row budget forces many pages across batch boundaries.
  const paged = drain(db, bob.id, roots, () => ({ ...big, scan: 7 }));
  assert.deepEqual(paged.ids, whole.ids);
  assert.ok(paged.rounds > whole.rounds);
  // A deadline already in the past still reads at least one row per page, so the
  // drain makes progress and stays lossless.
  const timed = drain(db, bob.id, roots, () => ({ ...big, deadline: 0 }));
  assert.deepEqual(timed.ids, whole.ids);
});

test("a generous time budget drains a large shared log in one normal page", () => {
  const { db, bob } = setup();
  const page = pullSyncPage(db, bob.id, 0, 0, [], undefined, {
    count: 50_000,
    bytes: 16 << 20,
    scan: 200_000,
    deadline: Date.now() + 60_000,
  });
  assert.equal(page.truncated, false);
});
