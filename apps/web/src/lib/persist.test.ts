import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { recordOp, ingestOps, type Db } from "@carbon/core";
import type { BcLike } from "./db";

// ---------------------------------------------------------------------------
// A3 — cross-tab persistence tests.
//
// Two "tabs" are modelled as two separate module instances of `./db` (a
// query-string cache-bust gives each import its own module state — the same
// isolation a browser gives each tab). Both tabs share one in-memory storage
// seam (the "IndexedDB") and the same fake browser globals, so a write made by
// one tab is visible to the other. Real sql.js databases run in-process.
//
// The lost write from the September 2026 review: "An edit from one tab
// disappeared after a stale second tab saved its database." See
// docs/internal/a3/design.md for the fix.
// ---------------------------------------------------------------------------

// ---- browser-API fakes — installed before any app module is imported -------

class FakeLocalStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

class FakeDocument extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
}

const fakeLocalStorage = new FakeLocalStorage();
const fakeDocument = new FakeDocument();
const fakeWindow = new EventTarget();
(globalThis as Record<string, unknown>).localStorage = fakeLocalStorage;
(globalThis as Record<string, unknown>).document = fakeDocument;
(globalThis as Record<string, unknown>).window = fakeWindow;

// ---- shared fake storage: the single "IndexedDB" every tab sees ------------
//
// `transaction` runs fn's read-modify-write against the same in-memory map with
// no interleaving (node is single-threaded) — the same atomicity a real
// IndexedDB readwrite transaction gives the production seam.

const kvStore = new Map<string, unknown>();
let putBehavior: "ok" | "fail" | "corrupt" = "ok";

const kvSeam = {
  get: async (k: string): Promise<unknown> => kvStore.get(k),
  put: async (k: string, v: unknown): Promise<void> => {
    if (putBehavior === "fail") throw new Error("simulated storage failure");
    if (putBehavior === "corrupt" && k.startsWith("db|"))
      kvStore.set(k, "CORRUPTED");
    else kvStore.set(k, v);
  },
  del: async (k: string): Promise<void> => {
    kvStore.delete(k);
  },
  // Atomic like a real IndexedDB transaction: fn's writes are buffered and only
  // applied to the shared store if fn completes; a failure rolls them back.
  transaction: (
    fn: (tx: {
      get: (k: string) => Promise<unknown>;
      put: (k: string, v: unknown) => Promise<void>;
      del: (k: string) => Promise<void>;
    }) => Promise<void> | void,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const writes: Array<{ k: string; v: unknown; del: boolean }> = [];
      const view = (k: string): unknown => {
        for (let i = writes.length - 1; i >= 0; i--) {
          if (writes[i].k === k) return writes[i].del ? undefined : writes[i].v;
        }
        return kvStore.get(k);
      };
      const tx = {
        get: async (k: string): Promise<unknown> => view(k),
        put: async (k: string, v: unknown): Promise<void> => {
          if (putBehavior === "fail")
            throw new Error("simulated storage failure");
          writes.push({
            k,
            v:
              putBehavior === "corrupt" && k.startsWith("db|")
                ? "CORRUPTED"
                : v,
            del: false,
          });
        },
        del: async (k: string): Promise<void> => {
          if (putBehavior === "fail")
            throw new Error("simulated storage failure");
          writes.push({ k, v: undefined, del: true });
        },
      };
      Promise.resolve(fn(tx)).then(
        () => {
          for (const w of writes) {
            if (w.del) kvStore.delete(w.k);
            else kvStore.set(w.k, w.v);
          }
          resolve();
        },
        (e: unknown) => reject(e), // buffered writes discarded — atomic rollback
      );
    }),
};

// A query-suffixed specifier resolves to its own module instance (node keeps
// each query in a separate cache slot) — the same isolation a browser gives
// each tab. TypeScript can't type the suffixed specifier, so cast.
// @ts-expect-error -- query-string cache-bust specifier (see above)
const tab1 = (await import("./db?tab=1")) as typeof import("./db");
// @ts-expect-error -- query-string cache-bust specifier (see above)
const tab2 = (await import("./db?tab=2")) as typeof import("./db");
// @ts-expect-error -- query-string cache-bust specifier (see above)
const tab3 = (await import("./db?tab=3")) as typeof import("./db");
tab1.setKvSeam(kvSeam);
tab2.setKvSeam(kvSeam);
tab3.setKvSeam(kvSeam);

// ---- shared fake BroadcastChannel registry (the "same origin" of the tabs) --
//
// Node has a real global BroadcastChannel, but a fake registry keeps delivery
// synchronous and lets a test mute delivery (to simulate a throttled tab that
// misses peer messages).

interface FakeCh extends BcLike {
  muted: boolean;
}

function makeBcRegistry() {
  const chans = new Map<string, Set<FakeCh>>();
  const factory = (name: string): FakeCh => {
    const self: FakeCh = {
      muted: false,
      onmessage: null,
      postMessage(msg: unknown) {
        for (const c of chans.get(name) ?? []) {
          if (c !== self && !c.muted) c.onmessage?.({ data: msg });
        }
      },
      close() {
        chans.get(name)?.delete(self);
      },
    };
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(self);
    return self;
  };
  const channelsOf = (name: string): FakeCh[] => [...(chans.get(name) ?? [])];
  return { factory, channelsOf };
}

const bc = makeBcRegistry();
tab1.setBcFactory(bc.factory);
tab2.setBcFactory(bc.factory);
tab3.setBcFactory(bc.factory);

// The SHARED `./db` instance (no cache-bust) is what sync.ts drives — give it
// the same fake seams so countUnsyncedWork() etc. run without real indexedDB.
const sharedDb = await import("./db");
sharedDb.setKvSeam(kvSeam);
sharedDb.setBcFactory(bc.factory);

// The shared store (sync.ts / config.ts drive it) — reset between tests.
const store = await import("./store");

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const now = () => new Date().toISOString();

function insertItem(db: Db, id: string, title: string): void {
  db.run(
    "INSERT INTO items (id, type, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, "task", title, now(), now()],
  );
}

