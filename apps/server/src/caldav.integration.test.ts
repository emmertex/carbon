import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  migrate,
  createItem,
  updateItem,
  getItem,
  getChildren,
  visibleItemIds,
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
import { ensureUserPrefsTables, setUserTimezone } from "./user-prefs";

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

test("a new remote VEVENT becomes a dated task under the project", async () => {
  const proj = createItem(db, dev, { type: "project", title: "Inbox" });
  upsertCaldavConfig(db, proj.id, {
    username: "u",
    password: "p",
    event_url: `${mock.base}/cal/`,
    sync_events: true,
  });
  mock.put(
    "/cal/ext-ev-1.ics",
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ext-ev-1\r\n" +
      "SUMMARY:External meeting\r\nDTSTART:20260801T090000Z\r\nDTEND:20260801T100000Z\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  const r = await syncProject(db, dev, getCaldavConfigRow(db, proj.id)!, true);
  assert.deepEqual(r.errors, []);
  const t = getChildren(db, proj.id).find((k) => k.title === "External meeting");
  assert.ok(t, "external event should create a task");
  assert.equal(t!.due_date, "2026-08-01T09:00:00.000Z");
});

test("a pushed event returned under a different href is not re-imported (echo)", async () => {
  // Reproduces the push→pull-back duplicate: a server stores/returns our PUT under a
  // different path than we wrote (e.g. re-encoding the '@' in the UID, or relocating
  // it). href-only matching would miss the link and re-import our own event.
  const proj = createItem(db, dev, { type: "project", title: "Echo" });
  const task = createItem(db, dev, {
    type: "task",
    title: "My event",
    parentId: proj.id,
    dueDate: "2026-12-01T09:00:00.000Z",
    ownerId: "carol",
  });
  upsertCaldavConfig(db, proj.id, {
    username: "u",
    password: "p",
    event_url: `${mock.base}/cal/`,
    sync_events: true,
  });
  // sync 1: push creates the VEVENT + link
  await syncProject(db, dev, getCaldavConfigRow(db, proj.id)!, true);
  // relocate the pushed resource to a different href, keeping the same UID inside
  let oldHref: string | undefined;
  let ics: string | undefined;
  for (const [h, v] of mock.store)
    if (v.ics.includes(`carbon-${task.id}-event`)) {
      oldHref = h;
      ics = v.ics;
    }
  assert.ok(oldHref && ics, "pushed VEVENT should exist");
  mock.store.delete(oldHref!);
  mock.put(`/cal/server-relocated-${task.id}.ics`, ics!);
  // sync 2: must NOT duplicate the task and must NOT clear its due date
  const r = await syncProject(db, dev, getCaldavConfigRow(db, proj.id)!, true);
  assert.deepEqual(r.errors, []);
  const mine = getChildren(db, proj.id).filter(
    (k) => k.title === "My event" && !k.deleted,
  );
  assert.equal(mine.length, 1); // no duplicate re-import
  assert.equal(getItem(db, task.id)!.due_date, "2026-12-01T09:00:00.000Z");
});

test("a recurring event whose series started in the past is still imported", async () => {
  const proj = createItem(db, dev, { type: "project", title: "Recurring pull" });
  upsertCaldavConfig(db, proj.id, {
    username: "u",
    password: "p",
    event_url: `${mock.base}/cal/`,
    sync_events: true,
  });
  // A weekly meeting that began months ago but recurs indefinitely.
  mock.put(
    "/cal/weekly.ics",
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:weekly-standup\r\n" +
      "SUMMARY:Weekly standup\r\nDTSTART:20260101T090000Z\r\nDTEND:20260101T093000Z\r\n" +
      "RRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  const r = await syncProject(db, dev, getCaldavConfigRow(db, proj.id)!, true);
  assert.deepEqual(r.errors, []);
  const t = getChildren(db, proj.id).find((k) => k.title === "Weekly standup");
  assert.ok(t, "a recurring event must not be filtered as 'past'");
});

test("a pulled task inherits the project owner and is visible to that user", async () => {
  // A project owned by a real (authenticated) user — the multi-user case where
  // visibility is owner/share-scoped, not the open 'local' single-user mode.
  const owned = createItem(db, dev, {
    type: "project",
    title: "Owned",
    ownerId: "alice",
  });
  upsertCaldavConfig(db, owned.id, {
    username: "u",
    password: "p",
    event_url: `${mock.base}/cal/`,
    sync_events: true,
  });
  mock.put(
    "/cal/owned-ev.ics",
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:owned-ev\r\n" +
      "SUMMARY:Owned meeting\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  const r = await syncProject(db, dev, getCaldavConfigRow(db, owned.id)!, true);
  assert.deepEqual(r.errors, []);
  const t = getChildren(db, owned.id).find((k) => k.title === "Owned meeting");
  assert.ok(t, "task should be created");
  assert.equal(t!.owner_id, "alice"); // inherits the project owner
  assert.ok(
    visibleItemIds(db, "alice").has(t!.id),
    "must be visible to the owner so /api/sync fans it out",
  );
});

test("a re-sync heals a pre-existing orphan task (null owner) into visibility", async () => {
  const owned = createItem(db, dev, {
    type: "project",
    title: "Heal",
    ownerId: "bob",
  });
  upsertCaldavConfig(db, owned.id, {
    username: "u",
    password: "p",
    event_url: `${mock.base}/cal/`,
    sync_events: true,
  });
  mock.put(
    "/cal/heal-ev.ics",
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:heal-ev\r\n" +
      "SUMMARY:Heal me\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T100000Z\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  await syncProject(db, dev, getCaldavConfigRow(db, owned.id)!, true);
  const t = getChildren(db, owned.id).find((k) => k.title === "Heal me")!;
  // simulate the pre-fix orphan: strip the owner so it's invisible
  updateItem(db, dev, t.id, { owner_id: null });
  assert.ok(!visibleItemIds(db, "bob").has(t.id));
  // next sync heals it back to the project owner
  await syncProject(db, dev, getCaldavConfigRow(db, owned.id)!, true);
  assert.equal(getItem(db, t.id)!.owner_id, "bob");
  assert.ok(visibleItemIds(db, "bob").has(t.id));
});

test("two resources sharing a UID collapse to one task (no unique-constraint crash)", async () => {
  // e.g. a recurring event whose override is a second .ics under the same UID.
  const proj = createItem(db, dev, { type: "project", title: "Recurring" });
  upsertCaldavConfig(db, proj.id, {
    username: "u",
    password: "p",
    event_url: `${mock.base}/cal/`,
    sync_events: true,
  });
  const ev = (summary: string, dt: string) =>
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n" +
    `UID:shared-uid@x\r\nSUMMARY:${summary}\r\nDTSTART:${dt}\r\nDTEND:${dt}\r\n` +
    "END:VEVENT\r\nEND:VCALENDAR\r\n";
  mock.put("/cal/dup-a.ics", ev("Standup", "20260710T090000Z"));
  mock.put("/cal/dup-b.ics", ev("Standup override", "20260717T090000Z"));
  const r = await syncProject(db, dev, getCaldavConfigRow(db, proj.id)!, true);
  assert.deepEqual(r.errors, []); // previously: "events: UNIQUE constraint failed…"
  const mine = getChildren(db, proj.id).filter((k) =>
    k.title.startsWith("Standup"),
  );
  assert.equal(mine.length, 1); // one UID → one task
});

test("a past remote VEVENT is never imported (CalDAV pull)", async () => {
  const proj = createItem(db, dev, { type: "project", title: "Upcoming" });
  upsertCaldavConfig(db, proj.id, {
    username: "u",
    password: "p",
    event_url: `${mock.base}/cal/`,
    sync_events: true,
  });
  const vevent = (uid: string, summary: string, dt: string) =>
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n" +
    `UID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:${dt}\r\nDTEND:${dt}\r\n` +
    "END:VEVENT\r\nEND:VCALENDAR\r\n";
  mock.put("/cal/past-ev.ics", vevent("past-ev", "Past DAV event", "20200101T090000Z"));
  mock.put("/cal/future-ev.ics", vevent("future-ev", "Future DAV event", "20990101T090000Z"));
  const r = await syncProject(db, dev, getCaldavConfigRow(db, proj.id)!, true);
  assert.deepEqual(r.errors, []);
  const kids = getChildren(db, proj.id);
  assert.ok(kids.some((k) => k.title === "Future DAV event"));
  assert.ok(!kids.some((k) => k.title === "Past DAV event"));
});

test("all-day task syncs on the owner's calendar day (owner timezone threaded through)", async () => {
  // End-to-end proof that syncProject resolves the project owner's timezone (from
  // user_prefs, the same store NL parsing uses) and threads it into the encoder — so an
  // all-day value lands on the right calendar day even when the server clock differs.
  ensureUserPrefsTables(db);
  const mock2 = await startMock(); // isolated collection, uncontaminated by other tests
  try {
    const ownerId = "owner-melb";
    setUserTimezone(db, ownerId, "Australia/Melbourne"); // UTC+10 in July
    const project = createItem(db, dev, {
      type: "project",
      title: "Melbourne",
      ownerId,
    });
    // "due July 10, all day" exactly as a Melbourne browser stores it: 23:59 AEST = 13:59Z.
    createItem(db, dev, {
      type: "task",
      title: "All day thing",
      parentId: project.id,
      ownerId,
      dueDate: "2026-07-10T13:59:00.000Z",
    });
    const url = `${mock2.base}/cal/`;
    upsertCaldavConfig(db, project.id, {
      username: "u",
      password: "p",
      todo_url: url,
      event_url: url,
      sync_tasks: true,
      sync_events: true,
    });
    const r = await syncProject(db, dev, getCaldavConfigRow(db, project.id)!, true);
    assert.deepEqual(r.errors, []);

    let event: string | undefined;
    let todo: string | undefined;
    for (const [, v] of mock2.store) {
      if (detectKind(v.ics) === "event") event = v.ics;
      if (detectKind(v.ics) === "todo") todo = v.ics;
    }
    assert.ok(event, "a VEVENT was pushed");
    assert.ok(todo, "a VTODO was pushed");
    // All-day on July 10 (owner's zone) — not a timed 13:59Z event, not shifted a day.
    assert.match(event!, /DTSTART;VALUE=DATE:20260710/);
    assert.match(event!, /DTEND;VALUE=DATE:20260711/);
    assert.doesNotMatch(event!, /DTSTART:20260710T135900Z/);
    assert.match(todo!, /DUE;VALUE=DATE:20260710/);
  } finally {
    mock2.close();
  }
});
