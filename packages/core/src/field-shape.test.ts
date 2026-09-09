import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  opShapeError,
  recordOpShapeError,
  ITEM_FIELD_CONTRACT,
} from "./field-shape";
import type { Op, ItemPatch } from "./types";
import type { RecordOp } from "./records";

const base: Op = {
  id: "op-1",
  item_id: "item-1",
  ts: Date.now(),
  device_id: "dev-1",
  fields: { title: "x" },
};

/** An op carrying arbitrary (possibly mistyped) fields — the tests deliberately
 *  pass values the ItemPatch TYPE rejects; the runtime contract is what's under test. */
function opWith(fields: unknown): Op {
  return { ...base, fields: fields as ItemPatch };
}

const baseRec = (data: Record<string, unknown>): RecordOp => ({
  id: "r-1",
  entity: "attachment",
  row_id: "att-1",
  ts: Date.now(),
  device_id: "dev-1",
  data,
});

describe("field-shape contract (A4)", () => {
  test("well-formed ops pass", () => {
    assert.equal(opShapeError(base), null);
    assert.equal(
      opShapeError(
        opWith({
          type: "task",
          title: "t",
          status: "active",
          flagged: true,
          priority: 1,
          due_date: null,
          recurrence: JSON.stringify({ type: "daily", interval: 1 }),
          geo: { lat: 1, lng: 2 },
          metadata: { k: "v" },
          deleted: false,
        }),
      ),
      null,
      "JSON fields accept strings AND decoded objects (legacy/foreign ops)",
    );
  });

  test("mistyped values are rejected with actionable reasons", () => {
    assert.match(
      opShapeError(opWith({ title: { a: 1 } }))!,
      /title must be a string/,
    );
    assert.match(
      opShapeError(opWith({ status: 123 }))!,
      /status must be one of/,
    );
    assert.match(
      opShapeError(opWith({ flagged: "yes" }))!,
      /flagged must be a boolean/,
    );
    assert.match(
      opShapeError(opWith({ priority: "high" }))!,
      /priority must be a finite number/,
    );
    assert.match(
      opShapeError(opWith({ title: null }))!,
      /title must not be null/,
    );
  });

  test("unknown fields are rejected", () => {
    assert.match(
      opShapeError(opWith({ bogus_field: 1 }))!,
      /unknown field "bogus_field"/,
    );
  });

  test("date fields must be parseable ISO-8601 (LWW on dates is lexicographic)", () => {
    assert.equal(
      opShapeError(opWith({ due_date: "2026-09-06T12:00:00Z" })),
      null,
    );
    assert.equal(opShapeError(opWith({ due_date: "2026-09-06" })), null);
    assert.equal(opShapeError(opWith({ due_date: null })), null);
    assert.match(opShapeError(opWith({ due_date: "not-a-date" }))!, /ISO-8601/);
    // 'zzz' sorts after real dates lexicographically — exactly the poisoning vector.
    assert.match(opShapeError(opWith({ due_date: "zzz" }))!, /ISO-8601/);
  });

  test("op envelope: positive finite ts, non-empty ids, device_id required", () => {
    assert.match(opShapeError({ ...base, ts: 0 })!, /op\.ts/);
    assert.match(opShapeError({ ...base, ts: -5 } as unknown as Op)!, /op\.ts/);
    assert.match(
      opShapeError({ ...base, ts: NaN } as unknown as Op)!,
      /op\.ts/,
    );
    assert.match(opShapeError({ ...base, id: "" })!, /op\.id/);
    assert.match(
      opShapeError({ ...base, device_id: null } as unknown as Op)!,
      /device_id/,
    );
  });

  test("contract covers every ItemPatch field exactly once", () => {
    assert.equal(Object.keys(ITEM_FIELD_CONTRACT).length, 26);
  });

  test("record ops: attachment hash is the content reference (finding #2)", () => {
    const okData: Record<string, unknown> = {
      id: "att-1",
      parent_type: "item",
      parent_id: "item-1",
      item_id: "item-1",
      filename: "f.bin",
      mime_type: null,
      size: 10,
      hash: "a".repeat(64),
      created_by: null,
      created_at: new Date().toISOString(),
      deleted: false,
    };
    assert.equal(recordOpShapeError(baseRec(okData)), null);
    assert.match(
      recordOpShapeError(baseRec({ ...okData, hash: "nope" }))!,
      /attachment\.hash/,
    );
    assert.match(
      recordOpShapeError(baseRec({ ...okData, hash: null }))!,
      /attachment\.hash/,
    );
    assert.match(
      recordOpShapeError(baseRec({ ...okData, size: -1 }))!,
      /attachment\.size/,
    );
    assert.match(
      recordOpShapeError(baseRec({ ...okData, filename: "" }))!,
      /attachment\.filename/,
    );
  });

  test("record ops: tag name / share user_id / timelog start_time", () => {
    const tag = { ...baseRec({ name: "" }), entity: "tag", row_id: "t-1" };
    assert.match(recordOpShapeError(tag)!, /tag\.name/);
    assert.equal(
      recordOpShapeError({
        ...tag,
        data: {
          id: "t-1",
          name: "x",
          color: null,
          status: "active",
          sort_order: 0,
          geo: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted: false,
        },
      }),
      null,
      "a valid tag passes",
    );

    const share = {
      ...baseRec({ user_id: "" }),
      entity: "share",
      row_id: "s-1",
    };
    assert.match(recordOpShapeError(share)!, /share\.user_id/);

    const tl = {
      ...baseRec({ start_time: "bogus" }),
      entity: "timelog",
      row_id: "tl-1",
    };
    assert.match(recordOpShapeError(tl)!, /start_time/);
  });

  test("record op envelope: entity/row_id/ts shape", () => {
    const bad = { ...baseRec({}), entity: null } as unknown as RecordOp;
    assert.match(recordOpShapeError(bad)!, /entity/);
    assert.match(
      recordOpShapeError({ ...baseRec({}), ts: 0 })!,
      /op\.ts|record op\.ts/,
    );
  });
});

