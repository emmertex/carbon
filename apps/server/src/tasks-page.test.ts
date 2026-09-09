import assert from "node:assert/strict";
import { test } from "node:test";
import { createItem, shareItem } from "@carbon/core";
import { makeTestDb } from "./test-app";
import { taskPage } from "./tasks-page";

test("SQL task paging filters before paging and byte limits preserve the next offset", () => {
  const { db } = makeTestDb();
  for (let i = 0; i < 25; i++)
    createItem(db, "d", { title: `private-${i}`, ownerId: "other" });
  const root = createItem(db, "d", {
    title: "shared",
    type: "project",
    ownerId: "other",
  });
  shareItem(db, "d", root.id, "reader", "read");
  for (let i = 0; i < 10; i++)
    createItem(db, "d", {
      title: `visible-${i}`,
      note: "界".repeat(1000),
      ownerId: "other",
      parentId: root.id,
    });
  const seen = new Set<string>();
  let offset = 0;
  do {
    const page = taskPage(
      db,
      "reader",
      false,
      { limit: 100, offset, project: root.id },
      12000,
    );
    assert.equal(page.total, 10);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 12000);
    for (const item of page.tasks) {
      assert.ok(!seen.has(item.id));
      seen.add(item.id);
    }
    if (page.next_offset == null) break;
    assert.ok(page.next_offset > offset);
    offset = page.next_offset;
  } while (offset < 10);
  assert.equal(seen.size, 10);
});
