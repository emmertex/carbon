import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { createItem, type Op, type RecordOp } from "@carbon/core";
import { oversizedSyncArray, MAX_SYNC_BATCH } from "./sync-guard";
import { makeTestDb, appFetch, type TestDb } from "./test-app";
import type { FetchApp } from "./tenant";
import type { DeliverToPeer } from "./federation";

/**
 * Sync route tests — exercised through the REAL application factory (`buildTenantApp`
 * in index.ts), i.e. the same per-tenant route table and middleware a production
 * tenant app runs: the path-specific body-limit middleware, `basicAuth` (Basic is
 * accepted only on `/login`; every other human call needs a session token minted
 * post-MFA, or an API token; open mode is opt-in and only with no users), and the
 * real `POST /api/sync` handler (sanitizeOps / sanitizeRecordOps / ingestOps /
 * ingestRecordOps / visibleItemIds / getSyncEpoch). No handler is mirrored inline.
 *
 * index.ts is the server entry point; importing it for its factory is a guarded
 * no-op beyond opening the default/control DBs (no port bind, no schedulers — see
 * IS_ENTRY at the bottom of index.ts). We point those at a throwaway dir and
 * disable autostart before the (lazy) import.
 */

const TMP = `/tmp/carbon-a0-sync-${process.pid}`;
process.env.DATABASE_PATH = `${TMP}/carbon.db`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.BLOBS_DIR = `${TMP}/blobs`;
process.env.CARBON_NO_AUTOSTART = "1"; // never start the listener / schedulers from a test
process.env.ALLOW_OPEN_MODE = "1"; // open mode applies only while userCount === 0

// A stub peer-delivery seam — the sync handler only calls it for federated record
// ops, which these tests never push, so the body is never exercised.
const NO_DELIVERY: DeliverToPeer = async () =>
  new Response(JSON.stringify({ error: "no delivery in test" }), {
    status: 501,
  });

// Lazy import of the real factory so the env above is set before index.ts loads.
let _realBuild: typeof import("./index").buildTenantApp | null = null;
async function realBuild(): Promise<typeof import("./index").buildTenantApp> {
  if (!_realBuild) _realBuild = (await import("./index")).buildTenantApp;
  return _realBuild;
}

/** Build the real per-tenant app (route table + middleware) around an in-memory db.
 *  The sync route lives at /api/sync (the per-tenant `api` is mounted at /api). */
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

const SYNC_HEADERS = { "Content-Type": "application/json" };

// ─── open-mode sync (no users → synthetic `local`) ────────────────────────────

