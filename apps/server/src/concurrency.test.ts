import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { ConcurrencyGate, KeyedConcurrency, Semaphore } from "./concurrency";

describe("ConcurrencyGate (reject-on-full)", () => {
  test("admits up to the limit, then rejects", () => {
    const g = new ConcurrencyGate(2);
    assert.equal(g.tryEnter(), true);
    assert.equal(g.tryEnter(), true);
    assert.equal(g.tryEnter(), false); // at capacity
    g.exit();
    assert.equal(g.tryEnter(), true); // a slot freed
    assert.equal(g.activeCount, 2);
  });

  test("limit 0 = unlimited", () => {
    const g = new ConcurrencyGate(0);
    for (let i = 0; i < 1000; i++) assert.equal(g.tryEnter(), true);
    assert.equal(g.activeCount, 0); // unlimited never counts
  });

  test("exit floors at zero (over-release is safe)", () => {
    const g = new ConcurrencyGate(1);
    g.exit();
    g.exit();
    assert.equal(g.activeCount, 0);
    assert.equal(g.tryEnter(), true);
  });
});

describe("KeyedConcurrency (per-key reject-on-full)", () => {
  test("tracks each key independently against the shared limit", () => {
    const k = new KeyedConcurrency(2);
    assert.equal(k.tryEnter("a"), true);
    assert.equal(k.tryEnter("a"), true);
    assert.equal(k.tryEnter("a"), false); // a at cap
    assert.equal(k.tryEnter("b"), true); // b independent
    assert.equal(k.tryEnter("b"), true);
    k.exit("a");
    assert.equal(k.tryEnter("a"), true); // a freed one
  });

  test("prunes keys back to zero so the map cannot grow unbounded", () => {
    const k = new KeyedConcurrency(1);
    k.tryEnter("x");
    assert.equal(k.size, 1);
    k.exit("x");
    assert.equal(k.size, 0, "key removed at zero");
    k.exit("x"); // over-release is safe
    assert.equal(k.size, 0);
  });

  test("limit 0 = unlimited", () => {
    const k = new KeyedConcurrency(0);
    assert.equal(k.tryEnter("any"), true);
    assert.equal(k.tryEnter("any"), true);
    assert.equal(k.size, 0);
  });
});

describe("Semaphore (queue-on-full)", () => {
  test("bounds concurrent in-flight work to the limit", async () => {
    const sem = new Semaphore(3);
    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    };
    await Promise.all(Array.from({ length: 50 }, () => sem.run(work)));
    assert.equal(peak, 3, `peak concurrency was ${peak}, expected 3`);
  });

  test("completes all queued work in order of admission without deadlock", async () => {
    const sem = new Semaphore(2);
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sem.run(async () => {
          await new Promise((r) => setTimeout(r, 2));
          done.push(i);
        }),
      ),
    );
    assert.equal(done.length, 20, "all work completed");
  });

  test("limit 0 = unlimited (runs everything at once)", async () => {
    const sem = new Semaphore(0);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 30 }, () =>
        sem.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
        }),
      ),
    );
    assert.ok(peak > 5, `peak ${peak} should be unbounded`);
  });
});

test("semaphore rejects beyond the waiter cap and releases slots after errors", async () => {
  const sem = new Semaphore(1, 1);
  await sem.acquire();
  const waiting = sem.acquire();
  await assert.rejects(() => sem.acquire(), /queue full/);
  sem.release();
  await waiting;
  sem.release();
  await assert.rejects(
    () =>
      sem.run(async () => {
        throw new Error("failed");
      }),
    /failed/,
  );
  assert.equal(await sem.run(async () => 42), 42);
});
