import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { appFetch } from "./test-app";
import { initTenantDb, type FetchApp } from "./tenant";
import { openControlDb, provisionTenant, setTenantDbQuota } from "./control";
import { getUserByUsername } from "@carbon/core";
import { createSession } from "./auth";
import type { DeliverToPeer } from "./federation";

/**
 * DB size-quota tests (A2). The default tenant is uncapped (single-tenant self-host), so
 * this provisions a REAL tenant (control row + file-backed DB + admin session) and sets
 * a tiny per-workspace db_quota_bytes to trip the 507 gate. The invariant under test:
 *   a sync PUSH refused by the quota is NOT ingested (the client keeps its ops
 *   unsynced), while a PULL (no writes) is unaffected.
 */

const TMP = `/tmp/carbon-a2-quota-${process.pid}`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.DATABASE_PATH = `${TMP}/default/carbon.db`;
process.env.BLOBS_DIR = `${TMP}/default/blobs`;
process.env.CARBON_NO_AUTOSTART = "1"; // never bind a port / start schedulers

const NO_DELIVERY: DeliverToPeer = async () =>
  new Response(JSON.stringify({ error: "no delivery in test" }), {
    status: 501,
  });

let _mod: typeof import("./index") | null = null;
async function mod(): Promise<typeof import("./index")> {
  if (!_mod) _mod = await import("./index");
  return _mod;
}

describe("POST /api/sync — per-workspace DB size quota", () => {
  test("a push over the quota is refused with 507 and nothing is ingested; a pull still works", async () => {
    const m = await mod();
    const controlDb = openControlDb(process.env.CONTROL_DB_PATH!);

    // Provision a real tenant (control row + file DB + admin), then cap its DB tiny.
    const rec = provisionTenant(controlDb, `${TMP}/tenants`, {
      subdomain: "quota",
      adminUsername: "admin",
      adminPassword: "correct-horse-battery",
    });
    setTenantDbQuota(controlDb, rec.id, 1); // 1 byte — any real DB file trips it

    // Re-open the provisioned tenant as a ctx (idempotent init) and mint an admin session.
    const ctx = initTenantDb({
      id: rec.id,
      subdomain: rec.subdomain,
      dbPath: rec.db_path,
      blobsDir: rec.blobs_dir,
    });
    const admin = getUserByUsername(ctx.db, "admin")!;
    const token = createSession(ctx.db, admin.id);
    const app: FetchApp = m.buildTenantApp(ctx, NO_DELIVERY);

    const H = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    const now = Date.now();

    // 1) A PUSH over the quota → 507, and the op is NOT ingested.
    const push = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [
          {
            id: `op-q-${now}`,
            item_id: "q-item",
            ts: now,
            device_id: "dev",
            fields: { type: "task", title: "x", owner_id: null },
          },
        ],
      }),
    });
    assert.equal(push.status, 507, `expected 507, got ${push.status}`);
    const pb = (await push.json()) as {
      error: string;
      current_bytes: number;
      limit_bytes: number;
    };
    assert.equal(pb.error, "db_quota_exceeded");
    assert.ok(
      pb.current_bytes >= pb.limit_bytes,
      "reported size meets/exceeds the limit",
    );
    const ingested =
      ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ops")?.n ?? 0;
    assert.equal(ingested, 0, "refused push must not be ingested");

    for (const path of [
      "/api/tasks",
      "/api/tasks/q-item/comments",
      "/api/agent/tasks",
    ]) {
      const refused = await appFetch(app, path, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ title: "blocked", body: "blocked" }),
      });
      assert.equal(refused.status, 507, `shared quota admission: ${path}`);
    }
    assert.equal(
      (await appFetch(app, "/api/tasks", { headers: H })).status,
      200,
    );

    // 2) Raising the cap unblocks the same push (host-admin remedy).
    setTenantDbQuota(controlDb, rec.id, 1024 * 1024 * 1024); // 1 GB — comfortably above
    const retry = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [
          {
            id: `op-q-${now}`,
            item_id: "q-item",
            ts: now,
            device_id: "dev",
            fields: { type: "task", title: "x", owner_id: null },
          },
        ],
      }),
    });
    assert.equal(
      retry.status,
      200,
      `after raising the cap the push succeeds, got ${retry.status}`,
    );
    const ingested2 =
      ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ops")?.n ?? 0;
    assert.ok(ingested2 >= 1, "push ingested once within quota");

    // 3) A PULL is never blocked by the store quota (it writes nothing).
    const pull = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ syncEpoch: 1, since: 0 }),
    });
    assert.equal(pull.status, 200, "pull is unaffected by the db quota");
  });
});
