import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  migrate,
  createItem,
  getItem,
  getChildren,
  type Db,
} from "@carbon/core";
import { openDb } from "./sqlite";
import {
  ensureCaldavTables,
  ensureCaldavDeviceId,
  upsertCaldavConfig,
  getCaldavConfigRow,
  syncProject,
} from "./caldav";
import { detectKind } from "./caldav-ical";

// ----- a tiny in-process CalDAV collection (one collection at /cal/) ---------

interface Stored {
  ics: string;
  etag: string;
}

function startMock() {
  const store = new Map<string, Stored>();
  let counter = 0;
  const state = { force412: false };

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => res(b));
    });
  }

  const server = http.createServer(async (req, res) => {
    const path = req.url ?? "/";
    const method = req.method ?? "GET";
    const ifMatch = (req.headers["if-match"] as string | undefined)?.replace(
      /"/g,
      "",
    );
    const ifNone = req.headers["if-none-match"] as string | undefined;

    if (method === "PROPFIND") {
      const rows = [...store.entries()]
        .map(
          ([href, v]) =>
            `<response><href>${href}</href><propstat><prop><getetag>"${v.etag}"</getetag></prop>` +
            `<status>HTTP/1.1 200 OK</status></propstat></response>`,
        )
        .join("");
      const xml =
        `<?xml version="1.0"?><multistatus xmlns="DAV:">` +
        `<response><href>/cal/</href><propstat><prop><resourcetype><collection/></resourcetype>` +
        `</prop><status>HTTP/1.1 200 OK</status></propstat></response>${rows}</multistatus>`;
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }
    if (method === "GET") {
      const v = store.get(path);
      if (!v) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        ETag: `"${v.etag}"`,
        "Content-Type": "text/calendar",
      });
      res.end(v.ics);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      const exists = store.has(path);
      if (state.force412) {
        state.force412 = false;
        res.writeHead(412);
        res.end();
        return;
      }
      if (ifNone === "*" && exists) {
        res.writeHead(412);
        res.end();
        return;
      }
      if (ifMatch && (!exists || store.get(path)!.etag !== ifMatch)) {
        res.writeHead(412);
        res.end();
        return;
      }
      const etag = String(++counter);
      store.set(path, { ics: body, etag });
      res.writeHead(exists ? 204 : 201, { ETag: `"${etag}"` });
      res.end();
      return;
    }
    if (method === "DELETE") {
      store.delete(path);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });

  return new Promise<{
    base: string;
    store: Map<string, Stored>;
    bump: (path: string, ics: string) => void;
    put: (path: string, ics: string) => void;
    state: { force412: boolean };
    close: () => void;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        store,
        bump: (path, ics) => store.set(path, { ics, etag: String(++counter) }),
        put: (path, ics) => store.set(path, { ics, etag: String(++counter) }),
        state,
        close: () => server.close(),
      });
    });
  });
}

let mock: Awaited<ReturnType<typeof startMock>>;
let db: Db;
let dev: string;
let projectId: string;
let taskId: string;

before(async () => {
  mock = await startMock();
  db = openDb(":memory:");
  migrate(db);
  ensureCaldavTables(db);
  dev = ensureCaldavDeviceId(db);
  const project = createItem(db, dev, { type: "project", title: "Errands" });
  projectId = project.id;
  const task = createItem(db, dev, {
    type: "task",
    title: "Buy milk",
    parentId: projectId,
    dueDate: "2026-07-01T10:00:00.000Z",
  });
  taskId = task.id;
  const url = `${mock.base}/cal/`;
  upsertCaldavConfig(db, projectId, {
    username: "u",
    password: "p",
    todo_url: url,
    event_url: url,
    sync_tasks: true,
    sync_events: true,
  });
});

after(() => mock.close());

function cfg() {
  return getCaldavConfigRow(db, projectId)!;
}

function findKind(k: "todo" | "event"): [string, Stored] {
  for (const [href, v] of mock.store)
    if (detectKind(v.ics) === k) return [href, v];
  throw new Error(`no ${k} in store`);
}

test("push creates a VTODO and a VEVENT for a dated task", async () => {
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.pushed, 2); // one VTODO + one VEVENT
  const [, todo] = findKind("todo");
  const [, event] = findKind("event");
  assert.match(todo.ics, /SUMMARY:Buy milk/);
  assert.match(event.ics, /BEGIN:VEVENT/);
  assert.match(event.ics, /DTSTART:20260701T100000Z/);
});

test("remote edit pulls back into the Carbon task", async () => {
  const [href, v] = findKind("todo");
  mock.bump(href, v.ics.replace("SUMMARY:Buy milk", "SUMMARY:Buy oat milk"));
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  assert.equal(getItem(db, taskId)!.title, "Buy oat milk");
});

test("a new remote VTODO becomes a task under the project", async () => {
  const ics =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:ext-1\r\n" +
    "SUMMARY:Posted from phone\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
  mock.put("/cal/ext-1.ics", ics);
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  const kids = getChildren(db, projectId);
  assert.ok(kids.some((k) => k.title === "Posted from phone"));
});

test("a PUT 412 conflict is recovered (re-fetch + re-push), no error", async () => {
  // local change so push attempts a PUT; force the server to 412 it once.
  const before = findKind("todo")[1].etag;
  createItem(db, dev, { type: "task", title: "unrelated" }); // bump causal clock
  // edit the synced task locally
  const { updateItem } = await import("@carbon/core");
  updateItem(db, dev, taskId, { note: "remember lactose-free" });
  mock.state.force412 = true;
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  assert.equal(mock.state.force412, false); // the forced 412 was consumed
  const after = findKind("todo")[1].etag;
  assert.notEqual(after, before); // a re-PUT landed after the conflict
});

test("remote VEVENT deletion clears the due date but keeps the task", async () => {
  const [href] = findKind("event");
  mock.store.delete(href);
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  const t = getItem(db, taskId)!;
  assert.equal(t.due_date, null);
  assert.equal(t.deleted, false);
});

test("remote VTODO deletion soft-deletes the task", async () => {
  const [href] = findKind("todo"); // the task's todo (title "Buy oat milk")
  // there may be the ext-1 todo too; delete the one matching our task uid
  for (const [h, v] of mock.store) {
    if (
      detectKind(v.ics) === "todo" &&
      v.ics.includes(`carbon-${taskId}-todo`)
    ) {
      mock.store.delete(h);
    }
  }
  void href;
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  assert.equal(getItem(db, taskId)!.deleted, true);
});
