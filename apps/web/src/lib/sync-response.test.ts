import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSyncResponse } from "./sync-response";
const valid = {
  ops: [],
  recordOps: [],
  users: [],
  cursor: 4,
  rcursor: 5,
  syncEpoch: 1,
  acknowledged: { ops: [], recordOps: [] },
};
test("malformed sync response cannot poison cursor state or acknowledge work", () => {
  assert.doesNotThrow(() => assertSyncResponse(valid, 4, 5));
  for (const patch of [
    { cursor: "bad" },
    { cursor: 3 },
    { rcursor: NaN },
    { syncEpoch: 0 },
    { ops: null },
    { recordOps: [null] },
    { users: [null] },
    { acknowledged: {} },
    { backfill: { root: "root", cursor: -1, rcursor: 0, done: true } },
  ]) {
    assert.throws(() => assertSyncResponse({ ...valid, ...patch }, 4, 5));
  }
});
