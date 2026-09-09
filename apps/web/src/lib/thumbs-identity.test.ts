import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import initSqlJs, { type Database } from "sql.js";
import {
  migrate,
  recordOp,
  getItem,
  type Db,
  type Row,
  type SqlParams,
} from "@carbon/core";

// Exercise the real thumbnail orchestration, canvas await boundaries, and core
// repository operations against sql.js. Only app binding/blob I/O are replaced,
// avoiding browser installation and node's experimental module-mock flags.
const SQL = await initSqlJs();
const sourceHash = "a".repeat(64);
const thumbnailHash = "b".repeat(64);
const databases: Database[] = [];
function database(): Db {
  const sql = new SQL.Database();
  databases.push(sql);
  const db: Db = {
    run: (query, params = []) => {
      sql.run(query, params as never);
    },
    exec: (query) => {
      sql.exec(query);
    },
    all<T = Row>(query: string, params: SqlParams = []): T[] {
      const statement = sql.prepare(query);
      try {
        statement.bind(params as never);
        const rows: T[] = [];
        while (statement.step()) rows.push(statement.getAsObject() as T);
        return rows;
      } finally {
        statement.free();
      }
    },
    get<T = Row>(query: string, params: SqlParams = []): T | undefined {
      return db.all<T>(query, params)[0];
    },
    transaction<T>(fn: () => T): T {
      sql.run("BEGIN");
      try {
        const value = fn();
        sql.run("COMMIT");
        return value;
      } catch (error) {
        sql.run("ROLLBACK");
        throw error;
      }
    },
  };
  migrate(db);
  for (const id of ["same-id", "second-id"]) {
    recordOp(db, "seed", id, {
      title: id,
      note: `<img src="/api/blobs/${sourceHash}">`,
    });
  }
  return db;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const harness = {
  db: null as Db | null,
  namespace: "workspace|u:alice",
  configured: "workspace|u:alice",
  reads: [] as string[],
  writes: [] as string[],
  mutations: [] as string[],
  read: async (): Promise<Blob | null> => new Blob(["private source"]),
  write: async (): Promise<string> => thumbnailHash,
  encode: (done: BlobCallback) => done(new Blob(["encoded private thumbnail"])),
};
(globalThis as unknown as { __thumbHarness: typeof harness }).__thumbHarness =
  harness;
const previousDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const previousBitmap = Object.getOwnPropertyDescriptor(
  globalThis,
  "createImageBitmap",
);
Object.defineProperty(globalThis, "createImageBitmap", {
  configurable: true,
  value: async () => ({ width: 640, height: 320, close() {} }),
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement() {
      return {
        getContext: () => ({ drawImage() {} }),
        toBlob: (done: BlobCallback) => harness.encode(done),
      };
    },
  },
});
const mocks: Record<string, string> = {
  "./db": `export const getDb = () => h.db; export const getBoundIdentity = () => h.db ? h.namespace : null;`,
  "./identity": `export const identityKey = () => h.configured;`,
  "./mutate": `export const mutate = (fn) => { h.mutations.push(h.namespace); return fn(h.db, 'thumbnail-device'); };`,
  "./blobs": `export const getBlob = async () => { h.reads.push(h.namespace); return h.read(); };
    export const getCachedBlob = getBlob;
    export const storeFile = async () => { h.writes.push(h.namespace); return h.write(); };`,
};
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./thumbs.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "thumbnail-app-boundaries",
      setup(builder) {
        builder.onResolve(
          { filter: /^\.\/(db|identity|mutate|blobs)$/ },
          (args) => {
            if (args.importer.endsWith("/thumbs.ts"))
              return { path: args.path, namespace: "thumb-test" };
          },
        );
        builder.onLoad({ filter: /.*/, namespace: "thumb-test" }, (args) => ({
          contents: `const h = globalThis.__thumbHarness; ${mocks[args.path]}`,
        }));
      },
    },
  ],
});
const thumbs = (await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
)) as typeof import("./thumbs");
let alice: Db;
let bob: Db;
function bind(db: Db, namespace: string) {
  harness.db = db;
  harness.namespace = namespace;
  harness.configured = namespace;
}
beforeEach(() => {
  alice = database();
  bob = database();
  bind(alice, "workspace|u:alice");
  harness.reads = [];
  harness.writes = [];
  harness.mutations = [];
  harness.read = async () => new Blob(["private source"]);
  harness.write = async () => thumbnailHash;
  harness.encode = (done) => done(new Blob(["encoded private thumbnail"]));
});
after(() => {
  for (const sql of databases) sql.close();
  if (previousDocument)
    Object.defineProperty(globalThis, "document", previousDocument);
  else Reflect.deleteProperty(globalThis, "document");
  if (previousBitmap)
    Object.defineProperty(globalThis, "createImageBitmap", previousBitmap);
  else Reflect.deleteProperty(globalThis, "createImageBitmap");
  Reflect.deleteProperty(globalThis, "__thumbHarness");
});
function pauseEncoding() {
  const started = deferred<void>();
  const finish = deferred<Blob | null>();
  harness.encode = (done) => {
    started.resolve();
    void finish.promise.then(done);
  };
  return {
    started: started.promise,
    finish: () => finish.resolve(new Blob(["alice private thumbnail"])),
  };
}