describe("POST /api/sync — open mode (no users)", () => {
  test("empty sync returns zero-cursors and empty op arrays", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const app = await realSyncApp(db, deviceId, vapidPublicKey);
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ops: Op[];
      cursor: number;
      recordOps: RecordOp[];
      rcursor: number;
      users: unknown[];
      syncEpoch: number;
    };
    assert.deepEqual(body.ops, []);
    assert.equal(body.cursor, 0);
    assert.deepEqual(body.recordOps, []);
    assert.equal(body.rcursor, 0);
    assert.ok(Array.isArray(body.users));
    assert.equal(body.syncEpoch, 1);
  });

  test("syncEpoch reflects bumped workspace setting", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const { bumpSyncEpoch } = await import("./federation");
    bumpSyncEpoch(db);
    const app = await realSyncApp(db, deviceId, vapidPublicKey);
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { syncEpoch: number };
    assert.equal(body.syncEpoch, 2);
  });

  test("ops pushed by client are returned in next sync", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const app = await realSyncApp(db, deviceId, vapidPublicKey);

    const itemId = "sync-item-1";
    const now = Date.now();
    const ops: Op[] = [
      {
        id: `op-${now}`,
        item_id: itemId,
        ts: now,
        device_id: "client-A",
        fields: { type: "task", title: "From Client", owner_id: null },
      },
    ];

    const pushRes = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({ syncEpoch: 1, ops }),
    });
    assert.equal(pushRes.status, 200);

    const pullRes = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({ syncEpoch: 1, since: 0 }),
    });
    const pullBody = (await pullRes.json()) as { ops: Op[] };
    assert.ok(
      pullBody.ops.some((o) => o.item_id === itemId),
      "ingested op reflected",
    );
  });

  test("cursor advances — second pull from cursor gets only new ops", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const app = await realSyncApp(db, deviceId, vapidPublicKey);

    const now = Date.now();
    await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [
          {
            id: `op-A-${now}`,
            item_id: "item-A",
            ts: now,
            device_id: "dev",
            fields: { type: "task", title: "A", owner_id: null },
          },
        ],
      }),
    });

    const res1 = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({ syncEpoch: 1, since: 0 }),
    });
    const { cursor } = (await res1.json()) as { cursor: number };
    assert.ok(cursor > 0, "cursor advanced");

    await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [
          {
            id: `op-B-${now + 1}`,
            item_id: "item-B",
            ts: now + 1,
            device_id: "dev",
            fields: { type: "task", title: "B", owner_id: null },
          },
        ],
      }),
    });

    const res2 = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({ syncEpoch: 1, since: cursor }),
    });
    const { ops: newOps } = (await res2.json()) as { ops: Op[] };
    assert.ok(
      !newOps.some((o) => o.item_id === "item-A"),
      "item-A not re-sent",
    );
    assert.ok(
      newOps.some((o) => o.item_id === "item-B"),
      "item-B is in delta",
    );
  });

  test("users roster is always returned (session bearer, not Basic)", async () => {
    const { db, deviceId, vapidPublicKey, addUser } = makeTestDb();
    const { id: aliceId, token: aliceToken } = addUser("alice", "pw");
    const app = await realSyncApp(db, deviceId, vapidPublicKey);
    // A session bearer (post-MFA human) — Basic is no longer accepted on /api/sync.
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}`, ...SYNC_HEADERS },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      users?: { username: string; id: string }[];
    };
    assert.ok(Array.isArray(body.users), "users array present");
    assert.ok(
      body.users!.some((u) => u.id === aliceId),
      "alice in roster",
    );
  });
});

// ─── authenticated sync visibility scoping ────────────────────────────────────

describe("POST /api/sync — visibility scoping (session bearer)", () => {
  test("authenticated user only sees their own items in the op stream", async () => {
    const { db, deviceId, vapidPublicKey, addUser } = makeTestDb();
    const { id: aliceId, token: aliceToken } = addUser("alice", "pw");
    const { id: bobId } = addUser("bob", "pw");

    // Create a task owned by Alice and one by Bob.
    createItem(db, deviceId, {
      type: "task",
      title: "Alice task",
      ownerId: aliceId,
    });
    createItem(db, deviceId, {
      type: "task",
      title: "Bob task",
      ownerId: bobId,
    });

    const app = await realSyncApp(db, deviceId, vapidPublicKey);
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}`, ...SYNC_HEADERS },
      body: JSON.stringify({ syncEpoch: 1, since: 0 }),
    });
    assert.equal(res.status, 200);
    const { ops } = (await res.json()) as { ops: Op[] };

    // Alice sees her own task but not Bob's.
    assert.ok(
      ops.some(
        (o) => (o.fields as Record<string, unknown>).title === "Alice task",
      ),
    );
    assert.ok(
      !ops.some(
        (o) => (o.fields as Record<string, unknown>).title === "Bob task",
      ),
    );
  });

  test("a raw password (Basic) cannot reach /api/sync — session required", async () => {
    const { db, deviceId, vapidPublicKey, addUser } = makeTestDb();
    const { basic } = addUser("alice", "pw");
    const app = await realSyncApp(db, deviceId, vapidPublicKey);
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { Authorization: basic, ...SYNC_HEADERS },
      body: JSON.stringify({ syncEpoch: 1, since: 0 }),
    });
    assert.equal(
      res.status,
      401,
      "Basic is only accepted on /login, not /api/sync",
    );
  });
});

// ─── op ingestion idempotency ─────────────────────────────────────────────────

