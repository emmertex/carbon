import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { mkdirSync } from "node:fs";
import {
  createUser,
  createItem,
  getItem,
  shareItem,
  type Op,
} from "@carbon/core";
import { initTenantDb } from "./tenant";
import { createSession } from "./auth";
import { appFetch } from "./test-app";
import type { DeliverToPeer } from "./federation";

/**
 * A4 — carried finding #1: "Malformed sync payload corrupts the shared item."
 *
 * The original review payload — an `ops` array holding a `null` op, alongside a record
 * op with a `null` entity — was ingested at the time of the review and the null op later
 * poisoned item reads for every user. A2's shape validation now rejects that exact entry
 * with a 400 before any ingest; the first test is a regression guard for it and must stay
 * green.
 *
 * The REMAINING hole this phase closes: a well-shaped push whose field VALUES are mistyped
 * (`title: {}`, `status: 123`) passes shape validation, is persisted into the shared `ops`
 * log, and is then echoed to every client's pull — a permanent poison op in the shared log
 * (and data corruption on any peer whose schema applies it). The A4 contract:
 *
 *   - a mistyped / unknown-field entry is rejected PER ENTRY — reported via the response
 *     `rejected` field (count + ids + an actionable reason) — and is never ingested
 *     (no row in `ops`, no materialization, no echo to other clients);
 *   - the rest of the batch still ingests (per-entry model, matching A2's `rejected`
 *     counts): a bad entry never poisons or half-applies a good one;
 *   - the client marks ONLY accepted ops synced (rejected ones stay unsynced and re-push),
 *     so a rejection is never a silent loss.
 */

const TMP = `/tmp/carbon-a4-mal-${process.pid}`;
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

function ctx() {
  mkdirSync(`${TMP}/t`, { recursive: true });
  return initTenantDb({
    id: "default",
    subdomain: "",
    dbPath: `${TMP}/t/carbon.db`,
    blobsDir: `${TMP}/blobs`,
  });
}

interface SyncResp {
  status: number;
  body: {
    error?: string;
    detail?: string;
    ops?: Op[];
    recordOps?: unknown[];
    rejected?: {
      ops: number;
      recordOps: number;
      ops_ids?: string[];
      record_ops_ids?: string[];
      detail?: { index: number; kind: string; reason: string }[];
    };
  };
}

async function sync(
  app: unknown,
  token: string,
  payload: unknown,
): Promise<SyncResp> {
  const res = await appFetch(app as never, "/api/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? { syncEpoch: 1, ...payload }
        : payload,
    ),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as SyncResp["body"],
  };
}

const ts = () => Date.now() + 60_000;