/** Item ids persisted under a given identity namespace ('local|local' by
 *  default — the no-server, no-user identity used throughout these tests). */
async function storeItemIds(nsKey = "local|local"): Promise<string[]> {
  const saved = kvStore.get(`db|${nsKey}`) as
    { gen: number; snap: Uint8Array } | undefined;
  assert.ok(saved, `a snapshot should be persisted under ${nsKey}`);
  const snap = await tab1.openSnapshot(saved.snap);
  return snap
    .all<{ id: string }>("SELECT id FROM items")
    .map((r) => r.id)
    .sort();
}

describe("A3: local persistence across tabs", () => {
  beforeEach(() => {
    kvStore.clear();
    putBehavior = "ok";
    // Each "tab" is a long-lived module instance; reset its live state like a
    // browser tab reload so every test boots from the (cleared) store.
    tab1.resetDbForTest();
    tab2.resetDbForTest();
    tab3.resetDbForTest();
  });

  test("import storage failure activates no rows and a retry preserves both tabs", async () => {
    await tab1.initDb();
    await tab2.initDb();
    insertItem(tab1.getDb(), "local", "local work");
    await tab1.flushPersist();
    insertItem(tab2.getDb(), "peer", "peer work");
    await tab2.flushPersist();
    putBehavior = "fail";
    await assert.rejects(tab1.commitImport((db) => insertItem(db, "imported", "backup"), "local|local"));
    assert.equal(tab1.getDb().get("SELECT id FROM items WHERE id = 'imported'"), undefined);
    putBehavior = "ok";
    await tab1.commitImport((db) => insertItem(db, "imported", "backup"), "local|local");
    assert.deepEqual(await storeItemIds(), ["imported", "local", "peer"]);
  });

  test("invalid staged import cannot partially apply valid siblings", async () => {
    await tab1.initDb();
    await assert.rejects(tab1.commitImport((db) => {
      insertItem(db, "partial", "must not land");
      throw new Error("malformed record");
    }, "local|local"), /malformed/);
    assert.equal(tab1.getDb().get("SELECT id FROM items WHERE id = 'partial'"), undefined);
    assert.deepEqual(await storeItemIds(), []);
  });

  // The carried review finding: tab2 holds a stale in-memory copy; when it
  // persists, it must not roll back the edit tab1 already committed to the
  // shared store. Pre-A3 this failed (the whole-DB last-writer-wins write
  // clobbered item-a); the generation check + resync in persistImpl fixes it.
  test("a stale tab persisting does not clobber a newer tab's committed edit", async () => {
    await tab1.initDb(); // store: baseline snapshot
    // tab2 boots from the same store — its in-memory copy predates tab1's edit.
    await tab2.initDb();

    insertItem(tab1.getDb(), "item-a", "edited in tab 1");
    await tab1.flushPersist(); // store now holds item-a

    insertItem(tab2.getDb(), "item-b", "edited in tab 2");
    await tab2.flushPersist();

    assert.deepEqual(await storeItemIds(), ["item-a", "item-b"]);
  });

  // Stronger than the clobber case: an edit made in a stale tab but NOT yet
  // flushed when it detects the newer store state must survive — the mutation
  // log is replayed on top of the resynced snapshot.
  test("an unflushed edit in a stale tab survives a resync (mutation-log replay)", async () => {
    await tab1.initDb();
    await tab2.initDb();

    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist(); // gen 1

    insertItem(tab2.getDb(), "item-b", "B"); // NOT flushed — only in tab2's mutation log
    insertItem(tab1.getDb(), "item-c", "C");
    await tab1.flushPersist(); // gen 2 — tab2 is now stale

    await tab2.flushPersist(); // detects gen 2 > baseGen, resyncs, replays B

    assert.deepEqual(await storeItemIds(), ["item-a", "item-b", "item-c"]);
  });

  test("a persisted edit survives a reload (fresh tab boots from the store)", async () => {
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    await tab3.initDb();
    const rows = tab3.getDb().all<{ id: string }>("SELECT id FROM items");
    assert.deepEqual(
      rows.map((r) => r.id),
      ["item-a"],
    );
  });

  // A write that fails (quota, kill mid-write, ...) must not corrupt or clear
  // the store: the last good snapshot stays, and a later persist lands.
  test("a failed write leaves the last good snapshot intact", async () => {
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    putBehavior = "fail";
    insertItem(tab1.getDb(), "item-b", "B");
    await tab1.flushPersist().catch(() => {
      /* the persist is allowed to reject */
    });
    putBehavior = "ok";

    assert.deepEqual(await storeItemIds(), ["item-a"]); // B not lost to a failed write

    await tab1.flushPersist(); // retry lands A+B
    assert.deepEqual(await storeItemIds(), ["item-a", "item-b"]);
  });

  // Simulated torn write: the current record is unreadable, but the snapshot
  // log still holds the last good state — the next boot recovers from it.
  test("a corrupt current record is recovered from the snapshot log", async () => {
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist(); // gen 1 (log holds gen 0 and gen 1)

    // Corrupt the main record directly, as a torn write would.
    const recKey = "db|local|local";
    const rec = kvStore.get(recKey) as { gen: number; snap: Uint8Array };
    kvStore.set(recKey, { gen: rec.gen, snap: new Uint8Array([0, 1, 2]) });

    // @ts-expect-error -- query-string cache-bust specifier (see above)
    const fresh = (await import("./db?tab=4")) as typeof import("./db");
    fresh.setKvSeam(kvSeam);
    // Fake channel too — a real node BroadcastChannel would keep the process alive.
    fresh.setBcFactory(bc.factory);
    await fresh.initDb();
    const rows = fresh.getDb().all<{ id: string }>("SELECT id FROM items");
    assert.deepEqual(
      rows.map((r) => r.id),
      ["item-a"],
    );
  });
});

