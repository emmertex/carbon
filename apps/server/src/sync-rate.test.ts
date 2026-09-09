import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { makeTestDb, appFetch, type TestDb } from "./test-app";
import type { FetchApp } from "./tenant";
import type { DeliverToPeer } from "./federation";

/**
 * Sync rate-limit (A2): a per-credential sliding 1-minute window on /api/sync. With the cap
 * set to 3, the first 3 syncs succeed and the 4th is refused with an actionable 429 that
 * carries retry_after_ms. A refused sync is NOT ingested, so the client keeps its ops
 * unsynced and re-syncs on the delay — no work is lost.
 */

const TMP = `/tmp/carbon-a2-rate-${process.pid}`;
process.env.DATABASE_PATH = `${TMP}/carbon.db`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.BLOBS_DIR = `${TMP}/blobs`;
process.env.CARBON_NO_AUTOSTART = "1";
process.env.ALLOW_OPEN_MODE = "1";
process.env.SYNC_MAX_PER_MIN = "3";

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

describe("POST /api/sync — per-credential rate limit (429, no loss)", () => {
  test("admits up to the cap, then 429s with retry_after_ms; a refused sync is not ingested", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const app = await realSyncApp(db, deviceId, vapidPublicKey);
    const now = Date.now();

    const results: number[] = [];
    let last429: {
      error: string;
      scope: string;
      retry_after_ms: number;
    } | null = null;
    for (let i = 0; i < 5; i++) {
      const res = await appFetch(app, "/api/sync", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          syncEpoch: 1,
          ops: [
            {
              id: `op-r-${i}`,
              item_id: `item-${i}`,
              ts: now + i,
              device_id: "dev",
              fields: { type: "task", title: `t${i}`, owner_id: null },
            },
          ],
        }),
      });
      results.push(res.status);
      if (res.status === 429) {
        const b = (await res.json()) as {
          error: string;
          scope: string;
          retry_after_ms: number;
        };
        last429 = b;
        const ra = res.headers.get("Retry-After");
        assert.ok(
          ra && Number(ra) >= 1,
          `429 carries a Retry-After header (got ${ra})`,
        );
      }
    }
    // First 3 admitted, then 429s.
    assert.deepEqual(
      results.slice(0, 3),
      [200, 200, 200],
      `first 3 syncs succeed: ${results}`,
    );
    assert.equal(results[3], 429, "4th sync rate-limited");
    assert.ok(last429, "captured a 429 body");
    assert.equal(last429.error, "rate_limited");
    assert.equal(last429.scope, "sync");
    assert.ok(
      last429.retry_after_ms >= 1000,
      "retry_after_ms is actionable (>= 1s)",
    );

    // The two refused pushes (ops 3 and 4) must NOT be ingested.
    const ingested =
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ops")?.n ?? 0;
    assert.equal(
      ingested,
      3,
      `only the 3 admitted pushes are ingested, got ${ingested}`,
    );
  });
});