describe("A4 finding #1 — malformed pushes fail without side effects", () => {
  test("review payload (null op + null-entity record op) is a 400; nothing ingested", async () => {
    const t = ctx();
    const alice = createUser(t.db, { username: "alice", displayName: "Alice" });
    const shared = createItem(t.db, "d", {
      type: "project",
      title: "shared",
      ownerId: alice.id,
    });
    const token = createSession(t.db, alice.id);
    const app = (await build())(t, NO_DELIVERY);

    const r = await sync(app, token, {
      since: 0,
      rsince: 0,
      ops: [
        {
          id: "op-a4-good",
          item_id: "a4-mal-good-item",
          ts: ts(),
          device_id: "dev",
          fields: { type: "task", title: "should-not-land" },
        },
        null, // the review's null op entry
      ],
      recordOps: [
        {
          id: "r-a4-bad",
          entity: null, // the review's null entity
          row_id: "x",
          ts: ts(),
          device_id: "dev",
          data: { item_id: shared.id },
        },
      ],
    });
    assert.equal(
      r.status,
      400,
      "the malformed push is rejected before any ingest",
    );
    assert.equal(r.body.error, "invalid_sync_body");
    assert.ok(
      !getItem(t.db, "a4-mal-good-item"),
      "a 400 push is atomic: even the well-formed sibling op must not be ingested",
    );
    assert.equal(
      t.db.get("SELECT 1 AS x FROM record_ops WHERE id = 'r-a4-bad'") ?? null,
      null,
      "the null-entity record op is not ingested",
    );
  });

  test("mistyped field values are rejected per entry and never enter the shared log", async () => {
    const t = ctx();
    const alice = createUser(t.db, { username: "alice", displayName: "Alice" });
    const task = createItem(t.db, "d", {
      title: "original",
      ownerId: alice.id,
    });
    const bob = createUser(t.db, { username: "bob", displayName: "Bob" });
    shareItem(t.db, "d", task.id, bob.id, "write");
    const aliceTok = createSession(t.db, alice.id);
    const bobTok = createSession(t.db, bob.id);
    const app = (await build())(t, NO_DELIVERY);

    const badOp: Op = {
      id: "op-a4-mistyped",
      item_id: task.id,
      ts: ts(),
      device_id: "dev",
      fields: { title: { not: "a string" }, status: 123 },
    } as unknown as Op;
    const r = await sync(app, aliceTok, { ops: [badOp] });
    assert.equal(
      r.status,
      200,
      "a well-shaped push is accepted (per-entry rejection, not 400)",
    );
    assert.equal(
      r.body.rejected?.ops,
      1,
      "the mistyped entry is reported in rejected.ops",
    );
    assert.ok(
      r.body.rejected?.ops_ids?.includes("op-a4-mistyped"),
      "the rejected op id is reported so the client keeps it unsynced",
    );
    assert.ok(
      (r.body.rejected?.detail?.[0]?.reason ?? "").length > 0,
      "the rejection carries an actionable reason",
    );

    // No side effects: not in the shared log, the item is untouched.
    assert.equal(
      t.db.get("SELECT 1 AS x FROM ops WHERE id = 'op-a4-mistyped'") ?? null,
      null,
      "the mistyped op must not be persisted into the shared ops log",
    );
    assert.equal(
      getItem(t.db, task.id)?.title,
      "original",
      "the item is unchanged",
    );

    // And it is not echoed to other clients' pulls (the original poisoning path).
    const pull = await appFetch(app, "/api/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bobTok}`,
      },
      body: JSON.stringify({ syncEpoch: 1, since: 0, rsince: 0 }),
    });
    const pullBody = (await pull.json()) as { ops: { id: string }[] };
    assert.ok(
      !pullBody.ops.some((o) => o.id === "op-a4-mistyped"),
      "the bad op is never sent to other clients",
    );
  });

  test("a batch with one bad entry: good entries ingest, bad entry rejected, no partial application", async () => {
    const t = ctx();
    const alice = createUser(t.db, { username: "alice", displayName: "Alice" });
    const token = createSession(t.db, alice.id);
    const app = (await build())(t, NO_DELIVERY);

    const create: Op = {
      id: "op-a4-create",
      item_id: "a4-mal-batch-item",
      ts: ts(),
      device_id: "dev",
      fields: { type: "task", title: "batch-good" },
    };
    const bad: Op = {
      id: "op-a4-batch-bad",
      item_id: "a4-mal-batch-item",
      ts: ts() + 1,
      device_id: "dev",
      fields: { title: [1, 2, 3], due_date: "not-a-date" } as unknown as Record<
        string,
        unknown
      >,
    } as unknown as Op;
    const r = await sync(app, token, { ops: [create, bad] });
    assert.equal(r.status, 200);
    assert.equal(r.body.rejected?.ops, 1);
    assert.ok(r.body.rejected?.ops_ids?.includes("op-a4-batch-bad"));

    const item = getItem(t.db, "a4-mal-batch-item");
    assert.ok(item, "the good create ingested (per-entry model)");
    assert.equal(
      item?.title,
      "batch-good",
      "the bad entry did not corrupt the good one",
    );
    assert.equal(
      item?.due_date,
      null,
      "no partial application of the bad entry",
    );
    assert.equal(
      t.db.get("SELECT 1 AS x FROM ops WHERE id = 'op-a4-batch-bad'") ?? null,
      null,
      "the bad entry left no row in the shared log",
    );
  });
});