describe("A3: cross-tab coordination + propagation", () => {
  beforeEach(() => {
    kvStore.clear();
    putBehavior = "ok";
    tab1.resetDbForTest();
    tab2.resetDbForTest();
    tab3.resetDbForTest();
    for (const ch of bc.channelsOf("carbon|default")) ch.muted = false;
    fakeDocument.visibilityState = "visible";
  });

  test("a change committed in one tab is observed by the other without a reload", async () => {
    await tab1.initDb();
    await tab2.initDb();

    insertItem(tab1.getDb(), "item-x", "X");
    await tab1.flushPersist(); // commits gen N and posts { t: 'persisted' }
    await tick(100); // tab2's handler resyncs (async)

    const rows = tab2
      .getDb()
      .all<{ id: string }>("SELECT id FROM items")
      .map((r) => r.id);
    assert.ok(rows.includes("item-x"), "tab2 must have observed tab1's change");

    // ...and tab2's own subsequent commit must not clobber it.
    insertItem(tab2.getDb(), "item-y", "Y");
    await tab2.flushPersist();
    assert.deepEqual(await storeItemIds(), ["item-x", "item-y"]);
  });

  test("a tab that missed peer messages catches up when it becomes visible", async () => {
    tab1.registerPersistFlush();
    tab2.registerPersistFlush();
    await tab1.initDb();
    await tab2.initDb();

    // Simulate tab2 being throttled in the background: it misses the message.
    for (const ch of bc.channelsOf("carbon|default")) ch.muted = true;
    insertItem(tab1.getDb(), "item-x", "X");
    await tab1.flushPersist();
    for (const ch of bc.channelsOf("carbon|default")) ch.muted = false;

    // tab2 comes back to the front — its visibility re-check must resync it.
    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    await tick(100);

    const rows = tab2
      .getDb()
      .all<{ id: string }>("SELECT id FROM items")
      .map((r) => r.id);
    assert.ok(
      rows.includes("item-x"),
      "tab2 must have caught up from the store",
    );

    // ...and its next commit must not clobber the missed change.
    insertItem(tab2.getDb(), "item-y", "Y");
    await tab2.flushPersist();
    assert.deepEqual(await storeItemIds(), ["item-x", "item-y"]);
  });
});

const blobs = await import("./blobs");

describe("A3: namespacing by workspace/user identity", () => {
  beforeEach(() => {
    kvStore.clear();
    putBehavior = "ok";
    fakeLocalStorage.removeItem("carbon.user");
    fakeLocalStorage.removeItem("carbon.offlineUser");
    fakeLocalStorage.removeItem("carbon.server");
    tab1.resetDbForTest();
    tab2.resetDbForTest();
    tab3.resetDbForTest();
    blobs.resetBlobsForTest();
  });

  test("a stale old-identity tab cannot touch the new identity store (no leakage)", async () => {
    // tab1 boots with no one signed in → bound to the device-local store.
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    // Another tab signs in as alice; tab2 boots bound to alice's namespace.
    fakeLocalStorage.setItem(
      "carbon.user",
      JSON.stringify({
        id: "alice",
        username: "alice",
        display_name: null,
        role: "member",
        is_bot: false,
        avatar_color: null,
      }),
    );
    await tab2.initDb();
    insertItem(tab2.getDb(), "item-b", "B");
    await tab2.flushPersist();

    // The stale tab (still bound to the device-local store) keeps editing.
    insertItem(tab1.getDb(), "item-c", "C");
    await tab1.flushPersist();

    const localItems = await storeItemIds("local|local");
    const aliceItems = await storeItemIds("local|u:alice");
    assert.deepEqual(localItems, ["item-a", "item-c"]);
    assert.deepEqual(aliceItems, ["item-b"]); // no leakage across identities
  });

  test("a rebind flushes the old identity's pending work to its own store, then swaps the live db", async () => {
    // Boot as device-local...
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    // ...then sign in as alice; tab1 is still bound to local|local.
    fakeLocalStorage.setItem(
      "carbon.user",
      JSON.stringify({
        id: "alice",
        username: "alice",
        display_name: null,
        role: "member",
        is_bot: false,
        avatar_color: null,
      }),
    );

    // Pending (unflushed) work under the OLD identity.
    insertItem(tab1.getDb(), "item-b", "B");
    await tab1.rebindIdentity();

    // The old store received the flushed work — nothing lost...
    assert.deepEqual(await storeItemIds("local|local"), ["item-a", "item-b"]);
    // ...and the live db is now alice's (empty until the server pull).
    assert.deepEqual(
      tab1.getDb().all<{ id: string }>("SELECT id FROM items"),
      [],
    );
    // Subsequent work lands under alice's key only.
    insertItem(tab1.getDb(), "item-c", "C");
    await tab1.flushPersist();
    assert.deepEqual(await storeItemIds("local|u:alice"), ["item-c"]);
  });

  test("a workspace switch rebinds to the new workspace store", async () => {
    const config = await import("./config");
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({
        url: "https://a.example.com",
        username: "",
        token: "t",
        autoSync: true,
        blobFetch: "thumbnails",
        blobCacheMb: 250,
      }),
    );
    fakeLocalStorage.setItem(
      "carbon.user",
      JSON.stringify({
        id: "alice",
        username: "alice",
        display_name: null,
        role: "member",
        is_bot: false,
        avatar_color: null,
      }),
    );
    await tab1.initDb(); // bound to https://a.example.com|u:alice
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    // Switch to server B (production: the config listener triggers this rebind
    // when the workspace part changes; the test triggers the same function).
    config.saveServerConfig({
      ...config.getServerConfig(),
      url: "https://b.example.com",
    });
    await tab1.rebindIdentity();

    assert.deepEqual(await storeItemIds("https://a.example.com|u:alice"), [
      "item-a",
    ]); // old ws intact
    insertItem(tab1.getDb(), "item-b", "B");
    await tab1.flushPersist();
    assert.deepEqual(await storeItemIds("https://b.example.com|u:alice"), [
      "item-b",
    ]); // new ws store
  });

  test("a 401 (expired token, same workspace) does NOT rebind — data stays under the gate", async () => {
    const config = await import("./config");
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({
        url: "https://a.example.com",
        username: "",
        token: "t",
        autoSync: true,
        blobFetch: "thumbnails",
        blobCacheMb: 250,
      }),
    );
    fakeLocalStorage.setItem(
      "carbon.user",
      JSON.stringify({
        id: "alice",
        username: "alice",
        display_name: null,
        role: "member",
        is_bot: false,
        avatar_color: null,
      }),
    );
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    // A 401 clears the token (same URL — the config listener is workspace-gated,
    // so no rebind) and drops the user record. The tab's binding is untouched.
    config.saveServerConfig({
      ...config.getServerConfig(),
      token: "",
      password: "",
    });
    config.saveCurrentUser(null);

    // No rebind happened: the live db is still alice's, and work still lands
    // under her store — visible behind the sign-in gate.
    assert.deepEqual(
      tab1
        .getDb()
        .all<{ id: string }>("SELECT id FROM items")
        .map((r) => r.id),
      ["item-a"],
    );
    insertItem(tab1.getDb(), "item-b", "B");
    await tab1.flushPersist();
    assert.deepEqual(await storeItemIds("https://a.example.com|u:alice"), [
      "item-a",
      "item-b",
    ]);
  });

  test("sign-out with erase wipes the signed-out identity and rebinds to device-local", async () => {
    const config = await import("./config");
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({
        url: "https://a.example.com",
        username: "",
        token: "t",
        autoSync: true,
        blobFetch: "thumbnails",
        blobCacheMb: 250,
      }),
    );
    fakeLocalStorage.setItem(
      "carbon.user",
      JSON.stringify({
        id: "alice",
        username: "alice",
        display_name: null,
        role: "member",
        is_bot: false,
        avatar_color: null,
      }),
    );
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    // Wipe under the old binding, then drop credentials and rebind. (signOut's
    // erase path rebinds with flushOld=false so the wipe isn't undone.)
    await tab1.wipeLocalDb();
    config.saveCurrentUser(null);
    await tab1.rebindIdentity(false); // → local|local

    assert.equal(
      kvStore.has("db|https://a.example.com|u:alice"),
      false,
      "the old store is wiped",
    );
    insertItem(tab1.getDb(), "item-c", "C");
    await tab1.flushPersist();
    assert.deepEqual(await storeItemIds("local|local"), ["item-c"]);
  });

  test("offline-kept data stays bound to the signed-out user", async () => {
    const identity = await import("./identity");
    // Signed-in as alice on this device...
    fakeLocalStorage.setItem(
      "carbon.user",
      JSON.stringify({
        id: "alice",
        username: "alice",
        display_name: null,
        role: "member",
        is_bot: false,
        avatar_color: null,
      }),
    );
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    // ...signs out WITH offline data kept, then the user record is cleared.
    identity.saveOfflineUser({ ws: "local", id: "alice" });
    fakeLocalStorage.removeItem("carbon.user");
    assert.equal(identity.identityKey(), "local|u:alice");

    // A fresh tab binds to the kept identity and sees the kept data.
    await tab2.initDb();
    const rows = tab2.getDb().all<{ id: string }>("SELECT id FROM items");
    assert.deepEqual(
      rows.map((r) => r.id),
      ["item-a"],
    );
    assert.deepEqual(await storeItemIds("local|u:alice"), ["item-a"]);
  });
});

