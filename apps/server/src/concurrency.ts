// ----- concurrency primitives (A2) ---------------------------------------------
// Bounded, reject-on-full (429) and queue-on-full (Semaphore) concurrency controls.
//
// A "gate" counts how many units of work are currently INSIDE a boundary and rejects
// a new one (tryEnter → false) when the limit is reached. It never queues: a rejected
// caller gets a 429 / is skipped, so a burst can't pile up unbounded work. This is the
// right shape for HTTP concurrency (global / per-tenant / per-user): rejecting keeps
// the scheduler bounded and the client is told to retry via Retry-After.
//
// A "semaphore" instead queues: an over-limit caller WAITS for a free slot. That is the
// right shape for background fan-out (web-push sends) where we want to drain the work
// at a bounded rate rather than drop it.
//
// Both are plain objects with no timer / handle of their own, so they're trivially
// testable and leak-free: nothing is retained after release/exit.

/** Reject-on-full in-flight counter. `limit <= 0` means unlimited (always enters). */
export class ConcurrencyGate {
  private active = 0;
  constructor(private readonly limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  /** Claim a slot; false when at capacity (caller should 429 / skip). */
  tryEnter(): boolean {
    if (this.limit <= 0 || this.active >= this.limit) return this.limit <= 0;
    this.active++;
    return true;
  }

  /** Release a slot claimed by tryEnter. Idempotent-safe at the floor. */
  exit(): void {
    if (this.active > 0) this.active--;
  }
}

/**
 * A per-key (e.g. per-user) set of ConcurrencyGates, lazily created and pruned when a
 * key's count returns to zero, so the map can't grow without bound across a long-lived
 * server. `limit <= 0` = unlimited.
 */
export class KeyedConcurrency {
  private counts = new Map<string, number>();
  constructor(private readonly limit: number) {}

  /** Claim a slot for `key`; false when that key is at capacity. */
  tryEnter(key: string): boolean {
    if (this.limit <= 0) return true;
    const n = (this.counts.get(key) ?? 0) + 1;
    if (n > this.limit) return false;
    this.counts.set(key, n);
    return true;
  }

  exit(key: string): void {
    const n = this.counts.get(key);
    if (n === undefined || n <= 1) this.counts.delete(key);
    else this.counts.set(key, n - 1);
  }

  get size(): number {
    return this.counts.size;
  }
}

/** Queue-on-full bounded-concurrency semaphore for background fan-out. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(
    private readonly limit: number,
    private readonly maxWaiters = 128,
  ) {}

  private get cap(): number {
    return this.limit <= 0 ? Infinity : this.limit;
  }

  async acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active++;
      return;
    }
    // At capacity: wait. When woken, we TAKE OVER the releasing side's slot —
    // `release()` does not decrement active for a transferred slot, so we must not
    // increment either (or the count drifts upward and the bound is silently lost).
    if (this.waiters.length >= this.maxWaiters)
      throw new Error("outbound queue full; retry later");
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next)
      next(); // slot transferred to the next waiter; active unchanged
    else this.active = Math.max(0, this.active - 1);
  }

  /** Run `fn` under the bound; resolves to fn's result, or rethrows. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
