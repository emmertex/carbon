import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { mkdirSync } from "node:fs";
import { createUser, createItem, type Op } from "@carbon/core";
import { initTenantDb } from "./tenant";
import { createSession } from "./auth";
import type { DeliverToPeer } from "./federation";

/**
 * `rejected` sync field (A2): a push the server refuses to ingest (authorization-dropped)
 * must come back with rejected.ops > 0 and the entry must NOT be ingested. The client
 * keeps the local copy unsynced and re-pushes, so a rejection is never a silent loss.
 * Uses a provisioned tenant so the A1 credential gate + validation actually run (open mode
 * skips them).
 */

const TMP = `/tmp/carbon-a2-rej-${process.pid}`;
process.env.DATABASE_PATH = `${TMP}/carbon.db`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.BLOBS_DIR = `${TMP}/blobs`;
process.env.CARBON_NO_AUTOSTART = "1";

const NO_DELIVERY: DeliverToPeer = async () =>
  new Response(JSON.stringify({ error: "no delivery in test" }), {
    status: 501,
  });

let _build: typeof import("./index").buildTenantApp | null = null;
async function build(): Promise<typeof import("./index").buildTenantApp> {
  if (!_build) _build = (await import("./index")).buildTenantApp;
  return _build;
}

describe("POST /api/sync — rejected count surfaces drops without ingesting them", () => {
  test("a write to another user’s unshared item is rejected: rejected.ops=1, not ingested", async () => {
    mkdirSync(`${TMP}/t`, { recursive: true });
    mkdirSync(`${TMP}/t`, { recursive: true });
    const ctx = initTenantDb({
      id: "default",
      subdomain: "",
      dbPath: `${TMP}/t/carbon.db`,
      blobsDir: `${TMP}/blobs`,
    });
    const db = ctx.db;
    createUser(db, { username: "alice", displayName: "Alice" });
    const bob = createUser(db, { username: "bob", displayName: "Bob" });
    // Bob owns an item; Alice has no share on it.
    const it = createItem(db, "d", { title: "bob-only", ownerId: bob.id });

    const alice = db.get<{ id: string }>(
      "SELECT id FROM users WHERE username = 'alice'",
    )!;
    const token = createSession(db, alice.id);

    const app = (await build())(ctx, NO_DELIVERY);

    const op: Op = {
      id: `op-rej-${Date.now()}`,
      item_id: it.id,
      ts: Date.now(),
      device_id: "dev",
      fields: { title: "hijacked" },
    };
    const { appFetch } = await import("./test-app");
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ syncEpoch: 1, ops: [op] }),
    });
    assert.equal(
      res.status,
      200,
      "the sync itself succeeds (no 4xx for a dropped write)",
    );
    const body = (await res.json()) as {
      rejected: { ops: number; recordOps: number };
    };
    assert.equal(
      body.rejected.ops,
      1,
      "the dropped write is reported in rejected.ops",
    );
    assert.equal(body.rejected.recordOps, 0);

    // The item is unchanged — the write was not ingested.
    const after = db.get<{ title: string }>(
      "SELECT title FROM items WHERE id = ?",
      [it.id],
    )!;
    assert.equal(after.title, "bob-only", "dropped write must not be applied");
  });
});
