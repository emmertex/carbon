import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

// Run explicitly from the repository root: npm run test:persistence
// Requires installed Playwright Chromium; missing browsers fail rather than skip.
// Real Chromium IndexedDB, real sql.js, and the production worker/seam. No fake
// transaction implementation: browser connections serialize across real tabs.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
let browser: Browser;
let bundle: string;
let worker: string;
let wasm: Buffer;
before(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import * as db from './apps/web/src/lib/db';
    import * as core from '@carbon/core'; import * as blobs from './apps/web/src/lib/blobs';
    import localforage from 'localforage';
    import * as settings from './apps/web/src/lib/settings-sync';
    import * as events from './apps/web/src/lib/settings-events';
    import { useStore } from './apps/web/src/lib/store';
    window.a3 = { db, core, blobs, localforage, settings, events, useStore };`,
        resolveDir: root,
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["fs", "path", "crypto"],
    })
  ).outputFiles[0].text;
  worker = (
    await build({
      entryPoints: [`${root}/apps/web/src/lib/persist.worker.ts`],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    })
  ).outputFiles[0].text;
  wasm = await readFile(`${root}/node_modules/sql.js/dist/sql-wasm.wasm`);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});
async function context(): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  // tsx preserves names with this helper inside serialized evaluate callbacks.
  await ctx.addInitScript("globalThis.__name = (target) => target");
  await ctx.route("https://carbon.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/bundle.js")
      return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (path === "/persist.worker.ts")
      return route.fulfill({ contentType: "text/javascript", body: worker });
    if (path.endsWith(".wasm"))
      return route.fulfill({ contentType: "application/wasm", body: wasm });
    return route.fulfill({
      contentType: "text/html",
      body: '<script type="module" src="/bundle.js"></script>',
    });
  });
  return ctx;
}
async function page(ctx: BrowserContext): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto("https://carbon.test/");
  await p.waitForFunction(() => !!(window as any).a3);
  await p.evaluate(() => {
    (window as any).a3.db.setBcFactory(() => null);
  });
  return p;
}
async function init(p: Page) {
  await p.evaluate(async () => {
    await (window as any).a3.db.initDb();
  });
}

test("real IDB tabs preserve field clocks through concurrent commits, reload, and erased-peer rejection", async () => {
  const ctx = await context();
  try {
    const a = await page(ctx);
    await init(a);
    await a.evaluate(async () => {
      const { db, core } = (window as any).a3;
      core.recordOp(db.getDb(), "a", "same", { title: "base", note: "base" });
      await db.flushPersist();
    });
    const b = await page(ctx);
    await init(b);
    await b.evaluate(() => {
      const { db, core } = (window as any).a3;
      core.recordOp(db.getDb(), "b", "same", { note: "B pending" });
    });
    await a.evaluate(() => {
      const { db, core } = (window as any).a3;
      core.recordOp(db.getDb(), "a", "same", { title: "A title" });
    });
    await Promise.all([
      a.evaluate(() => (window as any).a3.db.persist()),
      b.evaluate(() => (window as any).a3.db.persist()),
    ]);
    await a.evaluate(async () => {
      const { db, core } = (window as any).a3;
      core.recordOp(db.getDb(), "a", "same", { flagged: true });
      await db.flushPersist();
    });
    await b.evaluate(async () => {
      const { db, core } = (window as any).a3;
      core.recordOp(db.getDb(), "b", "same", { note: "B latest" });
      await db.flushPersist();
    });
    const c = await page(ctx);
    await init(c);
    const row = await c.evaluate(() =>
      (window as any).a3.db
        .getDb()
        .get("SELECT title, note, flagged, clocks FROM items WHERE id = ?", [
          "same",
        ]),
    );
    assert.equal(row.title, "A title");
    assert.equal(row.note, "B latest");
    assert.equal(row.flagged, 1);
    assert.equal(JSON.parse(row.clocks).title.dev, "a");
    assert.equal(JSON.parse(row.clocks).note.dev, "b");
    await a.evaluate(() => (window as any).a3.db.wipeLocalDb());
    await c.reload();
    await c.waitForFunction(() => !!(window as any).a3);
    await init(c);
    await assert.rejects(
      b.evaluate(() => (window as any).a3.db.flushPersist()),
      /erased/,
    );
    assert.equal(
      await c.evaluate(() => (window as any).a3.db.localItemCount()),
      0,
    );
  } finally {
    await ctx.close();
  }
});

test("reload waits for an abandoned IDB lease to expire and preserves saved work", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    await init(p);
    await p.evaluate(async () => {
      const { db, core } = (window as any).a3;
      core.recordOp(db.getDb(), "before-reload", "retained", {
        title: "saved",
      });
      await db.flushPersist();
    });
    await p.reload();
    await p.waitForFunction(() => !!(window as any).a3);
    const result = await p.evaluate(async () => {
      const { db } = (window as any).a3;
      const seam = db.makeIdbSeam();
      // The predecessor died without releasing its lease. Three seconds remain:
      // longer than the normal two-second contention budget, without a 15s test.
      const lease = {
        owner: "dead-page",
        token: "dead-page:1",
        ts: Date.now() - 12_000,
      };
      await seam.put("lock|local|local", lease);
      const boot = db.initDb();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const during = await seam.get("lock|local|local");
      await boot;
      return {
        during,
        lease,
        expired: Date.now() - lease.ts > 15_000,
        after: await seam.get("lock|local|local"),
        title: db
          .getDb()
          .get("SELECT title FROM items WHERE id = ?", ["retained"]).title,
      };
    });
    assert.deepEqual(
      result.during,
      result.lease,
      "boot must not steal an unexpired lease",
    );
    assert.equal(result.expired, true);
    assert.equal(result.after, undefined);
    assert.equal(result.title, "saved");
  } finally {
    await ctx.close();
  }
});

test("real IDB put and delete reject a transaction aborted after request success", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    const result = await p.evaluate(async () => {
      const seam = (window as any).a3.db.makeIdbSeam();
      await seam.put("sentinel", "kept");
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof originalPut>
      ) {
        const req = originalPut.apply(this, args);
        req.addEventListener("success", () => this.transaction.abort());
        return req;
      };
      let putRejected = false;
      try {
        await seam.put("aborted", "must not land");
      } catch {
        putRejected = true;
      }
      IDBObjectStore.prototype.put = originalPut;
      const originalDelete = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (
        ...args: Parameters<typeof originalDelete>
      ) {
        const req = originalDelete.apply(this, args);
        req.addEventListener("success", () => this.transaction.abort());
        return req;
      };
      let deleteRejected = false;
      try {
        await seam.del("sentinel");
      } catch {
        deleteRejected = true;
      }
      IDBObjectStore.prototype.delete = originalDelete;
      return {
        putRejected,
        deleteRejected,
        aborted: await seam.get("aborted"),
        sentinel: await seam.get("sentinel"),
      };
    });
    assert.deepEqual(result, {
      putRejected: true,
      deleteRejected: true,
      aborted: undefined,
      sentinel: "kept",
    });
  } finally {
    await ctx.close();
  }
});

test("flush terminates a worker that never answers and lands directly without a waiter cycle", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    await init(p);
    await p.evaluate(async () => {
      const { db } = (window as any).a3;
      // Reset terminates the boot worker. A hung worker is then installed before boot.
      db.resetDbForTest();
      (window as any).Worker = class {
        onmessage: unknown;
        onerror: unknown;
        onmessageerror: unknown;
        postMessage() {
          (window as any).workerStarted = true;
        }
        terminate() {
          (window as any).workerTerminated = true;
        }
      };
      (window as any).boot = db.initDb();
    });
    await p.waitForFunction(() => (window as any).workerStarted);
    await p.evaluate(async () => {
      const { db } = (window as any).a3;
      await db.flushPersist();
      await (window as any).boot;
    });
    assert.equal(
      await p.evaluate(() => (window as any).workerTerminated),
      true,
    );
    assert.ok(
      await p.evaluate(
        async () =>
          (await (window as any).a3.db.makeIdbSeam().get("db|local|local")).snap
            .length > 0,
      ),
    );
  } finally {
    await ctx.close();
  }
});

test("blob rebind rejects old downloads/uploads, uses captured endpoint and keeps 413 pending", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    await p.evaluate(async () => {
      const { db } = (window as any).a3;
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a.example", token: "token-a" }),
      );
      localStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
      await db.initDb();
      (window as any).requests = [];
      window.fetch = async (url, options) => {
        (window as any).requests.push({
          url: String(url),
          token: (options?.headers as any)?.Authorization,
          method: options?.method,
        });
        return new Promise<Response>((resolve) => {
          (window as any).finishRequest = resolve;
        });
      };
      const { blobs } = (window as any).a3;
      (window as any).hashA = await blobs.storeFile(
        new File(["alice-private"], "a"),
      );
      (window as any).download = blobs.getBlob("remote-a", null);
    });
    await p.waitForFunction(() => !!(window as any).finishRequest);
    await p.evaluate(async () => {
      const { db } = (window as any).a3;
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://b.example", token: "token-b" }),
      );
      localStorage.setItem("carbon.user", JSON.stringify({ id: "bob" }));
      await db.rebindIdentity();
      (window as any).finishRequest(new Response("alice secret"));
      await (window as any).download;
    });
    assert.equal(
      await p.evaluate(async () =>
        (window as any).a3.blobs.getCachedBlob("remote-a", null),
      ),
      null,
    );
    assert.equal(
      await p.evaluate(async () => (window as any).a3.blobs.pendingBlobCount()),
      0,
    );
    await p.evaluate(async () => {
      const { blobs } = (window as any).a3;
      (window as any).hashB = await blobs.storeFile(
        new File(["bob-only"], "b"),
      );
      window.fetch = async (url, options) => {
        (window as any).requests.push({
          url: String(url),
          token: (options?.headers as any)?.Authorization,
          method: options?.method,
        });
        return new Response("", { status: 413 });
      };
      await blobs.uploadPendingBlobs();
    });
    assert.equal(
      await p.evaluate(async () => (window as any).a3.blobs.pendingBlobCount()),
      1,
    );
    const requests = await p.evaluate(() => (window as any).requests);
    assert.equal(requests[0].url, "https://a.example/api/blobs/remote-a");
    assert.equal(requests[0].token, "Bearer token-a");
    assert.ok(requests[1].url.startsWith("https://b.example/api/blobs/"));
    assert.equal(requests[1].token, "Bearer token-b");
    assert.ok(
      !requests[1].url.endsWith(await p.evaluate(() => (window as any).hashA)),
    );
    // Hold B's upload response across a real DB/blob rebind back to A.
    await p.evaluate(async () => {
      window.fetch = async () =>
        new Promise<Response>((resolve) => {
          (window as any).finishUpload = resolve;
        });
      (window as any).upload = (window as any).a3.blobs
        .uploadPendingBlobs()
        .catch(() => {});
    });
    await p.waitForFunction(() => !!(window as any).finishUpload);
    await p.evaluate(async () => {
      const { db } = (window as any).a3;
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a.example", token: "token-a" }),
      );
      localStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
      await db.rebindIdentity();
      (window as any).finishUpload(new Response(""));
      await (window as any).upload;
    });
    assert.equal(
      await p.evaluate(async () => (window as any).a3.blobs.pendingBlobCount()),
      1,
    );
    assert.equal(
      await p.evaluate(
        async () =>
          !!(await (window as any).a3.blobs.getCachedBlob(
            (window as any).hashB,
            null,
          )),
      ),
      false,
    );
  } finally {
    await ctx.close();
  }
});

test("production worker fences stale leases, caps history at 64 MB, and closes its IDB connection", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    const result = await p.evaluate(async () => {
      const seam = (window as any).a3.db.makeIdbSeam();
      const snap = new Uint8Array(34 * 1024 * 1024);
      await seam.put("db|worker", { gen: 0, snap });
      await seam.put("dblog|worker", [{ gen: 0, snap }]);
      await seam.put("lock|worker", {
        owner: "test",
        token: "current",
        ts: Date.now(),
      });
      const w = new Worker("/persist.worker.ts", { type: "module" });
      const send = (token: string, gen: number) =>
        new Promise<any>((resolve) => {
          w.onmessage = (e) => resolve(e.data);
          w.postMessage({
            id: gen,
            key: "db|worker",
            logKey: "dblog|worker",
            lockKey: "lock|worker",
            token,
            gen,
            snap,
          });
        });
      const first = await send("current", 1);
      const stale = await send("expired-token", 2);
      const history = await seam.get("dblog|worker");
      const current = await seam.get("db|worker");
      // A leaked worker connection would block deletion even though the seam
      // closes its own connection via onversionchange.
      const closed = await new Promise<boolean>((resolve, reject) => {
        const req = indexedDB.deleteDatabase("carbon_meta");
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(false);
      });
      w.terminate();
      return {
        first: first.ok,
        stale: stale.ok,
        gen: current.gen,
        bytes: history.reduce((n: number, e: any) => n + e.snap.byteLength, 0),
        closed,
      };
    });
    assert.equal(result.first, true);
    assert.equal(result.stale, false);
    assert.equal(result.gen, 1);
    assert.ok(result.bytes <= 64 * 1024 * 1024);
    assert.equal(result.closed, true);
  } finally {
    await ctx.close();
  }
});

test("occupied destinations retain legacy-only work and global claims prevent cross-account copies", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    const result = await p.evaluate(async () => {
      const { db, core, blobs, localforage } = (window as any).a3;
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a.example", token: "a" }),
      );
      localStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
      await db.initDb();
      core.recordOp(db.getDb(), "device", "legacy-only", {
        title: "only in legacy",
      });
      const legacyBytes = db.exportDb();
      db.getDb().run("DELETE FROM items WHERE id = ?", ["legacy-only"]);
      db.getDb().run("DELETE FROM ops WHERE item_id = ?", ["legacy-only"]);
      await db.flushPersist();
      await blobs.storeFile(new File(["existing-alice"], "a"));
      const oldDb = localforage.createInstance({
        name: "carbon",
        storeName: "carbon",
      });
      const oldBlobs = localforage.createInstance({
        name: "carbon",
        storeName: "blobs",
      });
      await oldDb.setItem("carbon_db", legacyBytes);
      await oldBlobs.setItem(
        "legacy-private",
        new TextEncoder().encode("only legacy bytes").buffer,
      );
      await oldBlobs.setItem("pendingBlobs", ["legacy-private"]);
      db.resetDbForTest();
      await db.initDb();
      const retainedDb = !!(await oldDb.getItem("carbon_db"));
      const retainedBlob = !!(await oldBlobs.getItem("legacy-private"));
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://b.example", token: "b" }),
      );
      localStorage.setItem("carbon.user", JSON.stringify({ id: "bob" }));
      await db.rebindIdentity();
      return {
        retainedDb,
        retainedBlob,
        bobItems: db.localItemCount(),
        bobPending: await blobs.pendingBlobCount(),
        bobPrivate: !!(await blobs.getCachedBlob("legacy-private", null)),
      };
    });
    assert.deepEqual(result, {
      retainedDb: true,
      retainedBlob: true,
      bobItems: 0,
      bobPending: 0,
      bobPrivate: false,
    });
  } finally {
    await ctx.close();
  }
});

test("keep-offline cancellation discards late responses even when the identity stays the same", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    await p.evaluate(async () => {
      const { db, blobs } = (window as any).a3;
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a.example", token: "a" }),
      );
      localStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
      await db.initDb();
      window.fetch = async () =>
        new Promise<Response>((resolve) => {
          (window as any).finish = resolve;
        });
      (window as any).download = blobs.getBlob("late", null);
    });
    await p.waitForFunction(() => !!(window as any).finish);
    await p.evaluate(async () => {
      const { db, blobs } = (window as any).a3;
      blobs.cancelBlobRequests();
      localStorage.setItem(
        "carbon.offlineUser",
        JSON.stringify({ ws: "https://a.example", id: "alice" }),
      );
      localStorage.removeItem("carbon.user");
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a.example", token: "" }),
      );
      await db.rebindIdentity();
      (window as any).finish(new Response("stale secret"));
      await (window as any).download;
    });
    assert.equal(
      await p.evaluate(() => (window as any).a3.db.getBoundIdentity()),
      "https://a.example|u:alice",
    );
    assert.equal(
      await p.evaluate(
        async () =>
          !!(await (window as any).a3.blobs.getCachedBlob("late", null)),
      ),
      false,
    );
  } finally {
    await ctx.close();
  }
});

test("settings sync snapshots only the full matching identity suffix", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    await p.evaluate(async () => {
      const { db, settings, events, useStore } = (window as any).a3;
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a.example", token: "a" }),
      );
      localStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
      await db.initDb();
      useStore.setState({ currentUser: { id: "alice" } });
      localStorage.setItem(
        "carbon.viewprefs.inbox::https://a.example|u:alice",
        '{"own":true}',
      );
      localStorage.setItem(
        "carbon.viewprefs.private::https://b.example|u:alice",
        '{"secret":true}',
      );
      localStorage.setItem(
        "carbon.viewprefs.other::https://a.example|u:bob",
        '{"secret":true}',
      );
      settings.initSettingsSync();
      events.notifySettingsChanged("views");
    });
    await p.waitForFunction(
      () =>
        !!(window as any).a3.db
          .getDb()
          .get(
            "SELECT data FROM record_ops WHERE entity = 'setting' AND row_id = 'views'",
          ),
    );
    const prefs = await p.evaluate(
      () =>
        JSON.parse(
          (window as any).a3.db
            .getDb()
            .get(
              "SELECT data FROM record_ops WHERE entity = 'setting' AND row_id = 'views'",
            ).data,
        ).payload.prefs,
    );
    assert.deepEqual(prefs, { inbox: { own: true } });
  } finally {
    await ctx.close();
  }
});

// Initial collision hypothesis disproved: createInstance(options) preserves raw
// store names. Only localforage.config({storeName}) normalizes punctuation; the
// production store() path does not call that API. Keep this production regression.
test("production raw blob stores keep punctuation-distinct identities isolated", async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    const result = await p.evaluate(async () => {
      const { db, blobs } = (window as any).a3;
      const first = "https://a-b.example|u:alice";
      const second = "https://a.b.example|u:alice";
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a-b.example", token: "first" }),
      );
      localStorage.setItem("carbon.user", JSON.stringify({ id: "alice" }));
      await db.initDb();
      const firstHash = await blobs.storeFile(
        new File(["private-first"], "first"),
      );
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a.b.example", token: "second" }),
      );
      await db.rebindIdentity();
      const secondPendingBefore = await blobs.pendingBlobCount();
      const secondSeesFirst = !!(await blobs.getCachedBlob(firstHash, null));
      const secondHash = await blobs.storeFile(
        new File(["private-second"], "second"),
      );
      localStorage.setItem(
        "carbon.server",
        JSON.stringify({ url: "https://a-b.example", token: "first" }),
      );
      await db.rebindIdentity();
      const physicalStores = await new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("carbon");
        request.onsuccess = () => {
          resolve(Array.from(request.result.objectStoreNames));
          request.result.close();
        };
        request.onerror = () => reject(request.error);
      });
      return {
        firstPhysicalStore: physicalStores.includes(`blobs|${first}`),
        secondPhysicalStore: physicalStores.includes(`blobs|${second}`),
        secondPendingBefore,
        secondSeesFirst,
        firstPending: await blobs.pendingBlobCount(),
        firstSeesSecond: !!(await blobs.getCachedBlob(secondHash, null)),
        firstBytes: await (await blobs.getCachedBlob(firstHash, null)).text(),
      };
    });
    assert.deepEqual(result, {
      firstPhysicalStore: true,
      secondPhysicalStore: true,
      secondPendingBefore: 0,
      secondSeesFirst: false,
      firstPending: 1,
      firstSeesSecond: false,
      firstBytes: "private-first",
    });
  } finally {
    await ctx.close();
  }
});
