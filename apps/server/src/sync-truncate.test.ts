import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { Op, RecordOp } from "@carbon/core";
import { makeTestDb, appFetch, type TestDb } from "./test-app";
import type { FetchApp } from "./tenant";
import type { DeliverToPeer } from "./federation";

/**
 * Sync response-bounds tests (A2) — exercised through the REAL factory with a TINY
 * response cap so a normal-sized push truncates. The invariant under test:
 *   a truncated response advances the cursor ONLY past ops actually sent, and
 *   re-pulling from that cursor drains the remainder with no loss and no dupes.
 * This is the "bounded but lossless" property the client relies on.
 */

const TMP = `/tmp/carbon-a2-truncate-${process.pid}`;
process.env.DATABASE_PATH = `${TMP}/carbon.db`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.BLOBS_DIR = `${TMP}/blobs`;
process.env.CARBON_NO_AUTOSTART = "1";
process.env.ALLOW_OPEN_MODE = "1";
// Tiny caps so a 300-op push truncates at 50.
process.env.SYNC_MAX_RESPONSE_OPS = "50";
process.env.SYNC_MAX_SCAN_ROWS = "1000";

const NO_DELIVERY: DeliverToPeer = async () =>
  new Response(JSON.stringify({ error: "no delivery in test" }), {
    status: 501,
  });

let _realBuild: typeof import("./index").buildTenantApp | null = null;
async function realBuild(): Promise<typeof import("./index").buildTenantApp> {
  if (!_realBuild) _realBuild = (await import("./index")).buildTenantApp;
  return _realBuild;
}

async function realSyncApp(
  db: TestDb,
  deviceId: string,
  vapidPublicKey: string,
): Promise<FetchApp> {
  const build = await realBuild();
  return build(
    {
      id: "default",
      subdomain: "",
      db,
      serverDeviceId: deviceId,
      vapidPublicKey,
      blobsDir: `${TMP}/blobs`,
    },
    NO_DELIVERY,
  );
}

const H = { "Content-Type": "application/json" };

function pushOps(n: number): Op[] {
  const now = Date.now();
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    ops.push({
      id: `t-op-${i}`,
      item_id: `t-item-${i}`,
      ts: now + i,
      device_id: "client-T",
      fields: { type: "task", title: `Task ${i}`, owner_id: null },
    });
  }
  return ops;
}

describe("POST /api/sync — response bounds (truncated, lossless)", () => {
  test("a push beyond the cap truncates, and re-pulling from the cursor drains all with no loss/dupes", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const app = await realSyncApp(db, deviceId, vapidPublicKey);

    const N = 300;
    const pushed = pushOps(N);
    const pushRes = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ syncEpoch: 1, ops: pushed }),
    });
    assert.equal(pushRes.status, 200);
    const pushBody = (await pushRes.json()) as {
      ops: Op[];
      cursor: number;
      recordOps: RecordOp[];
      rcursor: number;
      truncated: boolean;
    };
    // The cap is 50; the push response must truncate.
    assert.ok(pushBody.ops.length <= 50, `got ${pushBody.ops.length}`);
    assert.equal(
      pushBody.truncated,
      true,
      "expected truncated flag on the capped response",
    );

    // Count the first (truncated) batch, then drain: keep pulling from the returned
    // cursor until the server stops truncating.
    const seen = new Set<string>();
    for (const o of pushBody.ops) {
      assert.ok(!seen.has(o.id), `dupe op ${o.id} within the first batch`);
      seen.add(o.id);
    }
    let cursor = pushBody.cursor;
    let rounds = 1;
    for (;;) {
      rounds++;
      const pull = await appFetch(app, "/api/sync", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ syncEpoch: 1, since: cursor }),
      });
      assert.equal(pull.status, 200);
      const pb = (await pull.json()) as {
        ops: Op[];
        cursor: number;
        truncated: boolean;
      };
      for (const o of pb.ops) {
        assert.ok(!seen.has(o.id), `dupe op ${o.id} across truncated rounds`);
        seen.add(o.id);
      }
      if (!pb.truncated) break;
      if (pb.cursor <= cursor)
        throw new Error("cursor did not advance — would spin forever");
      cursor = pb.cursor;
      assert.ok(rounds < 100, "drain did not finish in 100 rounds");
    }
    assert.equal(
      seen.size,
      N,
      `expected all ${N} ops, drained ${seen.size} in ${rounds} rounds`,
    );
  });

  test("the response never exceeds the op cap in a single round", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const app = await realSyncApp(db, deviceId, vapidPublicKey);
    const pushRes = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ syncEpoch: 1, ops: pushOps(500) }),
    });
    const pb = (await pushRes.json()) as {
      ops: Op[];
      recordOps: RecordOp[];
      truncated: boolean;
    };
    assert.ok(
      pb.ops.length + pb.recordOps.length <= 50,
      "single response within the cap",
    );
    assert.equal(pb.truncated, true);
  });

  test("a malformed push is rejected with 400 and nothing is ingested", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const app = await realSyncApp(db, deviceId, vapidPublicKey);
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [{ id: "bad", item_id: 123 }],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "invalid_sync_body");
    assert.match(body.detail, /item_id/);
    // Nothing ingested: a pull from 0 is empty.
    const pull = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ syncEpoch: 1, since: 0 }),
    });
    const pb = (await pull.json()) as { ops: Op[] };
    assert.equal(pb.ops.length, 0, "rejected push must not be ingested");
  });
});

