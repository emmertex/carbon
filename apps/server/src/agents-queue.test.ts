/** Agent job queue bounds: per-tenant cap (drop + done) and per-job timeout. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueue } from "./agents";

test("jobs beyond the per-tenant cap are dropped and their done() runs", async () => {
  let releaseFirst!: () => void;
  const first = new Promise<void>((r) => (releaseFirst = r));
  const ran: number[] = [];
  const done: number[] = [];
  const tenant = `cap-${Math.random()}`;
  // Job 0 starts immediately (leaves the queue); jobs 1-2 wait; job 3 exceeds maxJobs=2.
  const results = [0, 1, 2, 3].map((i) =>
    enqueue(
      tenant,
      async () => {
        ran.push(i);
        if (i === 0) await first;
      },
      () => done.push(i),
      { maxJobs: 2 },
    ),
  );
  assert.deepEqual(results, [true, true, true, false]);
  assert.deepEqual(done, [3]);
  releaseFirst();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, [0, 1, 2]);
  assert.deepEqual(done.sort(), [0, 1, 2, 3]);
});

test("a hung job times out so the queue moves on; done() waits for the real settle", async () => {
  let unhang!: () => void;
  const hang = new Promise<void>((r) => (unhang = r));
  const events: string[] = [];
  const tenant = `timeout-${Math.random()}`;
  const limits = { timeoutMs: 20 };
  enqueue(tenant, () => hang, () => events.push("hung-done"), limits);
  enqueue(tenant, async () => void events.push("second-ran"), undefined, limits);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, ["second-ran"]);
  unhang();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(events, ["second-ran", "hung-done"]);
});
