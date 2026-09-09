import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConcurrencyGate } from "./concurrency";
import { getUserByUsername } from "@carbon/core";
import {
  openControlDb,
  provisionTenant,
  setTenantDbQuota,
  getTenantById,
} from "./control";
import { initTenantDb } from "./tenant";
import { createSession } from "./auth";

/**
 * A2 ACCEPTANCE — bounded attack / tenant isolation.
 *
 * Hammers ONE tenant (A) with a burst of real sync pushes while probing a SECOND tenant
 * (B) concurrently. Asserts:
 *   1. B stays RESPONSIVE — every B request completes within a time bound and is NOT
 *      rejected (a noisy tenant cannot starve its neighbors).
 *   2. A is BOUNDED — under the burst, A's overflow is rejected with an actionable 429
 *      (the per-tenant + global concurrency gates hold), so the host's in-flight work
 *      stays within the configured caps instead of growing with the attack size.
 *
 * Runs against the REAL /api/* dispatcher (imported `app`), so the gates under test are
 * the production ones. Disposable: temp file DBs, no live data, no port bound
 * (CARBON_NO_AUTOSTART). The attack is time-boxed by the per-request timeout below.
 */

const TMP = mkdtempSync(join(tmpdir(), "carbon-a2-attack-"));
const BASE = "carbon.test";
// Small, deterministic caps so a modest burst is guaranteed to overflow the tenant gate.
process.env.BASE_DOMAIN = BASE;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.DATABASE_PATH = `${TMP}/default/carbon.db`;
process.env.BLOBS_DIR = `${TMP}/default/blobs`;
process.env.CARBON_NO_AUTOSTART = "1";
process.env.MAX_CONCURRENT_REQUESTS = "50"; // global pool
process.env.TENANT_MAX_CONCURRENT = "5"; // per-tenant slice — the isolation control
process.env.USER_MAX_CONCURRENT = "10";

const ATTACK_SIZE = 40; // concurrent pushes at A — 8x the tenant gate
const PROBE_SIZE = 4; // concurrent requests at B
const B_RESPONSE_BUDGET_MS = 5_000; // "responsive" bound for B
const TENANT_MAX = 5; // must match TENANT_MAX_CONCURRENT above

let _mod: typeof import("./index") | null = null;
async function mod(): Promise<typeof import("./index")> {
  if (!_mod) _mod = await import("./index");
  return _mod;
}

function sessionFor(
  subdomain: string,
  rec: { id: string; db_path: string; blobs_dir: string; subdomain: string },
  username: string,
): string {
  const ctx = initTenantDb({
    id: rec.id,
    subdomain: rec.subdomain,
    dbPath: rec.db_path,
    blobsDir: rec.blobs_dir,
  });
  const user = getUserByUsername(ctx.db, username)!;
  return createSession(ctx.db, user.id);
}