describe("POST /api/sync — op ingestion idempotency", () => {
  test("pushing the same op twice does not create duplicate items", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const app = await realSyncApp(db, deviceId, vapidPublicKey);

    const op: Op = {
      id: "idem-op-001",
      item_id: "idem-item",
      ts: 1_750_000_000_000,
      device_id: "dev",
      fields: { type: "task", title: "Idempotent", owner_id: null },
    };

    await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({ syncEpoch: 1, ops: [op] }),
    });
    await appFetch(app, "/api/sync", {
      method: "POST",
      headers: SYNC_HEADERS,
      body: JSON.stringify({ syncEpoch: 1, ops: [op] }),
    });

    const count =
      db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT id) AS n FROM ops WHERE id = ?`,
        [op.id],
      )?.n ?? 0;
    assert.equal(count, 1, "op stored exactly once");
  });
});

// ─── push batch ceiling ───────────────────────────────────────────────────────
// The real /api/sync calls oversizedSyncArray before ingesting anything, so this
// covers the guard itself (pure function, no handler).

describe("sync push batch ceiling", () => {
  const filled = (n: number) => Array.from({ length: n }, (_, i) => i);

  test("a push within the cap passes", () => {
    assert.equal(
      oversizedSyncArray({ ops: filled(3), recordOps: filled(3) }, 3),
      null,
    );
    assert.equal(oversizedSyncArray({}, 3), null);
    assert.equal(oversizedSyncArray({ ops: "not-an-array" }, 3), null);
  });

  test("the oversized array is named, ops before recordOps", () => {
    assert.equal(oversizedSyncArray({ ops: filled(4) }, 3), "ops");
    assert.equal(oversizedSyncArray({ recordOps: filled(4) }, 3), "recordOps");
    assert.equal(oversizedSyncArray({ need: filled(4) }, 3), "need");
    assert.equal(
      oversizedSyncArray({ ops: filled(4), recordOps: filled(4) }, 3),
      "ops",
    );
  });

  test("arrays are capped independently, so a big need does not sink a normal push", () => {
    assert.equal(
      oversizedSyncArray(
        { ops: filled(2), recordOps: filled(2), need: filled(2) },
        3,
      ),
      null,
    );
  });

  test("the default ceiling leaves room for the client chunk size (2500)", () => {
    assert.ok(
      MAX_SYNC_BATCH >= 2500,
      `MAX_SYNC_BATCH=${MAX_SYNC_BATCH} would reject a full client chunk`,
    );
  });
});

test('legacy sync edits coexist with review progress and upgrading recovers progress', async () => {
  const { writeReviewEntry, readReviewEntries, getItem } = await import('@carbon/core');
  const { db, deviceId, vapidPublicKey } = makeTestDb();
  const project = createItem(db, deviceId, { type: 'project', title: 'Legacy project' });
  writeReviewEntry(db, deviceId, 'local', project, 'check:tasksRelevant', { checked: true });
  const app = await realSyncApp(db, deviceId, vapidPublicKey);
  async function request(body: object) {
    const response = await appFetch(app, '/api/sync', { method: 'POST', headers: SYNC_HEADERS, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return await response.json() as any;
  }
  const old = await request({ since: 0, rsince: 0 });
  assert.equal(old.recordOps.some((op: RecordOp) => op.entity === 'review_progress'), false);
  assert.equal(old.reviewCursor, undefined);
  const edited = await request({ since: old.cursor, rsince: old.rcursor, syncEpoch: old.syncEpoch,
    ops: [{ id: 'legacy-title-edit', item_id: project.id, device_id: 'older-client', ts: Date.now() + 1000, fields: { title: 'Updated by older client' } }], recordOps: [] });
  assert.deepEqual(edited.acknowledged.ops, ['legacy-title-edit']);
  assert.equal(getItem(db, project.id)?.title, 'Updated by older client');
  assert.equal(readReviewEntries(db, 'local', project)['check:tasksRelevant'].checked, true);
  const upgraded = await request({ since: edited.cursor, rsince: edited.rcursor, reviewSince: 0 });
  assert.equal(upgraded.reviewProgressSupported, true);
  assert.equal(upgraded.recordOps.filter((op: RecordOp) => op.entity === 'review_progress').length, 1);
  assert.ok(upgraded.reviewCursor > 0);
});
