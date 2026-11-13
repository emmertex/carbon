import assert from "node:assert/strict";
import { test } from "node:test";
const values = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() {
      return values.size;
    },
  },
  window: new EventTarget(),
  document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
});
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
});
const db = await import("./db");
const kv = new Map<string, unknown>();
let snapshotWrites = 0;
const store = {
  get: async (k: string) => kv.get(k),
  put: async (k: string, v: unknown) => {
    if (k.startsWith("db|")) snapshotWrites++;
    kv.set(k, v);
  },
  del: async (k: string) => {
    kv.delete(k);
  },
};
db.setKvSeam({
  ...store,
  transaction: async (fn) => {
    await fn(store);
  },
});
db.setBcFactory(() => ({ onmessage: null, postMessage() {}, close() {} }));
const config = await import("./config");
const state = await import("./store");
const sync = await import("./sync");

test("a truncated pull drains without per-round identity, persist or re-render", async () => {
  values.set(
    "carbon.server",
    JSON.stringify({
      ...config.getServerConfig(),
      url: "http://sync-drain",
      token: "token",
      username: "alice",
    }),
  );
  const user = { id: "alice", username: "alice", open: false, role: "member" };
  config.saveCurrentUser(user as never);
  state.useStore.getState().setCurrentUser(user as never);
  await db.rebindIdentity();

  const PAGES = 6;
  let me = 0;
  const sinces: number[] = [];
  let bumps = 0;
  const unsub = state.useStore.subscribe((s, prev) => {
    if (s.dbRevision !== prev.dbRevision) bumps++;
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/me")) {
      me++;
      return Response.json(user);
    }
    if (String(url).endsWith("/api/sync")) {
      const body = JSON.parse(String(init?.body));
      sinces.push(body.since);
      const page = sinces.length;
      return Response.json({
        ops: [],
        recordOps: [],
        users: [],
        cursor: page * 10,
        rcursor: 0,
        syncEpoch: 3,
        truncated: page < PAGES,
        acknowledged: { ops: [], recordOps: [] },
      });
    }
    return Response.json({});
  }) as typeof fetch;
  try {
    const writesBefore = snapshotWrites;
    await sync.syncNow();
    const deadline = Date.now() + 5000;
    while (
      (sinces.length < PAGES ||
        state.useStore.getState().syncStatus !== "idle") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 10));
    await db.flushPersist();
    assert.deepEqual(sinces, [0, 10, 20, 30, 40, 50], "cursor advances every page");
    assert.equal(db.getMeta("last_sync_seq"), "60");
    assert.equal(me, 1, "identity fetched once for the whole drain");
    assert.ok(bumps <= 2, `UI re-rendered ${bumps}× (expected ≤2)`);
    assert.ok(
      snapshotWrites - writesBefore <= 3,
      `whole-DB snapshot written ${snapshotWrites - writesBefore}× over ${PAGES} pages`,
    );
  } finally {
    unsub();
  }
});
