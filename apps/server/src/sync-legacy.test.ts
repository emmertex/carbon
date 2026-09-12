import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, insertRecordOp, recordOpShapeError } from "@carbon/core";
import { openDb } from "./sqlite";
import { pullSyncPage } from "./sync-pull";
import { legacyRecordData } from "./sync-legacy";

const date = "2026-06-22T06:15:53.293Z";
test("historical records pull as current rows without rewriting history or cursors", () => {
  const db = openDb(":memory:");
  try {
    migrate(db);
    const rows = [
      {
        entity: "tag",
        data: {
          id: "tag",
          name: "Example",
          color: null,
          created_at: date,
          updated_at: date,
          deleted: false,
        },
      },
      {
        entity: "timelog",
        data: {
          id: "timer",
          item_id: "item",
          user_id: null,
          start_time: date,
          end_time: null,
          note: null,
          created_at: date,
        },
      },
    ];
    for (const [i, row] of rows.entries())
      insertRecordOp(
        db,
        {
          ...row,
          id: `op-${i}`,
          row_id: row.data.id,
          ts: 1,
          device_id: "old-client",
        },
        true,
      );
    const before = db.all("SELECT rowid, * FROM record_ops");
    const result = pullSyncPage(db, "local", 0, 0, [], undefined, {
      count: 10,
      bytes: 100000,
      scan: 100,
    });
    assert.equal(result.recordOps.length, 2);
    for (const op of result.recordOps)
      assert.equal(recordOpShapeError(op), null);
    assert.equal(result.rcursor, 2);
    assert.deepEqual(db.all("SELECT rowid, * FROM record_ops"), before);
  } finally {
    db.raw.close();
  }
});

test("defaults preserve explicit values and use the historical timer end time", () => {
  const data = { status: "on-hold", sort_order: 7, geo: "location" };
  assert.deepEqual(legacyRecordData("tag", data), data);
  assert.equal((legacyRecordData("tag", { status: null }) as any).status, null);
  assert.equal(
    (
      legacyRecordData("timelog", {
        start_time: date,
        end_time: "2026-06-23T00:00:00.000Z",
      }) as any
    ).updated_at,
    "2026-06-23T00:00:00.000Z",
  );
  const current = {
    updated_at: date,
    kind: "pause",
    session_id: "s",
    deleted: true,
  };
  assert.deepEqual(legacyRecordData("timelog", current), current);
  assert.equal(legacyRecordData("tag", null), null);
});
