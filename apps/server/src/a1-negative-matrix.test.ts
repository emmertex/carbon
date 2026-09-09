import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  migrate,
  createItem,
  createUser,
  shareItem,
  unshareItem,
  addComment,
  getItem,
  subtreeIds,
  visibleItemIds,
  hasWriteAccess,
  hasReadAccess,
  type Db,
  type Op,
  type RecordOp,
} from "@carbon/core";
import { openDb } from "./sqlite";
import {
  type Credential,
  KNOWN_AUTH_METHODS,
  sessionCredentialFor,
  isKnownAuthMethod,
  isDenied,
  effectiveScopes,
  hasScope,
  isHumanSession,
  canPushWrites,
  effectiveAccess,
  canReadItem,
  canWriteItem,
  isItemOwner,
  validateRecordOp,
  validateRecordOps,
  checkItemOpDestination,
} from "./authorize";
import { makeTestDb, appFetch, type TestDb } from "./test-app";
import { createSession, createToken, revokeToken } from "./auth";
import type { FetchApp } from "./tenant";
import type { DeliverToPeer } from "./federation";

/**
 * A1 — a comprehensive NEGATIVE authorization matrix. Every case asserts a DENIAL,
 * paired with the matching positive where the spec calls for one. The matrix spans two
 * levels of the same shared module (`./authorize`):
 *
 *   • **unit level** — plain `Credential` + `Db` (no Hono): `canReadItem` / `canWriteItem` /
 *     `effectiveAccess` / `validateRecordOp` / `checkItemOpDestination`.
 *   • **real-app level** — the actual per-tenant app (`buildTenantApp` in index.ts, the same
 *     route table + middleware a production tenant runs) driving the real `POST /api/sync`
 *     and `GET /api/tasks` handlers. No handler is mirrored inline.
 *
 * Categories (each asserts the denial + the noted positive):
 *   1. Cross-user          — no read/write of a stranger's private item (unit + real sync + task list).
 *   2. Cross-workspace     — an item in one tenant DB is inaccessible through another tenant DB.
 *   3. Read-only           — a read sharee can read but not write; a scoped read-only token can't push.
 *   4. Revoked             — an unshared grant and a revoked API token grant nothing.
 *   5. Subtree-restricted  — a project share reaches the subtree but not a sibling / unowned parent.
 *   6. Carried findings    — the three A1 findings re-denied end-to-end through the real app.
 *   7. Owner-only sharing  — only the owner grants onward; a sharee may only drop their own grant.
 *   8. Comment management  — only the comment's author or the item's owner may edit/delete it.
 *
 * index.ts is the server entry; importing it for its factory is a guarded no-op (no port bind /
 * schedulers — see IS_ENTRY at the bottom of index.ts). We point the default/control DBs at a
 * throwaway dir and disable autostart before the lazy import.
 */

const TMP = `/tmp/carbon-a1neg-${process.pid}`;
process.env.DATABASE_PATH = `${TMP}/carbon.db`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.BLOBS_DIR = `${TMP}/blobs`;
process.env.CARBON_NO_AUTOSTART = "1"; // never start the listener / schedulers from a test
process.env.ALLOW_OPEN_MODE = "1";

const NO_DELIVERY: DeliverToPeer = async () =>
  new Response(JSON.stringify({ error: "no delivery in test" }), {
    status: 501,
  });

let _realBuild: typeof import("./index").buildTenantApp | null = null;
async function realBuild(): Promise<typeof import("./index").buildTenantApp> {
  if (!_realBuild) _realBuild = (await import("./index")).buildTenantApp;
  return _realBuild;
}