test("late shared subtree backfill resumes beyond every cap and tags do not replay forever", async () => {
  const { shareItem, createUser, createItem, recordRecordOp } =
    await import("@carbon/core");
  const { createSession } = await import("./auth");
  const ctx = makeTestDb();
  const owner = createUser(ctx.db, { username: "backfill-owner" });
  const reader = createUser(ctx.db, { username: "backfill-reader" });
  const root = createItem(ctx.db, "d", {
    title: "root",
    type: "project",
    ownerId: owner.id,
  });
  const children = Array.from({ length: 130 }, (_, i) =>
    createItem(ctx.db, "d", {
      title: `child-${i}`,
      parentId: root.id,
      ownerId: owner.id,
    }),
  );
  const stamp = new Date().toISOString();
  for (let i = 0; i < 80; i++)
    recordRecordOp(ctx.db, "d", "tag", `tag-${i}`, {
      id: `tag-${i}`,
      name: `tag-${i}`,
      created_at: stamp,
      updated_at: stamp,
      deleted: false,
    });
  const since = ctx.db.get<{ n: number }>("SELECT MAX(rowid) n FROM ops")!.n;
  const rsince = ctx.db.get<{ n: number }>(
    "SELECT MAX(rowid) n FROM record_ops",
  )!.n;
  shareItem(ctx.db, "d", root.id, reader.id, "read");
  const app = await realSyncApp(ctx.db, ctx.deviceId, ctx.vapidPublicKey);
  const token = createSession(ctx.db, reader.id);
  let body: Record<string, unknown> = { since, rsince, need: [root.id] };
  const seen = new Set<string>();
  let done = false;
  for (let round = 0; round < 20; round++) {
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    const page = (await res.json()) as {
      ops: Op[];
      recordOps: RecordOp[];
      cursor: number;
      rcursor: number;
      backfill?: { done: boolean };
    };
    assert.ok(page.ops.length + page.recordOps.length <= 50);
    for (const op of page.ops) seen.add(op.item_id);
    if (page.backfill?.done) {
      done = true;
      body = { since: page.cursor, rsince: page.rcursor };
      break;
    }
    body = {
      ...body,
      since: page.cursor,
      rsince: page.rcursor,
      backfill: page.backfill,
    };
  }
  assert.ok(done);
  assert.ok(
    children.every((child) => seen.has(child.id)),
    "every unseen child eventually backfilled",
  );
  const idle = await appFetch(app, "/api/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const page = (await idle.json()) as {
    recordOps: unknown[];
    truncated: boolean;
  };
  assert.deepEqual(page.recordOps, []);
  assert.equal(page.truncated, false);
});