// ---------------------------------------------------------------------------
// A3 — sign-in merge / replace + sign-out unsynced-work protection.
//
// Pre-sign-in work is namespaced under the device-local store (local|local),
// separate from the signed-in identity's store. Signing in offers to MERGE that
// capture into the account (replaying its op log, claiming the unowned items for
// the user, then consuming the capture) or to REPLACE (discard the capture and
// re-pull from the server). Signing out, by contrast, erases by default and only
// keeps data offline on explicit choice — after first detecting unsynced work so
// it can be pushed rather than silently lost.
// ---------------------------------------------------------------------------

describe("A3: sign-in merge/replace across namespaces", () => {
  const alice = {
    id: "alice",
    username: "alice",
    display_name: null,
    role: "member",
    is_bot: false,
    avatar_color: null,
  };

  beforeEach(() => {
    kvStore.clear();
    putBehavior = "ok";
    fakeLocalStorage.removeItem("carbon.user");
    fakeLocalStorage.removeItem("carbon.offlineUser");
    fakeLocalStorage.removeItem("carbon.server");
    tab1.resetDbForTest();
    tab2.resetDbForTest();
    blobs.resetBlobsForTest();
  });

  test("the device-local capture is counted for the merge prompt (not the live DB)", async () => {
    // Pre-sign-in: no user → work is namespaced under local|local.
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    assert.equal(await tab1.localNamespaceItemCount(), 1);

    // Once signed in and re-bound, the LIVE db is the (empty) user store — its
    // count is 0, but the capture still holds the one pre-sign-in item.
    fakeLocalStorage.setItem("carbon.user", JSON.stringify(alice));
    await tab1.rebindIdentity();
    assert.equal(tab1.localItemCount(), 0, "live user store is empty");
    assert.equal(
      await tab1.localNamespaceItemCount(),
      1,
      "capture still present",
    );
  });

  test("merge replays the capture into the user store, claims it, and consumes it", async () => {
    const { createItem } = await import("@carbon/core");

    // Pre-sign-in capture: a real create records an op in the log (the merge
    // replays that log).
    await tab1.initDb();
    const created = createItem(tab1.getDb(), tab1.getDeviceId(), {
      title: "A",
    });
    await tab1.flushPersist();

    // Sign in + rebind to the user identity (the capture is flushed intact).
    fakeLocalStorage.setItem("carbon.user", JSON.stringify(alice));
    await tab1.rebindIdentity();

    const merged = await tab1.mergeLocalCapture(alice.id);
    assert.ok(merged >= 1, "replayed at least the create op");

    // The item now lives in the user store and is claimed for the user.
    const rows = tab1
      .getDb()
      .all<{ id: string; owner_id: string | null }>(
        "SELECT id, owner_id FROM items WHERE deleted = 0",
      );
    assert.deepEqual(
      rows.map((r) => r.id),
      [created.id],
    );
    assert.equal(
      rows[0].owner_id,
      alice.id,
      "unowned capture item claimed for the user",
    );

    // The capture is consumed so it is never merged again.
    assert.equal(kvStore.has("db|local|local"), false);
  });

  test("replace discards the capture (the account store is re-pulled, not wiped)", async () => {
    // Pre-sign-in capture.
    await tab1.initDb();
    insertItem(tab1.getDb(), "item-a", "A");
    await tab1.flushPersist();

    // Sign in + rebind; the user store may already hold account data.
    fakeLocalStorage.setItem("carbon.user", JSON.stringify(alice));
    await tab1.rebindIdentity();
    insertItem(tab1.getDb(), "item-acct", "Account"); // existing account data
    await tab1.flushPersist();

    await tab1.discardLocalCapture();

    // The capture is gone...
    assert.equal(kvStore.has("db|local|local"), false);
    // ...and the account's own data is intact (not wiped by "replace").
    const rows = tab1
      .getDb()
      .all<{ id: string }>("SELECT id FROM items WHERE deleted = 0");
    assert.deepEqual(
      rows.map((r) => r.id),
      ["item-acct"],
    );
  });
});