async function realApp(
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

const SYNC = { "Content-Type": "application/json" };
// A fresh, slightly-future causal ts per op. It must beat the just-created row's real clock so a
// legitimate write wins the LWW merge through the real ingest, while staying within the sync skew
// clamp (60s < the 5-min clamp) so it isn't flattened.
const futureTs = () => Date.now() + 60_000;
let opSeq = 0;
const op = (item_id: string, fields: Record<string, unknown>): Op => ({
  id: `op-${opSeq++}`,
  item_id,
  ts: futureTs(),
  device_id: "dev",
  fields,
});
const rec = (
  entity: string,
  row_id: string,
  data: Record<string, unknown>,
): RecordOp => ({
  id: `r-${opSeq++}`,
  entity,
  row_id,
  ts: futureTs(),
  device_id: "dev",
  data,
});

// A pure in-memory tenant DB (core schema only) — the fixtures for cross-workspace isolation.
function coreDb(): Db {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

const DEV = "d";
// A share row id is `s:<itemId>:<userId>`.
const shareRowId = (itemId: string, userId: string) => `s:${itemId}:${userId}`;
// A full-identity credential for a bare user id (human session semantics).
const cred = (userId: string): Credential => sessionCredentialFor(userId);
// A scoped API token credential (its own scopes bind).
const tokenCred = (userId: string, scopes: string[]): Credential => ({
  authMethod: "token",
  userId,
  role: "member",
  scopes,
});

// ---------------------------------------------------------------------------
// 1. CROSS-USER — no read/write of a stranger's private item (no share).
// ---------------------------------------------------------------------------

describe("1. cross-user isolation", () => {
  test("unit: alice cannot read or write bob's private item; she can read/write her own", () => {
    const d = coreDb();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const bobTask = createItem(d, DEV, {
      type: "task",
      title: "bob-secret",
      ownerId: bob.id,
    });
    const aliceTask = createItem(d, DEV, {
      type: "task",
      title: "alice-secret",
      ownerId: alice.id,
    });

    // No share → no access across users.
    assert.equal(
      canReadItem(d, cred(alice.id), bobTask.id),
      false,
      "alice cannot read bob's item",
    );
    assert.equal(
      canWriteItem(d, cred(alice.id), bobTask.id),
      false,
      "alice cannot write bob's item",
    );
    assert.equal(effectiveAccess(d, cred(alice.id), bobTask.id), "none");
    assert.equal(isItemOwner(d, cred(alice.id), bobTask.id), false);

    // Positive: ownership is preserved within the same tenant.
    assert.equal(canReadItem(d, cred(alice.id), aliceTask.id), true);
    assert.equal(canWriteItem(d, cred(alice.id), aliceTask.id), true);
    assert.equal(effectiveAccess(d, cred(alice.id), aliceTask.id), "own");
    assert.equal(isItemOwner(d, cred(alice.id), aliceTask.id), true);
  });

  test("real app: alice's session cannot mutate bob's task through /api/sync", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const bobTask = createItem(db, DEV, {
      type: "task",
      title: "bob-secret",
      ownerId: bob.id,
    });
    const app = await realApp(db, deviceId, vapidPublicKey);

    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        ...SYNC,
        Authorization: `Bearer ${createSession(db, alice.id)}`,
      },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [op(bobTask.id, { title: "hijacked-by-alice" })],
      }),
    });
    assert.equal(
      res.status,
      200,
      "sync still succeeds (pull) — the write is dropped, not the request",
    );
    assert.equal(
      getItem(db, bobTask.id)?.title,
      "bob-secret",
      "alice's cross-user write denied",
    );
  });

  test("real app: alice's session cannot read bob's task from the task list", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const bobTask = createItem(db, DEV, {
      type: "task",
      title: "bob-secret",
      ownerId: bob.id,
    });
    const aliceTask = createItem(db, DEV, {
      type: "task",
      title: "alice-secret",
      ownerId: alice.id,
    });
    const app = await realApp(db, deviceId, vapidPublicKey);

    const res = await appFetch(app, "/api/tasks", {
      headers: { Authorization: `Bearer ${createSession(db, alice.id)}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tasks: { id: string }[] };
    const ids = body.tasks.map((t) => t.id);
    assert.ok(ids.includes(aliceTask.id), "alice sees her own task");
    assert.ok(
      !ids.includes(bobTask.id),
      "bob's private task is absent from alice's task list",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. CROSS-WORKSPACE / TENANT ISOLATION — an item in one tenant DB is not
//    visible/writable through a DIFFERENT tenant DB.
// ---------------------------------------------------------------------------

describe("2. cross-workspace / tenant isolation", () => {
  test("an item in tenant A is invisible and unchanged through tenant B", () => {
    const tenantA = coreDb();
    const alice = createUser(tenantA, { username: "alice" });
    const itemA = createItem(tenantA, DEV, {
      type: "task",
      title: "tenant-a-secret",
      ownerId: alice.id,
    });

    // A separate, independent tenant (its own in-memory DB).
    const tenantB = coreDb();
    const bobB = createUser(tenantB, { username: "bob" });

    // The tenant-A row simply does not exist in tenant B → no access for any credential.
    assert.equal(effectiveAccess(tenantB, cred(bobB.id), itemA.id), "none");
    assert.equal(
      canReadItem(tenantB, cred(bobB.id), itemA.id),
      false,
      "tenant-B user cannot read a tenant-A item",
    );
    assert.equal(
      canWriteItem(tenantB, cred(bobB.id), itemA.id),
      false,
      "tenant-B user cannot write a tenant-A item",
    );
    assert.equal(hasReadAccess(tenantB, itemA.id, bobB.id), false);
    assert.equal(hasWriteAccess(tenantB, itemA.id, bobB.id), false);

    // Even the item's own owner id, evaluated against tenant B, reaches no tenant-B access
    // (the row is not in tenant B) — the DB file *is* the tenant boundary.
    assert.equal(
      canReadItem(tenantB, cred(alice.id), itemA.id),
      false,
      "owner id still resolves to no access in tenant B",
    );

    // Positive: within its own tenant the owner retains full access (no false negative).
    assert.equal(canReadItem(tenantA, cred(alice.id), itemA.id), true);
    assert.equal(canWriteItem(tenantA, cred(alice.id), itemA.id), true);
    assert.equal(visibleItemIds(tenantA, alice.id).has(itemA.id), true);
  });

  test("tenant isolation holds symmetrically (a tenant-B item is not reachable from tenant A)", () => {
    const tenantA = coreDb();
    const tenantB = coreDb();
    const carolB = createUser(tenantB, { username: "carol" });
    const itemB = createItem(tenantB, DEV, {
      type: "project",
      title: "tenant-b-project",
      ownerId: carolB.id,
    });

    assert.equal(
      canReadItem(tenantA, cred(carolB.id), itemB.id),
      false,
      "carol (tenant B) cannot read from tenant A",
    );
    assert.equal(canWriteItem(tenantA, cred(carolB.id), itemB.id), false);
    assert.equal(
      canReadItem(tenantB, cred(carolB.id), itemB.id),
      true,
      "carol still reads her own item in tenant B",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. READ-ONLY — a read sharee can read but not write; a scoped read-only token
//    cannot push writes.
// ---------------------------------------------------------------------------

describe("3. read-only", () => {
  test("credential level: a read-only token cannot push writes; a session can", () => {
    assert.equal(
      canPushWrites(tokenCred("m", ["tasks:read"])),
      false,
      "tasks:read only",
    );
    assert.equal(canPushWrites(tokenCred("m", ["inbox:write"])), false);
    assert.equal(
      canPushWrites(cred("m")),
      true,
      "a human session pushes writes",
    );
    assert.equal(isHumanSession(cred("m")), true);
    assert.equal(
      isHumanSession(tokenCred("m", ["tasks:write"])),
      false,
      "a token is not a human session",
    );
    // An unknown auth method is denied by default (no scopes).
    const forged: Credential = {
      authMethod: "forged",
      userId: "m",
      role: "member",
      scopes: ["tasks:write"],
    };
    assert.equal(isKnownAuthMethod("forged"), false);
    assert.equal(isDenied(forged), true);
    assert.deepEqual(effectiveScopes(forged), []);
    assert.equal(hasScope(forged, "tasks:write"), false);
    assert.ok(KNOWN_AUTH_METHODS.includes("token"));
  });

  test("unit: a read sharee can READ but not WRITE the shared item", () => {
    const d = coreDb();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const it = createItem(d, DEV, {
      type: "task",
      title: "t",
      ownerId: alice.id,
    });
    shareItem(d, DEV, it.id, bob.id, "read");

    assert.equal(effectiveAccess(d, cred(bob.id), it.id), "read");
    assert.equal(
      canReadItem(d, cred(bob.id), it.id),
      true,
      "read sharee can read",
    );
    assert.equal(
      canWriteItem(d, cred(bob.id), it.id),
      false,
      "read sharee cannot write",
    );
    assert.equal(isItemOwner(d, cred(bob.id), it.id), false);

    // Positive: the owner (and a write sharee) can write.
    assert.equal(canWriteItem(d, cred(alice.id), it.id), true);
  });

  test("real app: a read sharee (session) can see the item but cannot mutate it via sync", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const it = createItem(db, DEV, {
      type: "task",
      title: "read-only-target",
      ownerId: alice.id,
    });
    shareItem(db, DEV, it.id, bob.id, "read");
    const app = await realApp(db, deviceId, vapidPublicKey);

    // READ: bob's task list includes the shared item.
    const list = await appFetch(app, "/api/tasks", {
      headers: { Authorization: `Bearer ${createSession(db, bob.id)}` },
    });
    const body = (await list.json()) as { tasks: { id: string }[] };
    assert.ok(
      body.tasks.some((t) => t.id === it.id),
      "read sharee sees the item in the task list",
    );

    // WRITE: bob (his own session — full scopes) pushes a mutation; the data-level read share
    // blocks it (sanitizeOps drops a write to an item the caller only reads).
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        ...SYNC,
        Authorization: `Bearer ${createSession(db, bob.id)}`,
      },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [op(it.id, { title: "hijacked-by-read-sharee" })],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      getItem(db, it.id)?.title,
      "read-only-target",
      "read sharee write denied",
    );
  });

  test("real app: a scoped read-only token (tasks:read) cannot push writes through sync", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const it = createItem(db, DEV, {
      type: "task",
      title: "token-target",
      ownerId: alice.id,
    });
    shareItem(db, DEV, it.id, bob.id, "read");
    const app = await realApp(db, deviceId, vapidPublicKey);

    // A scoped read-only token minted by the read sharee: no write scope → canPushWrites is false,
    // so every pushed write is stripped before it reaches the data-level check (double denial).
    const ro = createToken(db, {
      userId: bob.id,
      name: "ro",
      scopes: ["tasks:read"],
    });
    assert.equal(
      canPushWrites(tokenCred(bob.id, ro.row.scopes)),
      false,
      "read-only token cannot push",
    );

    // A pull still works.
    const pull = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${ro.token}` },
      body: JSON.stringify({ syncEpoch: 1, since: 0 }),
    });
    assert.equal(pull.status, 200, "read-only token may still pull");

    // A write is stripped (stripped at the scope level AND blocked at the data level).
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${ro.token}` },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [op(it.id, { title: "hijacked-by-ro-token" })],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      getItem(db, it.id)?.title,
      "token-target",
      "read-only token write stripped",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. REVOKED — an unshared grant and a revoked API token grant nothing.
// ---------------------------------------------------------------------------

describe("4. revoked grants", () => {
  test("unit: an unshared grant no longer grants access (it did before)", () => {
    const d = coreDb();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const it = createItem(d, DEV, {
      type: "task",
      title: "t",
      ownerId: alice.id,
    });
    shareItem(d, DEV, it.id, bob.id, "write");

    // Before: the write share grants full access.
    assert.equal(canReadItem(d, cred(bob.id), it.id), true);
    assert.equal(canWriteItem(d, cred(bob.id), it.id), true);

    unshareItem(d, DEV, it.id, bob.id); // tombstone the grant

    // After: access is gone (the tombstone row is filtered out of effective shares).
    assert.equal(
      canReadItem(d, cred(bob.id), it.id),
      false,
      "unshared grant no longer reads",
    );
    assert.equal(
      canWriteItem(d, cred(bob.id), it.id),
      false,
      "unshared grant no longer writes",
    );
    assert.equal(effectiveAccess(d, cred(bob.id), it.id), "none");
    assert.equal(hasReadAccess(d, it.id, bob.id), false);

    // Positive: the owner is unaffected by the revoke.
    assert.equal(canWriteItem(d, cred(alice.id), it.id), true);
  });

  test("real app: a revoked API token is rejected by the sync route (401); before revoke it worked", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const it = createItem(db, DEV, {
      type: "task",
      title: "original",
      ownerId: alice.id,
    });
    const app = await realApp(db, deviceId, vapidPublicKey);

    const { token, row } = createToken(db, {
      userId: alice.id,
      name: "t",
      scopes: ["tasks:write"],
    });

    // Before revocation: the token authenticates and its write lands.
    const before = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [op(it.id, { title: "before-revoke" })],
      }),
    });
    assert.equal(before.status, 200, "valid token accepted");
    assert.equal(getItem(db, it.id)?.title, "before-revoke");

    revokeToken(db, row.id); // mark revoked = 1

    // After revocation: basicAuth no longer resolves the secret → 401, and no write.
    const after = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [op(it.id, { title: "after-revoke" })],
      }),
    });
    assert.equal(after.status, 401, "revoked token rejected (401)");
    assert.equal(
      getItem(db, it.id)?.title,
      "before-revoke",
      "revoked token write never lands",
    );

    // A fresh (non-revoked) token for the same user still works — the revoke was targeted.
    const fresh = createToken(db, {
      userId: alice.id,
      name: "t2",
      scopes: ["tasks:write"],
    });
    const freshRes = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${fresh.token}` },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [op(it.id, { title: "fresh-token" })],
      }),
    });
    assert.equal(freshRes.status, 200, "a fresh token still authenticates");
    assert.equal(getItem(db, it.id)?.title, "fresh-token");
  });
});