/** A fetch time-boxed so a hung request can't stall the test (bounded attack). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

describe("A2 bounded attack — one tenant hammered, its neighbor stays responsive", () => {
  test("B stays responsive and A is bounded (429 on overflow) under a concurrent burst", async () => {
    const m = await mod();
    const controlDb = openControlDb(process.env.CONTROL_DB_PATH!);

    const a = provisionTenant(controlDb, `${TMP}/tenants`, {
      subdomain: "a",
      adminUsername: "admin",
      adminPassword: "pw-a",
    });
    const b = provisionTenant(controlDb, `${TMP}/tenants`, {
      subdomain: "b",
      adminUsername: "admin",
      adminPassword: "pw-b",
    });
    // Generous DB quotas so the test exercises concurrency, not storage.
    setTenantDbQuota(controlDb, a.id, 1024 * 1024 * 512);
    setTenantDbQuota(controlDb, b.id, 1024 * 1024 * 512);
    const tokenA = sessionFor("a", a, "admin");
    const tokenB = sessionFor("b", b, "admin");

    const now = Date.now();
    const H = (token: string) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    });

    // A: a burst of real sync pushes (each ingests a small op batch → real work holding a
    // gate slot for a few ms, so the burst overlaps at the tenant gate). The host header
    // must be set explicitly: it's a fetch-spec "forbidden" header, so `new Request(url)`
    // does not expose it and Hono's dispatcher would otherwise route every request to the
    // default tenant (and they'd all share ONE tenant gate — the bug this test must avoid).
    const aPush = (i: number): Promise<number> =>
      Promise.resolve(
        m.app.fetch(
          new Request(`http://a.${BASE}/api/sync`, {
            method: "POST",
            headers: { ...H(tokenA), host: `a.${BASE}` },
            body: JSON.stringify({
              syncEpoch: 1,
              ops: Array.from({ length: 200 }, (_, k) => ({
                id: `op-a-${i}-${k}`,
                item_id: `item-a-${i}-${k}`,
                ts: now + k,
                device_id: `dev-a-${i}`,
                fields: { type: "task", title: `t${i}-${k}`, owner_id: null },
              })),
            }),
          }),
        ),
      ).then((r) => r.status);

    // B: concurrent real reads (responsive = completes fast, no rejection).
    const bRead = (): Promise<number> =>
      Promise.resolve(
        m.app.fetch(
          new Request(`http://b.${BASE}/api/tasks`, {
            headers: { ...H(tokenB), host: `b.${BASE}` },
          }),
        ),
      ).then((r) => r.status);

    const t0 = Date.now();
    const [aStatuses, bStatuses] = await Promise.all([
      withTimeout(
        Promise.all(Array.from({ length: ATTACK_SIZE }, (_, i) => aPush(i))),
        15_000,
        "attack burst",
      ),
      withTimeout(
        Promise.all(Array.from({ length: PROBE_SIZE }, () => bRead())),
        B_RESPONSE_BUDGET_MS,
        "B probes",
      ),
    ]);
    const elapsed = Date.now() - t0;

    // 1) B stayed responsive: every probe completed within the budget and was NOT rejected.
    assert.equal(bStatuses.length, PROBE_SIZE, "all B probes returned");
    for (const s of bStatuses) {
      assert.notEqual(
        s,
        429,
        `a B request was rate-limited while A was hammered (isolation broken): ${s}`,
      );
      assert.notEqual(
        s,
        503,
        "a B request hit a server-overload rejection (isolation broken)",
      );
    }
    assert.ok(
      elapsed < B_RESPONSE_BUDGET_MS + 5000,
      `B probes took ${elapsed}ms (budget ${B_RESPONSE_BUDGET_MS}ms)`,
    );

    // 2) A was bounded: at most TENANT_MAX_CONCURRENT of A's requests may be in flight at
    // once, so a burst of ATTACK_SIZE must be mostly rejected with an actionable 429. (A
    // few extra may be admitted as slots recycle during the short burst — allow slack.)
    const a429 = aStatuses.filter((s) => s === 429).length;
    const aOk = aStatuses.filter((s) => s === 200).length;
    assert.ok(
      aOk >= 1,
      "at least some of A's pushes were admitted (the cap bounds, it does not block everything)",
    );
    assert.ok(
      aOk <= TENANT_MAX + 5,
      `A admitted ${aOk} (cap ${TENANT_MAX} + slack); the per-tenant gate is not holding`,
    );
    assert.ok(
      a429 >= ATTACK_SIZE - (TENANT_MAX + 5),
      `expected most of the burst 429'd (got ${a429}); the host is not bounded`,
    );

    console.error(
      `[bounded-attack] A: ${aOk} admitted (cap ${TENANT_MAX}), ${a429} rejected (429), ${ATTACK_SIZE - aOk - a429} other; B: ${JSON.stringify(bStatuses)}; total ${elapsed}ms`,
    );
  });
});

test("repeated dispatcher bursts remain bounded while the neighbor stays usable and quota rejects preserve data", async (t) => {
  const { openDb } = await import("./sqlite");
  const m = await mod();
  const control = openControlDb(process.env.CONTROL_DB_PATH!);
  const a = provisionTenant(control, `${TMP}/sustained`, {
    subdomain: "sustained-a",
    adminUsername: "admin",
    adminPassword: "pw",
  });
  const b = provisionTenant(control, `${TMP}/sustained`, {
    subdomain: "sustained-b",
    adminUsername: "admin",
    adminPassword: "pw",
  });
  const tokenA = sessionFor(a.subdomain, a, "admin");
  const tokenB = sessionFor(b.subdomain, b, "admin");
  const inspect = openDb(a.db_path);
  const counts = () =>
    ["ops", "record_ops", "items"].map(
      (table) =>
        inspect.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n,
    );
  // Observe the real production gates without changing admission or scheduling.
  // tryEnter is synchronous: refusal creates no waiter and can never be admitted later.
  const peaks = new Map<ConcurrencyGate, number>();
  const enter = ConcurrencyGate.prototype.tryEnter;
  let refusals = 0;
  t.mock.method(
    ConcurrencyGate.prototype,
    "tryEnter",
    function (this: ConcurrencyGate) {
      const admitted = enter.call(this);
      assert.equal(
        typeof admitted,
        "boolean",
        "HTTP admission must not enqueue a promise",
      );
      peaks.set(this, Math.max(peaks.get(this) ?? 0, this.activeCount));
      if (!admitted) refusals++;
      return admitted;
    },
  );
  // Session expiry still slides during auth; assert logical allocation, not WAL bytes.
  const storage = () =>
    inspect.get<{ page_count: number }>("PRAGMA page_count")!.page_count;
  let quotaCounts: number[] | undefined;
  let quotaStorage: number | undefined;
  for (let round = 0; round < 8; round++) {
    if (round === 4) {
      setTenantDbQuota(control, a.id, 1);
      quotaCounts = counts();
      quotaStorage = storage();
    }
    const push = (i: number) =>
      Promise.resolve(
        m.app.fetch(
          new Request(`http://${a.subdomain}.${BASE}/api/sync`, {
            method: "POST",
            headers: {
              host: `${a.subdomain}.${BASE}`,
              Authorization: `Bearer ${tokenA}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              syncEpoch: 1,
              ops: [
                {
                  id: `sustained-${round}-${i}`,
                  item_id: `sustained-${round}-${i}`,
                  ts: Date.now(),
                  device_id: "sustained",
                  fields: { type: "task", title: "bounded" },
                },
              ],
            }),
          }),
        ),
      ).then((r) => r.status);
    const probe = () =>
      Promise.resolve(
        m.app.fetch(
          new Request(`http://${b.subdomain}.${BASE}/api/tasks`, {
            headers: {
              host: `${b.subdomain}.${BASE}`,
              Authorization: `Bearer ${tokenB}`,
            },
          }),
        ),
      ).then((r) => r.status);
    const [attack, neighbor] = await Promise.all([
      withTimeout(
        Promise.all(Array.from({ length: 40 }, (_, i) => push(i))),
        15000,
        "sustained burst",
      ),
      withTimeout(
        Promise.all(Array.from({ length: 4 }, probe)),
        5000,
        "sustained neighbor",
      ),
    ]);
    assert.deepEqual(neighbor, [200, 200, 200, 200], `neighbor round ${round}`);
    assert.ok(
      attack.filter((status) => status !== 429).length <= TENANT_MAX,
      `admission bound round ${round}`,
    );
    assert.ok(attack.every((status) => [200, 429, 507].includes(status)));
    if (quotaCounts) {
      assert.deepEqual(counts(), quotaCounts);
      assert.equal(storage(), quotaStorage);
      assert.equal(getTenantById(control, a.id)!.db_quota_bytes, 1);
      assert.ok(attack.includes(507), "quota gate exercised");
      assert.ok(!attack.includes(200));
    }
    for (const gate of peaks.keys())
      assert.equal(gate.activeCount, 0, "no retained work between bursts");
  }
  // One global gate plus two tenant gates; first observed gate is the global dispatcher.
  const [globalPeak, ...tenantPeaks] = peaks.values();
  assert.equal(tenantPeaks.length, 2);
  assert.ok(globalPeak > 0 && globalPeak <= 50);
  assert.deepEqual(tenantPeaks, [TENANT_MAX, PROBE_SIZE]);
  assert.ok(refusals >= 8 * (ATTACK_SIZE - TENANT_MAX));
  console.error(
    `[sustained-attack] 8x40 pushes; 32 neighbor reads passed; peak global=${globalPeak}, tenants=${tenantPeaks}; HTTP admission queue=0; quota rejects left row counts, logical DB pages and quota unchanged`,
  );
  inspect.raw.close();
});
