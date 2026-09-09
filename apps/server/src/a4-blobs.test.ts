import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createUser, createItem, shareItem, type RecordOp } from "@carbon/core";
import { initTenantDb } from "./tenant";
import { createSession } from "./auth";
import { appFetch } from "./test-app";
import { listOpenNotices } from "./notices";
import type { DeliverToPeer } from "./federation";

/**
 * A4 — carried finding #2: "Blob metadata is synced without content."
 *
 * An `attachment` record op (metadata) could be pushed for a hash whose content was never
 * uploaded (an offline attachment whose upload failed, or was erased on sign-out); every
 * later download then failed. A4 contract:
 *
 *   - **Content and metadata are separate.** Metadata syncs freely, but an attachment whose
 *     hash has no content is *content-pending*, not satisfied: the download is a 404 (never
 *     corrupt bytes), and the server's blob reconcile reports it to the affected item's
 *     owner instead of failing silently.
 *   - **Diverged-blob recovery.** A stored file whose bytes do not hash to its name
 *     (corruption / operator error) is never served: the read path quarantines it
 *     (`<hash>.diverged-<ts>`) and the reconcile reports it; re-uploading the correct
 *     content repairs the reference. Re-uploads always land (an existing-but-diverged
 *     file is replaced, not trusted).
 */

const TMP = `/tmp/carbon-a4-blob-${process.pid}`;
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

/** Each test gets its OWN dbPath + blobsDir so no state leaks between tests. */
function ctx(name: string) {
  mkdirSync(`${TMP}/${name}`, { recursive: true });
  const c = initTenantDb({
    id: "default",
    subdomain: "",
    dbPath: `${TMP}/${name}/carbon.db`,
    blobsDir: `${TMP}/${name}/blobs`,
  });
  return c;
}

const CONTENT = Buffer.from("a4-blob-finding-content-0123456789");
const HASH = createHash("sha256").update(CONTENT).digest("hex");

function attachmentRec(item: { id: string }, hash: string): RecordOp {
  return {
    id: `att-${hash.slice(0, 12)}`,
    entity: "attachment",
    row_id: `att-${hash.slice(0, 12)}`,
    ts: Date.now() + 60_000,
    device_id: "dev",
    data: {
      id: `att-${hash.slice(0, 12)}`,
      parent_type: "item",
      parent_id: item.id,
      item_id: item.id,
      filename: "a4-evidence.bin",
      mime_type: "application/octet-stream",
      size: CONTENT.length,
      hash,
      created_by: null,
      created_at: new Date().toISOString(),
      deleted: false,
    },
  };
}

async function sync(
  app: unknown,
  token: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const negotiation = await appFetch(app as never, "/api/sync", {
    method: "POST",
    headers,
    body: JSON.stringify({ ops: [], recordOps: [] }),
  });
  assert.equal(negotiation.status, 200, "empty push negotiates generation");
  const { syncEpoch } = (await negotiation.json()) as { syncEpoch: number };
  assert.ok(Number.isSafeInteger(syncEpoch) && syncEpoch >= 1);
  return appFetch(app as never, "/api/sync", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, syncEpoch }),
  });
}