// ---------------------------------------------------------------------------
// 5. SUBTREE-RESTRICTED — a project share reaches the whole subtree but not a
//    sibling project or a container the caller does not own.
// ---------------------------------------------------------------------------

describe("5. subtree-restricted access", () => {
  test("unit: a write share on a project grants the subtree but not a sibling project", () => {
    const d = coreDb();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });

    const p1 = createItem(d, DEV, {
      type: "project",
      title: "P1",
      ownerId: alice.id,
    });
    const t1 = createItem(d, DEV, {
      type: "task",
      title: "T1",
      ownerId: alice.id,
      parentId: p1.id,
    });
    const p2 = createItem(d, DEV, {
      type: "project",
      title: "P2-sibling",
      ownerId: alice.id,
    });
    const t2 = createItem(d, DEV, {
      type: "task",
      title: "T2",
      ownerId: alice.id,
      parentId: p2.id,
    });

    shareItem(d, DEV, p1.id, bob.id, "write");

    // The shared project + its descendant are reachable.
    assert.equal(
      canReadItem(d, cred(bob.id), p1.id),
      true,
      "share root readable",
    );
    assert.equal(
      canWriteItem(d, cred(bob.id), p1.id),
      true,
      "share root writable",
    );
    assert.equal(
      canReadItem(d, cred(bob.id), t1.id),
      true,
      "descendant readable (inherited)",
    );
    assert.equal(
      canWriteItem(d, cred(bob.id), t1.id),
      true,
      "descendant writable (inherited)",
    );
    assert.ok(subtreeIds(d, [p1.id]).has(t1.id), "T1 is in the P1 subtree");

    // The sibling project and its descendant are NOT reachable.
    assert.equal(
      canReadItem(d, cred(bob.id), p2.id),
      false,
      "sibling project not readable",
    );
    assert.equal(
      canWriteItem(d, cred(bob.id), p2.id),
      false,
      "sibling project not writable",
    );
    assert.equal(
      canReadItem(d, cred(bob.id), t2.id),
      false,
      "descendant of a sibling not readable",
    );
    assert.equal(
      canWriteItem(d, cred(bob.id), t2.id),
      false,
      "descendant of a sibling not writable",
    );
    assert.equal(effectiveAccess(d, cred(bob.id), t2.id), "none");
  });

  test("unit: a share on an ancestor grants READ (not write) to its descendants", () => {
    const d = coreDb();
    const carol = createUser(d, { username: "carol" });
    const bob = createUser(d, { username: "bob" });
    const c = createItem(d, DEV, {
      type: "project",
      title: "C",
      ownerId: carol.id,
    });
    const tc = createItem(d, DEV, {
      type: "task",
      title: "TC",
      ownerId: carol.id,
      parentId: c.id,
    });

    shareItem(d, DEV, c.id, bob.id, "read"); // READ share on the ancestor

    // Inherited read to the descendant; write is NOT inherited from a read grant.
    assert.equal(
      canReadItem(d, cred(bob.id), c.id),
      true,
      "ancestor readable (read share)",
    );
    assert.equal(
      canWriteItem(d, cred(bob.id), c.id),
      false,
      "ancestor not writable (read share)",
    );
    assert.equal(
      canReadItem(d, cred(bob.id), tc.id),
      true,
      "descendant readable (inherited read)",
    );
    assert.equal(
      canWriteItem(d, cred(bob.id), tc.id),
      false,
      "descendant not writable (inherited read only)",
    );
    assert.equal(effectiveAccess(d, cred(bob.id), tc.id), "read");

    // Positive: a WRITE share on the same ancestor would have granted write to the descendant.
    const d2 = coreDb();
    const carol2 = createUser(d2, { username: "carol" });
    const c2 = createItem(d2, DEV, {
      type: "project",
      title: "C",
      ownerId: carol2.id,
    });
    const tc2 = createItem(d2, DEV, {
      type: "task",
      title: "TC",
      ownerId: carol2.id,
      parentId: c2.id,
    });
    shareItem(d2, DEV, c2.id, bob.id, "write");
    assert.equal(
      canWriteItem(d2, cred(bob.id), tc2.id),
      true,
      "descendant writable under a write share",
    );
  });

  test("real app: a write sharee can create inside the shared project, not a sibling project", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const p1 = createItem(db, DEV, {
      type: "project",
      title: "P1",
      ownerId: alice.id,
    });
    const p2 = createItem(db, DEV, {
      type: "project",
      title: "P2",
      ownerId: alice.id,
    });
    shareItem(db, DEV, p1.id, bob.id, "write");
    const app = await realApp(db, deviceId, vapidPublicKey);

    const bobSession = createSession(db, bob.id);
    // Legit: create inside the shared project.
    const ok = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${bobSession}` },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [op("in-p1", { type: "task", title: "legit", parent_id: p1.id })],
      }),
    });
    assert.equal(ok.status, 200);
    assert.ok(getItem(db, "in-p1"), "create inside a shared project allowed");

    // Denied: create inside the sibling project bob does not own.
    const denied = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${bobSession}` },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [
          op("in-p2", { type: "task", title: "infiltrate", parent_id: p2.id }),
        ],
      }),
    });
    assert.equal(denied.status, 200);
    assert.equal(
      getItem(db, "in-p2"),
      undefined,
      "create inside an unowned sibling project denied",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. THE THREE CARRIED FINDINGS — re-denied end-to-end through the real app.
// ---------------------------------------------------------------------------

describe("6. carried findings re-denied via the real app", () => {
  test("finding #1: a read-only (tasks:read) owner token cannot mutate via sync", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const it = createItem(db, DEV, {
      type: "task",
      title: "original",
      ownerId: alice.id,
    });
    const app = await realApp(db, deviceId, vapidPublicKey);

    const ro = createToken(db, {
      userId: alice.id,
      name: "ro",
      scopes: ["tasks:read"],
    });
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${ro.token}` },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [op(it.id, { title: "hijacked-via-read-token" })],
      }),
    });
    assert.equal(res.status, 200, "read-only token may still pull");
    assert.equal(
      getItem(db, it.id)?.title,
      "original",
      "read-only token write denied",
    );
  });

  test("finding #2: a write cannot create inside another owner's inaccessible project", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const proj = createItem(db, DEV, {
      type: "project",
      title: "private",
      ownerId: alice.id,
    });
    const app = await realApp(db, deviceId, vapidPublicKey);

    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        ...SYNC,
        Authorization: `Bearer ${createSession(db, bob.id)}`,
      },
      body: JSON.stringify({
        syncEpoch: 1,
        ops: [
          op("infiltrate-1", {
            type: "task",
            title: "infiltrate",
            parent_id: proj.id,
          }),
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      getItem(db, "infiltrate-1"),
      undefined,
      "foreign-destination create denied",
    );
  });

  test("finding #3: a forged share (colliding row_id + mismatched item_id) cannot upgrade a read grant", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const J = createItem(db, DEV, {
      type: "task",
      title: "j",
      ownerId: alice.id,
    });
    const I = createItem(db, DEV, {
      type: "task",
      title: "i",
      ownerId: bob.id,
    });
    shareItem(db, DEV, J.id, bob.id, "read"); // bob has a READ grant on J
    const app = await realApp(db, deviceId, vapidPublicKey);

    // bob pushes a share whose row_id is J's existing read grant but whose item_id points at
    // I — a non-owner permission upgrade onto a mismatched item.
    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        ...SYNC,
        Authorization: `Bearer ${createSession(db, bob.id)}`,
      },
      body: JSON.stringify({
        syncEpoch: 1,
        recordOps: [
          rec("share", shareRowId(J.id, bob.id), {
            id: shareRowId(J.id, bob.id),
            item_id: I.id,
            user_id: bob.id,
            permission: "write",
          }),
        ],
      }),
    });
    assert.equal(res.status, 200);
    const grant = db.get<{ permission: string }>(
      "SELECT permission FROM shares WHERE id = ?",
      [shareRowId(J.id, bob.id)],
    );
    assert.equal(
      grant?.permission,
      "read",
      "forged share dropped; grant stays read",
    );
    assert.equal(
      canWriteItem(db, cred(bob.id), J.id),
      false,
      "bob still only reads J",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. OWNER-ONLY ONWARD SHARING — only the owner grants access; a non-owner may
//    only remove their OWN grant.
// ---------------------------------------------------------------------------

describe("7. owner-only onward sharing", () => {
  test("unit: a non-owner sharee cannot grant a third party access; the owner can", () => {
    const d = coreDb();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const carol = createUser(d, { username: "carol" });
    const it = createItem(d, DEV, {
      type: "task",
      title: "t",
      ownerId: alice.id,
    });
    shareItem(d, DEV, it.id, bob.id, "write"); // bob is a write sharee (not the owner)

    // bob cannot grant carol access (onward share denied).
    const onward = validateRecordOp(d, cred(bob.id), {
      id: "s1",
      entity: "share",
      row_id: shareRowId(it.id, carol.id),
      ts: 1,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, carol.id),
        item_id: it.id,
        user_id: carol.id,
        permission: "write",
      },
    });
    assert.equal(onward, null, "non-owner onward share dropped");

    // Positive: the OWNER can grant carol access.
    const byOwner = validateRecordOp(d, cred(alice.id), {
      id: "s2",
      entity: "share",
      row_id: shareRowId(it.id, carol.id),
      ts: 1,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, carol.id),
        item_id: it.id,
        user_id: carol.id,
        permission: "write",
      },
    });
    assert.ok(byOwner, "owner onward share kept");
  });

  test("unit: a non-owner may only remove their OWN grant (not upgrade it)", () => {
    const d = coreDb();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const it = createItem(d, DEV, {
      type: "task",
      title: "t",
      ownerId: alice.id,
    });
    shareItem(d, DEV, it.id, bob.id, "write");

    // Removing their own grant is allowed.
    const remove = validateRecordOp(d, cred(bob.id), {
      id: "s3",
      entity: "share",
      row_id: shareRowId(it.id, bob.id),
      ts: 1,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, bob.id),
        item_id: it.id,
        user_id: bob.id,
        deleted: true,
      },
    });
    assert.ok(remove, "own grant removal kept");

    // ...but upgrading their own grant (identity matches, not a removal) is denied.
    const upgrade = validateRecordOp(d, cred(bob.id), {
      id: "s4",
      entity: "share",
      row_id: shareRowId(it.id, bob.id),
      ts: 1,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, bob.id),
        item_id: it.id,
        user_id: bob.id,
        permission: "write",
      },
    });
    assert.equal(upgrade, null, "non-owner self-grant upgrade dropped");

    // A batch of mixed ops keeps only the allowed one.
    const [kept] = validateRecordOps(d, cred(bob.id), [
      {
        id: "s5",
        entity: "share",
        row_id: shareRowId(it.id, carolId(d)),
        ts: 1,
        device_id: "dev",
        data: {
          id: shareRowId(it.id, carolId(d)),
          item_id: it.id,
          user_id: carolId(d),
          permission: "write",
        },
      },
      remove,
    ]);
    assert.ok(
      kept,
      "mixed batch drops the disallowed op, keeps the allowed one",
    );
  });

  test("real app: a non-owner write sharee cannot onward-share; they can drop their own grant", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const carol = createUser(db, { username: "carol" });
    const it = createItem(db, DEV, {
      type: "task",
      title: "t",
      ownerId: alice.id,
    });
    const bobGrant = shareItem(db, DEV, it.id, bob.id, "write");
    const app = await realApp(db, deviceId, vapidPublicKey);

    const bobSession = createSession(db, bob.id);
    // Onward share to carol — dropped.
    const onward = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${bobSession}` },
      body: JSON.stringify({
        syncEpoch: 1,
        recordOps: [
          rec("share", shareRowId(it.id, carol.id), {
            id: shareRowId(it.id, carol.id),
            item_id: it.id,
            user_id: carol.id,
            permission: "write",
          }),
        ],
      }),
    });
    assert.equal(onward.status, 200);
    assert.equal(
      hasReadAccess(db, it.id, carol.id),
      false,
      "carol gains no access from a non-owner onward share",
    );

    // Bob drops his own grant — kept. A real client pushes the FULL share row (a tombstone),
    // so the record merge (LWW on updated_at, NOT NULL columns) applies it.
    const tombstone = {
      ...bobGrant,
      deleted: true,
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const remove = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: { ...SYNC, Authorization: `Bearer ${bobSession}` },
      body: JSON.stringify({
        syncEpoch: 1,
        recordOps: [rec("share", bobGrant.id, tombstone)],
      }),
    });
    assert.equal(remove.status, 200);
    assert.equal(
      hasReadAccess(db, it.id, bob.id),
      false,
      "bob loses access after dropping his own grant",
    );
    assert.equal(canWriteItem(db, cred(bob.id), it.id), false);
  });
});