describe("A3: sign-out unsynced-work detection", () => {
  beforeEach(() => {
    kvStore.clear();
    putBehavior = "ok";
    fakeLocalStorage.removeItem("carbon.user");
    fakeLocalStorage.removeItem("carbon.offlineUser");
    fakeLocalStorage.removeItem("carbon.server");
    // countUnsyncedWork lives in sync.ts, which drives the SHARED db instance
    // (not the ?tab= cache-bust copies) — reset it for isolation.
    sharedDb.resetDbForTest();
    blobs.resetBlobsForTest();
  });

  test("countUnsyncedWork counts unsynced item ops, record ops, and pending blobs", async () => {
    const sync = await import("./sync");

    const { createItem } = await import("@carbon/core");

    await sharedDb.initDb();
    assert.equal(
      await sync.countUnsyncedWork(),
      0,
      "fresh store has no unsynced work",
    );

    // A local create records an unsynced item op (synced=0 until pushed).
    createItem(sharedDb.getDb(), sharedDb.getDeviceId(), { title: "A" });
    const n = await sync.countUnsyncedWork();
    assert.ok(n >= 1, `expected unsynced work, got ${n}`);
  });
});

// ---------------------------------------------------------------------------
// A3 — per-workspace credential restore on return (SAFE-DEFAULT storage model).
//
// Auto-restore requires a POSITIVE per-workspace auth-state record of 'in'
// (written on explicit sign-in) AND a saved session token. An 'out' record
// (explicit sign-out) or an ABSENT record — the safe default, since a storage
// clear removes the record — both present the sign-in gate. Sign-out also clears
// the snapshot's saved token (defense in depth). The decision lives in
// sync.ts `restoreSessionOrGate()`; the record in config.ts
// `getWorkspaceAuthState` / `setWorkspaceAuthState`.
// ---------------------------------------------------------------------------