describe("A4 finding #2 — blob content is separate from metadata", () => {
  test("metadata without content: 404 (not silent), reconcile reports it, re-upload satisfies", async () => {
    const t = ctx("missing");
    const alice = createUser(t.db, {
      username: "alice",
      displayName: "Alice",
      role: "member",
    });
    const admin = createUser(t.db, {
      username: "admin",
      displayName: "Admin",
      role: "admin",
    });
    const item = createItem(t.db, "d", {
      title: "has-attachment",
      ownerId: alice.id,
    });
    const aliceTok = createSession(t.db, alice.id);
    const adminTok = createSession(t.db, admin.id);
    const app = (await build())(t, NO_DELIVERY);

    // Push ONLY the attachment metadata — the content is never uploaded.
    const rec = attachmentRec(item, HASH);
    let res = await sync(app, aliceTok, { recordOps: [rec] });
    assert.equal(res.status, 200);
    let body = (await res.json()) as { rejected?: { recordOps: number } };
    assert.equal(
      body.rejected?.recordOps ?? 0,
      0,
      "the metadata itself is a legitimate push",
    );
    assert.ok(
      t.db.get("SELECT 1 AS x FROM attachments WHERE hash = ?", [HASH]),
      "the attachment metadata was ingested",
    );

    // The download must not succeed and must not serve anything else: content-pending.
    res = await appFetch(app, `/api/blobs/${HASH}`, {
      headers: { Authorization: `Bearer ${aliceTok}` },
    });
    assert.equal(
      res.status,
      404,
      "no content on the server → 404, not a silent failure",
    );

    // The reconcile reports the missing content to the affected owner (not a silent 404).
    res = await appFetch(app, "/api/admin/blobs/reconcile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTok}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200, "admin reconcile endpoint");
    const report = (await res.json()) as {
      missing: string[];
      diverged: string[];
    };
    assert.ok(
      report.missing.includes(HASH),
      "reconcile reports the content-pending hash",
    );
    const notices = listOpenNotices(t.db, alice.id);
    assert.ok(
      notices.some((n) => n.kind === "blob_content_missing"),
      "the affected owner gets a notice with the recovery path",
    );

    // Recovery: the device that still holds the blob re-uploads the content.
    res = await appFetch(app, `/api/blobs/${HASH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${aliceTok}`,
      },
      body: new Uint8Array(CONTENT),
    });
    assert.equal(
      res.status,
      200,
      "re-upload of the correct content is accepted",
    );

    res = await appFetch(app, `/api/blobs/${HASH}`, {
      headers: { Authorization: `Bearer ${aliceTok}` },
    });
    assert.equal(res.status, 200, "the reference is now satisfied");
    assert.equal(
      Buffer.from(await res.arrayBuffer()).toString(),
      CONTENT.toString(),
    );

    // Reconcile is now clean.
    res = await appFetch(app, "/api/admin/blobs/reconcile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTok}`,
      },
      body: JSON.stringify({}),
    });
    const clean = (await res.json()) as { missing: string[] };
    assert.deepEqual(
      clean.missing,
      [],
      "after re-upload the reconcile is clean",
    );
  });

  test("diverged blob: corrupt file is quarantined, never served, and re-upload repairs it", async () => {
    const t = ctx("diverged");
    const alice = createUser(t.db, { username: "alice", displayName: "Alice" });
    const bob = createUser(t.db, { username: "bob", displayName: "Bob" });
    const item = createItem(t.db, "d", {
      title: "has-attachment",
      ownerId: alice.id,
    });
    shareItem(t.db, "d", item.id, bob.id, "write");
    const aliceTok = createSession(t.db, alice.id);
    const bobTok = createSession(t.db, bob.id);
    const admin = createUser(t.db, {
      username: "admin",
      displayName: "Admin",
      role: "admin",
    });
    const adminTok = createSession(t.db, admin.id);
    const app = (await build())(t, NO_DELIVERY);

    const rec = attachmentRec(item, HASH);
    let res = await sync(app, aliceTok, { recordOps: [rec] });
    assert.equal(res.status, 200);
    res = await appFetch(app, `/api/blobs/${HASH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${aliceTok}`,
      },
      body: new Uint8Array(CONTENT),
    });
    assert.equal(res.status, 200, "content uploaded");

    // Simulate divergence: the stored bytes no longer hash to the name.
    writeFileSync(
      `${TMP}/diverged/blobs/${HASH}`,
      Buffer.from("corrupted-bytes"),
    );

    // The read path must never serve the diverged bytes — it quarantines and 404s.
    // (The owner's token: this assert must hold for hash verification, not access control.)
    res = await appFetch(app, `/api/blobs/${HASH}`, {
      headers: { Authorization: `Bearer ${aliceTok}` },
    });
    assert.equal(res.status, 404, "diverged content is never served");
    assert.ok(
      !existsSync(`${TMP}/diverged/blobs/${HASH}`),
      "the diverged file was quarantined out of the store",
    );
    assert.ok(
      readdirSync(`${TMP}/diverged/blobs`).some((f) =>
        f.startsWith(`${HASH}.diverged-`),
      ),
      "the diverged bytes are kept aside (quarantined, not deleted)",
    );

    // The reconcile reports it as diverged.
    res = await appFetch(app, "/api/admin/blobs/reconcile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTok}`,
      },
      body: JSON.stringify({}),
    });
    const report = (await res.json()) as {
      missing: string[];
      diverged: string[];
    };
    assert.ok(
      report.diverged.includes(HASH),
      "reconcile reports the diverged hash",
    );

    // Recovery: re-uploading the correct content repairs the reference (the upload must
    // land even though the hash was just quarantined).
    res = await appFetch(app, `/api/blobs/${HASH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${aliceTok}`,
      },
      body: new Uint8Array(CONTENT),
    });
    assert.equal(res.status, 200);
    res = await appFetch(app, `/api/blobs/${HASH}`, {
      headers: { Authorization: `Bearer ${bobTok}` },
    });
    assert.equal(res.status, 200, "the reference is repaired");
    assert.equal(
      Buffer.from(await res.arrayBuffer()).toString(),
      CONTENT.toString(),
      "served bytes are the correct content",
    );
  });
});