// ---------------------------------------------------------------------------
// 8. COMMENT MANAGEMENT — only a comment's author or the item's owner may edit /
//    delete that comment.
// ---------------------------------------------------------------------------

describe("8. comment management", () => {
  test("unit: a read sharee cannot edit another user's comment", () => {
    const d = coreDb();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const it = createItem(d, DEV, {
      type: "task",
      title: "t",
      ownerId: alice.id,
    });
    shareItem(d, DEV, it.id, bob.id, "read"); // bob can read it (so the read bar passes)
    const aliceComment = addComment(d, DEV, {
      itemId: it.id,
      authorId: alice.id,
      body: "mine",
    });

    // bob (not the author, not the item owner) cannot edit alice's comment.
    const edit = validateRecordOp(d, cred(bob.id), {
      id: "c1",
      entity: "comment",
      row_id: aliceComment.id,
      ts: 1,
      device_id: "dev",
      data: {
        id: aliceComment.id,
        item_id: it.id,
        author_id: bob.id,
        body: "hijack",
      },
    });
    assert.equal(edit, null, "mismatched-author comment edit dropped");

    // bob cannot touch a comment on an item he cannot read at all.
    const stranger = createItem(d, DEV, {
      type: "task",
      title: "other",
      ownerId: alice.id,
    });
    const strangerComment = addComment(d, DEV, {
      itemId: stranger.id,
      authorId: alice.id,
      body: "x",
    });
    const noRead = validateRecordOp(d, cred(bob.id), {
      id: "c2",
      entity: "comment",
      row_id: strangerComment.id,
      ts: 1,
      device_id: "dev",
      data: {
        id: strangerComment.id,
        item_id: stranger.id,
        author_id: bob.id,
        body: "x",
      },
    });
    assert.equal(
      noRead,
      null,
      "comment on an unreadable item dropped (no read access)",
    );

    // Positive: the author can edit their own comment.
    const bobComment = addComment(d, DEV, {
      itemId: it.id,
      authorId: bob.id,
      body: "bob's",
    });
    const own = validateRecordOp(d, cred(bob.id), {
      id: "c3",
      entity: "comment",
      row_id: bobComment.id,
      ts: 1,
      device_id: "dev",
      data: {
        id: bobComment.id,
        item_id: it.id,
        author_id: bob.id,
        body: "bob edited",
      },
    });
    assert.ok(own, "author may manage their own comment");

    // Positive: the item OWNER may delete a sharee's comment.
    const byOwner = validateRecordOp(d, cred(alice.id), {
      id: "c4",
      entity: "comment",
      row_id: bobComment.id,
      ts: 1,
      device_id: "dev",
      data: {
        id: bobComment.id,
        item_id: it.id,
        author_id: bob.id,
        deleted: true,
      },
    });
    assert.ok(byOwner, "item owner may delete a sharee's comment");
  });

  test("unit: a read sharee cannot author a comment as someone else (author is forced to the caller)", () => {
    const d = coreDb();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const it = createItem(d, DEV, {
      type: "task",
      title: "t",
      ownerId: alice.id,
    });
    shareItem(d, DEV, it.id, bob.id, "read");

    // bob pushes a NEW comment (no existing row) but claims author_id = alice. The
    // sanitizer keeps it (bob can read the item) but forces the author to the caller —
    // a forged attribution is never accepted.
    const forged = validateRecordOp(d, cred(bob.id), {
      id: "c5",
      entity: "comment",
      row_id: "c5",
      ts: 1,
      device_id: "dev",
      data: {
        id: "c5",
        item_id: it.id,
        author_id: alice.id,
        body: "pretending-to-be-alice",
      },
    });
    assert.ok(forged, "a new comment on a readable item is accepted");
    assert.equal(
      (forged!.data as { author_id: string }).author_id,
      bob.id,
      "new comment author forced to the caller, not the claimed author",
    );

    // A read sharee cannot author a comment on an item they cannot read at all.
    const stranger = createItem(d, DEV, {
      type: "task",
      title: "other",
      ownerId: alice.id,
    });
    const noRead = validateRecordOp(d, cred(bob.id), {
      id: "c6",
      entity: "comment",
      row_id: "c6",
      ts: 1,
      device_id: "dev",
      data: { id: "c6", item_id: stranger.id, author_id: alice.id, body: "x" },
    });
    assert.equal(noRead, null, "new comment on an unreadable item dropped");
  });

  test("real app: a read sharee cannot overwrite another user's comment through sync", async () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    const alice = createUser(db, { username: "alice" });
    const bob = createUser(db, { username: "bob" });
    const it = createItem(db, DEV, {
      type: "task",
      title: "j",
      ownerId: alice.id,
    });
    shareItem(db, DEV, it.id, bob.id, "read"); // bob can read it (so the read bar passes)
    const aliceComment = addComment(db, DEV, {
      itemId: it.id,
      authorId: alice.id,
      body: "original",
    });
    const app = await realApp(db, deviceId, vapidPublicKey);

    const res = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        ...SYNC,
        Authorization: `Bearer ${createSession(db, bob.id)}`,
      },
      body: JSON.stringify({
        syncEpoch: 1,
        recordOps: [
          rec("comment", aliceComment.id, {
            id: aliceComment.id,
            item_id: it.id,
            author_id: bob.id,
            body: "hijacked",
          }),
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = db.get<{ body: string }>(
      "SELECT body FROM comments WHERE id = ?",
      [aliceComment.id],
    );
    assert.equal(
      body?.body,
      "original",
      "cross-record comment overwrite denied",
    );

    // Positive: the author can edit their own comment through sync. A real client pushes the
    // FULL comment row (a future updated_at wins the LWW merge), so the edit lands.
    const bobComment = addComment(db, DEV, {
      itemId: it.id,
      authorId: bob.id,
      body: "bob",
    });
    const editData = {
      ...bobComment,
      body: "bob edited",
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const own = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        ...SYNC,
        Authorization: `Bearer ${createSession(db, bob.id)}`,
      },
      body: JSON.stringify({
        syncEpoch: 1,
        recordOps: [rec("comment", bobComment.id, editData)],
      }),
    });
    assert.equal(own.status, 200);
    const ownBody = db.get<{ body: string }>(
      "SELECT body FROM comments WHERE id = ?",
      [bobComment.id],
    );
    assert.equal(
      ownBody?.body,
      "bob edited",
      "author may edit their own comment through sync",
    );
  });
});

// A tiny helper used once in category 7 (a third-party id that may not yet exist as a user row).
function carolId(d: Db): string {
  const u = createUser(d, { username: "carol" });
  return u.id;
}