test("unchanged binding stores and publishes a thumbnail through real core/sql.js", async () => {
  await thumbs.ensureNoteThumb("same-id", false);
  assert.deepEqual(JSON.parse(getItem(alice, "same-id")!.thumb!), {
    src: sourceHash,
    hash: thumbnailHash,
    w: 320,
    h: 160,
  });
  assert.deepEqual(harness.writes, ["workspace|u:alice"]);
});

test("switch during encoding discards old bytes before calling storeFile on the new account", async () => {
  const encoding = pauseEncoding();
  const pending = thumbs.ensureNoteThumb("same-id", false);
  await encoding.started;
  bind(bob, "workspace|u:bob");
  encoding.finish();
  await pending;
  assert.deepEqual(harness.writes, []);
  assert.equal(getItem(alice, "same-id")!.thumb, null);
  assert.equal(getItem(bob, "same-id")!.thumb, null);
});

test("switch while reading source stops before encoding", async () => {
  const started = deferred<void>();
  const read = deferred<Blob>();
  harness.read = () => {
    started.resolve();
    return read.promise;
  };
  let encodes = 0;
  harness.encode = (done) => {
    encodes++;
    done(new Blob(["thumbnail"]));
  };
  const pending = thumbs.ensureNoteThumb("same-id");
  await started.promise;
  bind(bob, "workspace|u:bob");
  read.resolve(new Blob(["alice source"]));
  await pending;
  assert.equal(encodes, 0);
  assert.deepEqual(harness.writes, []);
});

test("switch while storing thumbnail cannot publish its reference into the new DB", async () => {
  const started = deferred<void>();
  const write = deferred<string>();
  harness.write = () => {
    started.resolve();
    return write.promise;
  };
  const pending = thumbs.ensureNoteThumb("same-id");
  await started.promise;
  bind(bob, "workspace|u:bob");
  write.resolve(thumbnailHash);
  await pending;
  assert.deepEqual(harness.writes, ["workspace|u:alice"]);
  assert.deepEqual(harness.mutations, []);
  assert.equal(getItem(bob, "same-id")!.thumb, null);
});

test("new account with the same item id has independent work and old queued retry is discarded", async () => {
  const encoding = pauseEncoding();
  const pendingAlice = thumbs.ensureNoteThumb("same-id", false);
  await encoding.started;
  await thumbs.ensureNoteThumb("same-id", true); // queue another A request
  bind(bob, "workspace|u:bob");
  harness.encode = (done) => done(new Blob(["bob thumbnail"]));
  await thumbs.ensureNoteThumb("same-id", false);
  try {
    assert.ok(getItem(bob, "same-id")!.thumb, "B must not wait in A's queue");
  } finally {
    encoding.finish();
    await pendingAlice;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(harness.reads, ["workspace|u:alice", "workspace|u:bob"]);
  assert.deepEqual(harness.writes, ["workspace|u:bob"]);
  assert.equal(getItem(alice, "same-id")!.thumb, null);
});

test("backfill stops between items after a binding change and rejects a stale input DB", async () => {
  const encoding = pauseEncoding();
  const pending = thumbs.backfillThumbs(alice);
  await encoding.started;
  bind(bob, "workspace|u:bob");
  encoding.finish();
  await pending;
  await thumbs.backfillThumbs(alice);
  assert.deepEqual(harness.reads, ["workspace|u:alice"]);
  assert.deepEqual(harness.writes, []);
  assert.equal(getItem(bob, "second-id")!.thumb, null);
});

test("replacement DB lifetime invalidates work even when the namespace returns to the same identity", async () => {
  const encoding = pauseEncoding();
  const pending = thumbs.ensureNoteThumb("same-id");
  await encoding.started;
  bind(bob, "workspace|u:bob");
  bind(database(), "workspace|u:alice");
  encoding.finish();
  await pending;
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.mutations, []);
});
