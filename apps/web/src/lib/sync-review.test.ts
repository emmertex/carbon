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
const store = {
  get: async (k: string) => kv.get(k),
  put: async (k: string, v: unknown) => {
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
const core = await import("@carbon/core");
const realFetch = globalThis.fetch;

test("actual sync negotiates before push and never acknowledges a missing ack response", async () => {
  values.set(
    "carbon.server",
    JSON.stringify({
      ...config.getServerConfig(),
      url: "http://sync-review",
      token: "token",
      username: "alice",
    }),
  );
  const user = {
    id: "alice",
    username: "alice",
    open: false,
    role: "member" as const,
  };
  config.saveCurrentUser(user as never);
  state.useStore.getState().setCurrentUser(user as never);
  await db.rebindIdentity();
  const pending = core.recordOp(db.getDb(), "device", "pending", {
    type: "task",
    title: "offline",
  });
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).endsWith("/api/me")) return Response.json(user);
    if (String(url).endsWith("/api/sync")) {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return Response.json({
        ops: [],
        recordOps: [],
        users: [],
        cursor: 0,
        rcursor: 0,
        syncEpoch: 7,
        ...(requests.length === 1
          ? { acknowledged: { ops: [], recordOps: [] } }
          : {}),
      });
    }
    return Response.json({});
  }) as typeof fetch;
  try {
    await sync.syncNow();
    assert.deepEqual(
      requests[0].ops,
      [],
      "first bind negotiates without writes",
    );
    assert.equal(sync.getLocalSyncEpoch(), 7);
    await sync.syncNow();
    assert.equal(requests[1].syncEpoch, 7);
    assert.ok(
      (requests[1].ops as Array<{ id: string }>).some(
        (op) => op.id === pending.id,
      ),
    );
    assert.ok(
      core.getUnsyncedOps(db.getDb()).some((op) => op.id === pending.id),
    );
    assert.match(state.useStore.getState().syncError ?? "", /acknowledgements/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    let releaseMe!: (response: Response) => void;
    let meStarted!: () => void;
    const meReady = new Promise<void>((resolve) => {
      meStarted = resolve;
    });
    let releaseLogout!: (response: Response) => void;
    let logoutStarted!: () => void;
    const logoutReady = new Promise<void>((resolve) => {
      logoutStarted = resolve;
    });
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/me")) {
        meStarted();
        return new Promise<Response>((resolve) => {
          releaseMe = resolve;
        });
      }
      if (String(url).endsWith("/api/logout")) {
        logoutStarted();
        return new Promise<Response>((resolve) => {
          releaseLogout = resolve;
        });
      }
      return Response.json({});
    }) as typeof fetch;
    const identityRequest = sync.fetchIdentity();
    await meReady;
    const logout = sync.signOut(false);
    await logoutReady;
    releaseMe(new Response(null, { status: 401 }));
    await identityRequest;
    assert.equal(
      config.getServerConfig().token,
      "token",
      "late 401 must not mutate logout config",
    );
    releaseLogout(new Response(null, { status: 204 }));
    await logout;
    assert.equal(config.getServerConfig().token, "");
    assert.equal(config.getCurrentUser(), null);
    assert.ok(
      core.getUnsyncedOps(db.getDb()).some((op) => op.id === pending.id),
      "keep-offline logout retains work",
    );
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    globalThis.fetch = realFetch;
    db.resetDbForTest();
  }
});

test("older servers leave review entries pending until support is advertised", async () => {
  values.set(
    "carbon.server",
    JSON.stringify({
      ...config.getServerConfig(),
      url: "http://review-compat",
      token: "token",
      username: "alice",
      autoSync: false,
    }),
  );
  const user = {
    id: "alice",
    username: "alice",
    open: false,
    role: "member" as const,
  };
  config.saveCurrentUser(user as never);
  state.useStore.getState().setCurrentUser(user as never);
  await db.rebindIdentity();
  const project = core.createItem(db.getDb(), "device", {
    type: "project",
    title: "Review",
    ownerId: user.id,
  });
  core.writeReviewEntry(
    db.getDb(),
    "device",
    user.id,
    project,
    "check:tasksRelevant",
    { checked: true },
  );
  let supported = false;
  const sent: Array<{ recordOps: import("@carbon/core").RecordOp[] }> = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).endsWith("/api/me")) return Response.json(user);
    if (String(url).endsWith("/api/sync")) {
      const body = JSON.parse(String(init?.body));
      sent.push(body);
      return Response.json({
        ops: [],
        recordOps: [],
        users: [],
        cursor: 0,
        rcursor: 0,
        syncEpoch: 1,
        ...(supported
          ? { reviewProgressSupported: true, reviewCursor: 0 }
          : {}),
        acknowledged: {
          ops: body.ops.map((op: { id: string }) => op.id),
          recordOps: body.recordOps.map((op: { id: string }) => op.id),
        },
      });
    }
    return Response.json({});
  }) as typeof fetch;
  try {
    await sync.syncNow();
    await sync.syncNow();
    assert.equal(
      sent.some((body) =>
        body.recordOps.some((op) => op.entity === "review_progress"),
      ),
      false,
    );
    assert.ok(
      core
        .getUnsyncedRecordOps(db.getDb())
        .some((op) => op.entity === "review_progress"),
    );
    supported = true;
    await sync.syncNow();
    await sync.syncNow();
    assert.ok(
      sent.some((body) =>
        body.recordOps.some((op) => op.entity === "review_progress"),
      ),
    );
    assert.equal(
      core
        .getUnsyncedRecordOps(db.getDb())
        .filter((op) => op.entity === "review_progress").length,
      0,
    );
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    globalThis.fetch = realFetch;
    db.resetDbForTest();
  }
});
