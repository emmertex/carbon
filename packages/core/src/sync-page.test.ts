import { test } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "./test-helpers";
import { insertOp, markOpsSynced } from "./crdt";
import { pendingSyncPage } from "./sync-page";

test("pending pages bound SQL rows and UTF-8 bytes and drain exactly once", () => {
  const db = openMemoryDb();
  for (let i = 0; i < 40; i++)
    insertOp(
      db,
      {
        id: `op-${i}`,
        item_id: "item",
        ts: i + 1,
        device_id: "peer",
        fields: { note: "界".repeat(200) },
      },
      false,
    );
  const seen = new Set<string>();
  while (true) {
    const page = pendingSyncPage(db, 5, 2048);
    assert.ok(page.ops.length <= 5);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 2048);
    for (const op of page.ops) {
      assert.ok(!seen.has(op.id));
      seen.add(op.id);
    }
    markOpsSynced(
      db,
      page.ops.map((o) => o.id),
    );
    if (!page.hasMore) break;
  }
  assert.equal(seen.size, 40);
  insertOp(
    db,
    {
      id: "huge",
      item_id: "item",
      ts: 50,
      device_id: "peer",
      fields: { note: "界".repeat(5000) },
    },
    false,
  );
  assert.deepEqual(pendingSyncPage(db, 5, 2048).oversized, ["huge"]);
  assert.equal(
    db.get<{ synced: number }>("SELECT synced FROM ops WHERE id = 'huge'")
      ?.synced,
    0,
  );
});