describe("A3: per-workspace credential restore on return (safe default)", () => {
  // Canonical endpoint keys (scheme-preserving `workspaceHostOf`): the URL used
  // in the config IS the key, so `currentWorkspace()` resolves to exactly these.
  const A = "https://a.example.com";
  const B = "https://b.example.com";
  const alice = {
    id: "alice",
    username: "alice",
    display_name: null,
    role: "member" as const,
    is_bot: false,
    avatar_color: null,
  };

  let fetchCalls: string[];
  let realFetch: typeof globalThis.fetch;

  function cfgObj(ws: string, token: string) {
    return {
      url: ws, // the endpoint key is the URL (scheme preserved)
      username: "alice",
      token,
      autoSync: true,
      blobFetch: "thumbnails" as const,
      blobCacheMb: 250,
    };
  }

  // Write the current config AND the per-workspace snapshot for `ws` directly
  // (bypassing saveServerConfig so the workspace-switch listener isn't fired).
  function seedServer(ws: string, token: string): void {
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify(cfgObj(ws, token)),
    );
    fakeLocalStorage.setItem(
      `carbon.server.${ws}`,
      JSON.stringify(cfgObj(ws, token)),
    );
  }

  // Write ONLY the current config (models switching workspaces / a cleared token).
  function writeCurrent(ws: string, token: string): void {
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify(cfgObj(ws, token)),
    );
  }

  function snapshotToken(ws: string): string {
    const raw = fakeLocalStorage.getItem(`carbon.server.${ws}`);
    return raw ? ((JSON.parse(raw) as { token?: string }).token ?? "") : "";
  }

  beforeEach(() => {
    kvStore.clear();
    putBehavior = "ok";
    fakeLocalStorage.clear();
    sharedDb.resetDbForTest();
    blobs.resetBlobsForTest();
    store.useStore.setState({ authRequired: false, currentUser: null });

    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      fetchCalls.push(url);
      if (url.includes("/api/me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...alice }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("(a) explicit sign-out → return gates; a cleared (absent) record also gates", async () => {
    const config = await import("./config");
    const sync = await import("./sync");

    // Signed in to B.
    seedServer(B, "valid-token");
    config.saveCurrentUser(alice);
    config.setWorkspaceAuthState(B, "in");

    // Explicit sign-out of B: record 'out' + clear the snapshot's token.
    config.setWorkspaceAuthState(B, "out");
    config.clearWorkspaceSnapshotToken(B);
    config.saveCurrentUser(null);
    writeCurrent(B, ""); // what signOut's saveServerConfig does to the current config

    // The sign-out cleared the saved snapshot token (defense in depth).
    assert.equal(snapshotToken(B), "", "sign-out cleared the snapshot token");

    // Return to B (restored from the now-empty snapshot) → gate, no auto-restore.
    await sync.restoreSessionOrGate();
    assert.ok(
      !fetchCalls.some((u) => u.includes("/api/me")),
      "no auto-restore after sign-out",
    );
    assert.equal(
      store.useStore.getState().authRequired,
      true,
      "gate presented",
    );

    // Safe default: even if the auth-state record were CLEARED (absent) and a
    // token survived, the return still gates — absent ⇒ gate, never false-in.
    config.setWorkspaceAuthState(B, null); // simulate a storage clear removing the record
    writeCurrent(B, "survived-token"); // a token is nonetheless present
    await sync.restoreSessionOrGate();
    assert.ok(
      !fetchCalls.some((u) => u.includes("/api/me")),
      "absent record ⇒ gate even with a token",
    );
    assert.equal(store.useStore.getState().authRequired, true, "still gated");
  });

  test("(b) sign in → switch away (no sign-out) → return auto-restores", async () => {
    const config = await import("./config");
    const sync = await import("./sync");

    // Sign in to A.
    seedServer(A, "tokA");
    config.saveCurrentUser(alice);
    config.setWorkspaceAuthState(A, "in");

    // Switch to B WITHOUT signing out of A.
    writeCurrent(B, "");
    // A's 'in' record and snapshot token survive the switch (no sign-out happened).
    assert.equal(
      config.getWorkspaceAuthState(A),
      "in",
      "A record persists across the switch",
    );
    assert.equal(
      snapshotToken(A),
      "tokA",
      "A snapshot token persists across the switch",
    );

    // Return to A (token restored from the snapshot, as saveServerConfig does).
    writeCurrent(A, snapshotToken(A));
    await sync.restoreSessionOrGate();

    assert.ok(
      fetchCalls.some((u) => u.includes("/api/me")),
      "auto-restores A on return",
    );
    assert.equal(
      store.useStore.getState().authRequired,
      false,
      "signed in, no gate",
    );
  });

  test('(c) distinct server keys: A "out" does not leak to B', async () => {
    const config = await import("./config");
    const sync = await import("./sync");

    // Two distinct hosts ⇒ distinct auth-state / snapshot keys.
    assert.notEqual(
      config.workspaceHostOf(A),
      config.workspaceHostOf(B),
      "distinct host keys",
    );

    // Signed out of A…
    config.setWorkspaceAuthState(A, "out");
    // …but signed in to B.
    seedServer(B, "tokB");
    config.saveCurrentUser(alice);
    config.setWorkspaceAuthState(B, "in");

    // Return to B → auto-restores (A's "out" must not gate B).
    await sync.restoreSessionOrGate();
    assert.ok(
      fetchCalls.some((u) => u.includes("/api/me")),
      "B auto-restores despite A being signed out",
    );
    assert.equal(config.getWorkspaceAuthState(A), "out", "A still signed out");
    assert.equal(config.getWorkspaceAuthState(B), "in", "B unaffected by A");
  });

  test("(d) stale/revoked token → fetchIdentity 401s → gate", async () => {
    const config = await import("./config");
    const sync = await import("./sync");

    seedServer(B, "stale-token");
    config.saveCurrentUser(alice);
    config.setWorkspaceAuthState(B, "in");

    // The token is stale/revoked: /api/me now 401s.
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      fetchCalls.push(url);
      if (url.includes("/api/me")) {
        return { ok: false, status: 401, json: async () => ({}) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof globalThis.fetch;

    await sync.restoreSessionOrGate();

    assert.ok(
      fetchCalls.some((u) => u.includes("/api/me")),
      'attempted restore ("in" record + token)',
    );
    assert.equal(
      store.useStore.getState().authRequired,
      true,
      "401 dropped the session → gate",
    );
  });

  test("(e) scheme collision closed: http/https twins get distinct auth-state + snapshot keys", async () => {
    const config = await import("./config");

    const http = config.workspaceHostOf("http://h");
    const https = config.workspaceHostOf("https://h");
    const bare = config.workspaceHostOf("h");

    // Function-level: the literal collision is closed; no-scheme key unchanged;
    // distinct hosts remain distinct.
    assert.notEqual(http, https, "http/https twins are distinct keys");
    assert.equal(bare, "h", "no-scheme key unchanged");
    assert.notEqual(
      config.workspaceHostOf("h1"),
      config.workspaceHostOf("h2"),
      "distinct hosts remain distinct",
    );

    // End-to-end: the http endpoint's auth-state record must NOT affect the https
    // endpoint's (and vice versa) — the storage keys are genuinely separate.
    config.setWorkspaceAuthState(http, "out");
    assert.equal(config.getWorkspaceAuthState(http), "out", "http record set");
    assert.equal(
      config.getWorkspaceAuthState(https),
      null,
      "https record unaffected (absent)",
    );

    config.setWorkspaceAuthState(https, "in");
    assert.equal(config.getWorkspaceAuthState(https), "in", "https record set");
    assert.equal(
      config.getWorkspaceAuthState(http),
      "out",
      "http record unchanged",
    );

    // End-to-end snapshot separation: blanking the http endpoint's snapshot token
    // leaves the https endpoint's snapshot token intact.
    const snapKey = (key: string) => `carbon.server.${key}`;
    fakeLocalStorage.setItem(
      snapKey(http),
      JSON.stringify({ url: "http://h", username: "alice", token: "httpTok" }),
    );
    fakeLocalStorage.setItem(
      snapKey(https),
      JSON.stringify({
        url: "https://h",
        username: "alice",
        token: "httpsTok",
      }),
    );
    config.clearWorkspaceSnapshotToken(http);
    const httpSnap = JSON.parse(
      fakeLocalStorage.getItem(snapKey(http)) as string,
    ) as { token?: string };
    const httpsSnap = JSON.parse(
      fakeLocalStorage.getItem(snapKey(https)) as string,
    ) as { token?: string };
    assert.equal(httpSnap.token, "", "http snapshot token blanked");
    assert.equal(httpsSnap.token, "httpsTok", "https snapshot token intact");
  });
});

describe("A3 review: durable journals, fencing and isolation", () => {
  beforeEach(() => {
    for (const tab of [tab1, tab2, tab3, sharedDb]) tab.resetDbForTest();
    kvStore.clear();
    fakeLocalStorage.clear();
    putBehavior = "ok";
    for (const tab of [tab1, tab2, tab3]) {
      tab.setKvSeam(kvSeam);
      tab.setBcFactory(() => null);
    }
  });
  afterEach(() => {
    for (const tab of [tab1, tab2, tab3]) {
      tab.resetDbForTest();
      tab.setKvSeam(kvSeam);
      tab.setBcFactory(bc.factory);
    }
    putBehavior = "ok";
    fakeLocalStorage.setItem("carbon.server", JSON.stringify({ url: "" }));
  });

  test("same-item different fields retain peer clocks across repeated catchups and failed save", async () => {
    await tab1.initDb();
    recordOp(tab1.getDb(), "a", "same", { title: "initial", note: "initial" });
    await tab1.flushPersist();
    await tab2.initDb();
    recordOp(tab2.getDb(), "b", "same", { note: "pending note" });
    const future = Date.now() + 100000;
    ingestOps(
      tab1.getDb(),
      [
        {
          id: "remote-title",
          item_id: "same",
          device_id: "remote",
          ts: future,
          fields: { title: "peer title" },
        },
      ],
      true,
    );
    await tab1.flushPersist();
    let failSnapshot = true;
    tab2.setKvSeam({
      ...kvSeam,
      transaction: (fn) =>
        kvSeam.transaction((tx) =>
          fn({
            ...tx,
            put: async (k, v) => {
              if (failSnapshot && k.startsWith("db|"))
                throw new Error("snapshot failure");
              await tx.put(k, v);
            },
          }),
        ),
    });
    await assert.rejects(tab2.flushPersist(), /snapshot failure/);
    assert.equal(
      tab2
        .getDb()
        .get<{ note: string }>("SELECT note FROM items WHERE id = ?", ["same"])
        ?.note,
      "pending note",
    );
    ingestOps(
      tab1.getDb(),
      [
        {
          id: "remote-flag",
          item_id: "same",
          device_id: "remote",
          ts: future + 1,
          fields: { flagged: true },
        },
      ],
      true,
    );
    await tab1.flushPersist();
    failSnapshot = false;
    await tab2.flushPersist();
    tab3.resetDbForTest();
    await tab3.initDb();
    const row = tab3
      .getDb()
      .get<{ title: string; note: string; flagged: number; clocks: string }>(
        "SELECT * FROM items WHERE id = ?",
        ["same"],
      )!;
    assert.equal(row.title, "peer title");
    assert.equal(row.note, "pending note");
    assert.equal(row.flagged, 1);
    assert.equal(JSON.parse(row.clocks).title.ts, future);
    assert.equal(JSON.parse(row.clocks).flagged.ts, future + 1);
    assert.ok(Number(tab3.getMeta("op_clock")) >= future + 1);
  });

  test("edit during async snapshot commit remains journaled through a subsequent peer save", async () => {
    await tab1.initDb();
    await tab2.initDb();
    let edited = false;
    tab1.setKvSeam({
      ...kvSeam,
      transaction: async (fn) => {
        let snapshot = false;
        await kvSeam.transaction((tx) =>
          fn({
            ...tx,
            put: async (k, v) => {
              snapshot ||= k.startsWith("db|");
              await tx.put(k, v);
            },
          }),
        );
        if (snapshot && !edited) {
          edited = true;
          insertItem(tab1.getDb(), "during", "during write");
        }
      },
    });
    insertItem(tab1.getDb(), "before", "before write");
    await tab1.flushPersist();
    insertItem(tab2.getDb(), "peer", "peer");
    await tab2.flushPersist();
    await tab1.flushPersist();
    assert.deepEqual(await storeItemIds(), ["before", "during", "peer"]);
  });

  test("failed replay keeps original transaction and refuses to run its tail outside a transaction", async () => {
    await tab1.initDb();
    await tab2.initDb();
    tab2.getDb().transaction(() => {
      insertItem(tab2.getDb(), "collision", "local");
      insertItem(tab2.getDb(), "tail", "local tail");
    });
    insertItem(tab1.getDb(), "collision", "peer");
    await tab1.flushPersist();
    await assert.rejects(tab2.flushPersist(), /original data retained/);
    assert.equal(
      tab2
        .getDb()
        .get<{ title: string }>("SELECT title FROM items WHERE id = ?", [
          "collision",
        ])?.title,
      "local",
    );
    assert.deepEqual(await storeItemIds(), ["collision"]);
    await assert.rejects(tab2.flushPersist(), /original data retained/);
    assert.ok(tab2.getDb().get("SELECT id FROM items WHERE id = ?", ["tail"]));
  });

  test("throwaway snapshot mutations never enter the live journal", async () => {
    await tab1.initDb();
    await tab2.initDb();
    const snapshot = await tab1.openSnapshot(tab1.exportDb());
    insertItem(snapshot, "throwaway", "must not persist");
    insertItem(tab2.getDb(), "peer", "peer");
    await tab2.flushPersist();
    await tab1.flushPersist();
    assert.deepEqual(await storeItemIds(), ["peer"]);
  });

  test("erase rejects a muted old tab even after a new tab has rebooted the empty store", async () => {
    await tab1.initDb();
    await tab2.initDb();
    insertItem(tab2.getDb(), "resurrection", "old pending edit");
    await tab1.wipeLocalDb();
    await tab3.initDb();
    await assert.rejects(tab2.flushPersist(), /erased/);
    assert.deepEqual(await storeItemIds(), []);
  });

  test("expired writer cannot commit after another lease has been acquired", async () => {
    await tab1.initDb();
    const before = kvStore.get("db|local|local");
    tab1.setKvSeam({
      ...kvSeam,
      transaction: (fn) =>
        kvSeam.transaction((tx) =>
          fn({
            ...tx,
            get: async (k) => {
              // Replace ownership after the writer's initial lock acquisition.
              if (k === "dblog|local|local")
                await tx.put("lock|local|local", {
                  owner: "new",
                  token: "new",
                  ts: Date.now(),
                });
              return tx.get(k);
            },
          }),
        ),
    });
    // Replace the durable lease between acquisition and the commit transaction.
    tab1.setKvSeam({
      ...kvSeam,
      get: async (k) => {
        if (k.startsWith("db|"))
          kvStore.set("lock|local|local", {
            owner: "new",
            token: "new",
            ts: Date.now(),
          });
        return kvSeam.get(k);
      },
    });
    insertItem(tab1.getDb(), "stale", "stale");
    await assert.rejects(tab1.flushPersist(), /Stale persistence/);
    assert.equal(kvStore.get("db|local|local"), before);
    assert.equal(
      (kvStore.get("lock|local|local") as { token: string }).token,
      "new",
    );
  });

  test("same-tab overlapping flushes serialize and preserve edits made while writing", async () => {
    await tab1.initDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    let blocked = false;
    tab1.setKvSeam({
      ...kvSeam,
      transaction: async (fn) => {
        let snapshot = false;
        await kvSeam.transaction((tx) =>
          fn({
            ...tx,
            put: async (k, v) => {
              snapshot ||= k.startsWith("db|");
              await tx.put(k, v);
            },
          }),
        );
        if (snapshot && !blocked) {
          blocked = true;
          entered();
          await gate;
        }
      },
    });
    insertItem(tab1.getDb(), "first", "first");
    const first = tab1.flushPersist();
    await started;
    insertItem(tab1.getDb(), "second", "second");
    const second = tab1.flushPersist();
    release();
    await Promise.all([first, second]);
    assert.deepEqual(await storeItemIds(), ["first", "second"]);
  });

  test("corrupt snapshots with no valid history fail visibly and preserve bytes", async () => {
    const bad = { gen: 10, snap: new Uint8Array([1, 2, 3]) };
    kvStore.set("db|local|local", bad);
    kvStore.set("dblog|local|local", [bad]);
    await assert.rejects(tab1.initDb(), /corrupt.*retained/);
    assert.equal(kvStore.get("db|local|local"), bad);
  });

  test("failed rebind flush preserves the actual old binding and rejects the switch", async () => {
    await tab1.initDb();
    insertItem(tab1.getDb(), "pending", "pending");
    fakeLocalStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({ url: "https://new.example" }),
    );
    putBehavior = "fail";
    await assert.rejects(tab1.rebindIdentity(), /storage failure/);
    assert.equal(tab1.getBoundIdentity(), "local|local");
    assert.ok(
      tab1.getDb().get("SELECT id FROM items WHERE id = ?", ["pending"]),
    );
  });

  test("two queued identity changes converge on the latest configuration", async () => {
    await tab1.initDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    let blocked = false;
    tab1.setKvSeam({
      ...kvSeam,
      transaction: async (fn) => {
        let snapshot = false;
        await kvSeam.transaction((tx) =>
          fn({
            ...tx,
            put: async (k, v) => {
              snapshot ||= k.startsWith("db|");
              await tx.put(k, v);
            },
          }),
        );
        if (snapshot && !blocked) {
          blocked = true;
          entered();
          await gate;
        }
      },
    });
    fakeLocalStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({ url: "https://b.example" }),
    );
    const first = tab1.rebindIdentity();
    await started;
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({ url: "https://c.example" }),
    );
    const second = tab1.rebindIdentity();
    release();
    await Promise.all([first, second]);
    assert.equal(tab1.getBoundIdentity(), "https://c.example|u:alice");
  });

  test("capture remains recoverable when destination persistence fails", async () => {
    await tab1.initDb();
    recordOp(tab1.getDb(), "capture", "only-copy", { title: "unsynced" });
    await tab1.flushPersist();
    fakeLocalStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({ url: "https://a.example" }),
    );
    await tab1.rebindIdentity();
    putBehavior = "fail";
    await assert.rejects(tab1.mergeLocalCapture("alice"), /storage failure/);
    assert.ok(kvStore.get("db|local|local"));
    putBehavior = "ok";
    await tab1.mergeLocalCapture("alice");
    assert.equal(kvStore.has("db|local|local"), false);
    assert.deepEqual(await storeItemIds("https://a.example|u:alice"), [
      "only-copy",
    ]);
  });

  test("erase clears exact-identity settings and leaves device and peer settings intact", async () => {
    await tab1.initDb();
    fakeLocalStorage.setItem("carbon.ui::local|local", '{"private":true}');
    fakeLocalStorage.setItem("carbon.viewprefs.inbox::local|local", "{}");
    fakeLocalStorage.setItem("carbon.ui::https://peer|u:bob", "{}");
    fakeLocalStorage.setItem("carbon.theme", "dark");
    await tab1.wipeLocalDb();
    assert.equal(fakeLocalStorage.getItem("carbon.ui::local|local"), null);
    assert.equal(
      fakeLocalStorage.getItem("carbon.viewprefs.inbox::local|local"),
      null,
    );
    assert.equal(
      fakeLocalStorage.getItem("carbon.ui::https://peer|u:bob"),
      "{}",
    );
    assert.equal(fakeLocalStorage.getItem("carbon.theme"), "dark");
  });

  test("settings include workspace and migration leaves other accounts view preferences alone", async () => {
    const { settingsKey, migrateLegacySettings } = await import("./identity");
    fakeLocalStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({ url: "https://one.example" }),
    );
    const first = settingsKey("carbon.viewprefs", "inbox");
    fakeLocalStorage.setItem(
      "carbon.viewprefs.inbox::u:bob",
      '{"private":true}',
    );
    migrateLegacySettings();
    assert.equal(
      fakeLocalStorage.getItem("carbon.viewprefs.inbox::u:bob"),
      '{"private":true}',
    );
    fakeLocalStorage.setItem(
      "carbon.server",
      JSON.stringify({ url: "https://two.example" }),
    );
    assert.notEqual(settingsKey("carbon.viewprefs", "inbox"), first);
  });
});
