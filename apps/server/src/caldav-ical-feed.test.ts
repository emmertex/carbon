import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
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
  testCaldav,
} from "./caldav";

// ----- a tiny in-process iCal feed (one .ics document at /feed.ics) ----------
// Read-only: only GET, with ETag + If-None-Match → 304 support.

function feedDoc(events: string[]): string {
  return (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n" +
    events.join("") +
    "END:VCALENDAR\r\n"
  );
}

function vevent(uid: string, summary: string, dtstart: string): string {
  return (
    `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\n` +
    `SUMMARY:${summary}\r\nDTSTART:${dtstart}\r\nDTEND:${dtstart}\r\nEND:VEVENT\r\n`
  );
}

function startMock() {
  const state = { doc: "", etag: "1", hits: 0 };

  const server = http.createServer((req, res) => {
    state.hits++;
    if ((req.method ?? "GET") !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    const ifNone = (req.headers["if-none-match"] as string | undefined)?.replace(
      /"/g,
      "",
    );
    if (ifNone && ifNone === state.etag) {
      res.writeHead(304, { ETag: `"${state.etag}"` });
      res.end();
      return;
    }
    res.writeHead(200, {
      ETag: `"${state.etag}"`,
      "Content-Type": "text/calendar",
    });
    res.end(state.doc);
  });

  return new Promise<{
    base: string;
    state: typeof state;
    set: (doc: string) => void; // update the feed + bump its ETag
    close: () => void;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        state,
        set: (doc) => {
          state.doc = doc;
          state.etag = String(Number(state.etag) + 1);
        },
        close: () => server.close(),
      });
    });
  });
}

let mock: Awaited<ReturnType<typeof startMock>>;
let db: Db;
let dev: string;
let projectId: string;

before(async () => {
  mock = await startMock();
  db = openDb(":memory:");
  migrate(db);
  ensureCaldavTables(db);
  dev = ensureCaldavDeviceId(db);
});

beforeEach(() => {
  // fresh project + config per test so state doesn't leak between cases
  const project = createItem(db, dev, { type: "project", title: "Feed" });
  projectId = project.id;
  upsertCaldavConfig(db, projectId, {
    mode: "ical",
    event_url: `${mock.base}/feed.ics`,
    sync_events: true,
  });
});

after(() => mock.close());

function cfg() {
  return getCaldavConfigRow(db, projectId)!;
}

test("feed events are imported as tasks with due dates", async () => {
  mock.set(
    feedDoc([
      vevent("a@x", "Dentist", "20260710T090000Z"),
      vevent("b@x", "Standup", "20260710T230000Z"),
    ]),
  );
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.pulled, 2);
  assert.equal(r.pushed, 0); // read-only: never pushes
  const kids = getChildren(db, projectId);
  const dentist = kids.find((k) => k.title === "Dentist");
  assert.ok(dentist);
  assert.equal(dentist!.due_date, "2026-07-10T09:00:00.000Z");
});

test("an unchanged feed (304) does nothing on the next poll", async () => {
  mock.set(feedDoc([vevent("a@x", "Dentist", "20260710T090000Z")]));
  await syncProject(db, dev, cfg(), true);
  const r = await syncProject(db, dev, cfg(), true); // ETag unchanged → 304
  assert.deepEqual(r.errors, []);
  assert.equal(r.pulled, 0);
});

test("an edited event updates the linked task", async () => {
  mock.set(feedDoc([vevent("a@x", "Dentist", "20260710T090000Z")]));
  await syncProject(db, dev, cfg(), true);
  mock.set(feedDoc([vevent("a@x", "Dentist (moved)", "20260711T090000Z")]));
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.pulled, 1);
  const kids = getChildren(db, projectId);
  const t = kids.find((k) => k.id !== projectId && !k.deleted);
  assert.equal(t!.title, "Dentist (moved)");
  assert.equal(t!.due_date, "2026-07-11T09:00:00.000Z");
});

test("pure mirror: a removed event clears the task's due date, keeps the task", async () => {
  mock.set(
    feedDoc([
      vevent("a@x", "Dentist", "20260710T090000Z"),
      vevent("b@x", "Standup", "20260710T230000Z"),
    ]),
  );
  await syncProject(db, dev, cfg(), true);
  const before = getChildren(db, projectId).find((k) => k.title === "Dentist")!;
  mock.set(feedDoc([vevent("b@x", "Standup", "20260710T230000Z")])); // drop "a@x"
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  const after = getItem(db, before.id)!;
  assert.equal(after.due_date, null);
  assert.equal(after.deleted, false);
});

test("iCal mode never writes back (server sees only GETs)", async () => {
  const beforeHits = mock.state.hits;
  mock.set(feedDoc([vevent("a@x", "Dentist", "20260710T090000Z")]));
  await syncProject(db, dev, cfg(), true);
  // create + edit a local task; it must never be pushed to the feed
  const local = createItem(db, dev, {
    type: "task",
    title: "local only",
    parentId: projectId,
    dueDate: "2026-07-12T09:00:00.000Z",
  });
  const r = await syncProject(db, dev, cfg(), true);
  assert.equal(r.pushed, 0);
  assert.equal(getItem(db, local.id)!.title, "local only"); // untouched
  assert.ok(mock.state.hits > beforeHits); // it did GET, just never PUT/DELETE
});

test("past events are never imported (Calendar → Carbon)", async () => {
  mock.set(
    feedDoc([
      vevent("past@x", "Old meeting", "20200101T090000Z"),
      vevent("future@x", "Upcoming meeting", "20990101T090000Z"),
    ]),
  );
  const r = await syncProject(db, dev, cfg(), true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.pulled, 1); // only the future one
  const kids = getChildren(db, projectId);
  assert.ok(kids.some((k) => k.title === "Upcoming meeting"));
  assert.ok(!kids.some((k) => k.title === "Old meeting"));
});

test("Test button reports the feed's event count", async () => {
  mock.set(
    feedDoc([
      vevent("a@x", "Dentist", "20260710T090000Z"),
      vevent("b@x", "Standup", "20260710T230000Z"),
    ]),
  );
  const t = await testCaldav(db, projectId, true);
  assert.equal(t.ok, true);
  assert.match(t.message, /events: 2 item\(s\)/);
});