test("current record rows reject absent/malformed LWW dates and device identifiers", () => {
  const record = {
    ...baseRec({}),
    entity: "share",
    row_id: "share",
    data: {
      id: "share",
      item_id: "item",
      user_id: "user",
      permission: "read",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted: false,
    },
  };
  assert.equal(recordOpShapeError(record), null);
  for (const updated_at of [
    undefined,
    "garbage",
    "2026-02-30T00:00:00.000Z",
    "2026-01-01",
  ]) {
    assert.match(
      recordOpShapeError({ ...record, data: { ...record.data, updated_at } })!,
      /updated_at/,
    );
  }
  assert.match(recordOpShapeError({ ...record, device_id: "" })!, /device_id/);
});

test("every current client record emitted by production repository workflows passes the strict contract", async () => {
  const repo = await import("./repo");
  const { openMemoryDb } = await import("./test-helpers");
  const { getUnsyncedRecordOps } = await import("./records");
  const db = openMemoryDb();
  const a = repo.createItem(db, "d", { title: "a", ownerId: "user" });
  const b = repo.createItem(db, "d", { title: "b", ownerId: "user" });
  repo.shareItem(db, "d", a.id, "reader", "read");
  repo.assignItem(db, "d", a.id, "reader");
  repo.addComment(db, "d", { itemId: a.id, authorId: "user", body: "hello" });
  repo.addAttachment(db, "d", {
    parentType: "item",
    parentId: a.id,
    itemId: a.id,
    filename: "file",
    hash: "a".repeat(64),
    mimeType: null,
    size: 0,
    createdBy: "user",
  });
  repo.startTimer(db, "d", a.id, "user");
  repo.addToPlan(db, "d", "user", a.id);
  const tag = repo.createTag(db, "d", "tag");
  repo.setItemTags(db, "d", a.id, [tag.id]);
  repo.setItemDepLink(db, "d", a.id, b.id, false);
  repo.recordRecordOp(db, "d", "setting", "ui", {
    user_id: "user",
    payload: { density: "compact" },
  });
  const records = getUnsyncedRecordOps(db);
  assert.equal(new Set(records.map((o) => o.entity)).size, 10);
  for (const op of records)
    assert.equal(recordOpShapeError(op), null, op.entity);
  const tagOp = records.find((o) => o.entity === "tag")!;
  assert.match(
    recordOpShapeError({
      ...tagOp,
      data: { ...(tagOp.data as object), status: "dropped" },
    })!,
    /tag.status/,
  );
});
