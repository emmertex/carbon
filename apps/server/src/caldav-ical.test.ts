import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "@carbon/core";
import {
  itemToVtodo,
  vtodoToItemPatch,
  itemToVevent,
  veventToItemPatch,
  carbonToIcalPriority,
  icalToCarbonPriority,
  contentHash,
  detectKind,
} from "./caldav-ical";

function item(over: Partial<Item>): Item {
  return {
    id: "i1",
    parent_id: null,
    type: "task",
    owner_id: null,
    title: "",
    note: null,
    status: "active",
    flagged: false,
    priority: 0,
    defer_date: null,
    due_date: null,
    reminder_at: null,
    estimate_minutes: null,
    completed_at: null,
    review_interval: null,
    reviewed_at: null,
    recurrence: null,
    geo: null,
    color: null,
    folder_id: null,
    sort_order: 0,
    order_mode: "parallel",
    sys_kind: null,
    metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted: false,
    ...over,
  };
}

test("VTODO round-trip preserves mapped fields", () => {
  const it = item({
    title: "Buy milk; eggs, bread",
    note: "two lines\nsecond",
    due_date: "2026-06-28T15:30:00.000Z",
    defer_date: "2026-06-27T09:00:00.000Z",
    priority: 3,
  });
  const ics = itemToVtodo(it, "uid-1");
  assert.equal(detectKind(ics), "todo");
  const parsed = vtodoToItemPatch(ics);
  assert.ok(parsed);
  assert.equal(parsed.uid, "uid-1");
  assert.equal(parsed.patch.title, "Buy milk; eggs, bread"); // ; and , survive escaping
  assert.equal(parsed.patch.note, "two lines\nsecond");
  assert.equal(parsed.patch.due_date, "2026-06-28T15:30:00.000Z");
  assert.equal(parsed.patch.defer_date, "2026-06-27T09:00:00.000Z");
  assert.equal(parsed.patch.priority, 3);
  assert.equal(parsed.completed, false);
});

test("VTODO completed status round-trips", () => {
  const it = item({
    title: "done thing",
    status: "done",
    completed_at: "2026-06-20T00:00:00.000Z",
  });
  const parsed = vtodoToItemPatch(itemToVtodo(it, "u"));
  assert.ok(parsed);
  assert.equal(parsed.completed, true);
});

test("priority maps both directions across buckets", () => {
  assert.equal(carbonToIcalPriority(0), 0);
  assert.equal(carbonToIcalPriority(1), 9);
  assert.equal(carbonToIcalPriority(2), 5);
  assert.equal(carbonToIcalPriority(3), 1);
  assert.equal(icalToCarbonPriority(0), 0);
  assert.equal(icalToCarbonPriority(1), 3);
  assert.equal(icalToCarbonPriority(4), 3);
  assert.equal(icalToCarbonPriority(5), 2);
  assert.equal(icalToCarbonPriority(9), 1);
  // Carbon → iCal → Carbon is stable for every bucket.
  for (const p of [0, 1, 2, 3]) {
    assert.equal(icalToCarbonPriority(carbonToIcalPriority(p)), p);
  }
});

test("VEVENT round-trip: due→DTSTART, estimate→duration", () => {
  const it = item({
    title: "Dentist",
    due_date: "2026-06-28T15:00:00.000Z",
    estimate_minutes: 45,
  });
  const ics = itemToVevent(it, "uid-e", 30);
  assert.equal(detectKind(ics), "event");
  const parsed = veventToItemPatch(ics);
  assert.ok(parsed);
  assert.equal(parsed.patch.due_date, "2026-06-28T15:00:00.000Z");
  assert.equal(parsed.patch.estimate_minutes, 45);
});

test("VEVENT uses default duration when no estimate", () => {
  const it = item({ title: "Call", due_date: "2026-06-28T15:00:00.000Z" });
  const parsed = veventToItemPatch(itemToVevent(it, "u", 30));
  assert.ok(parsed);
  assert.equal(parsed.patch.estimate_minutes, 30);
});

test("all-day due (23:59 marker) round-trips as VALUE=DATE", () => {
  // local 23:59 marker
  const due = new Date(2026, 5, 28, 23, 59, 0, 0).toISOString();
  const it = item({ title: "All day", due_date: due });
  const ics = itemToVevent(it, "u", 30);
  assert.match(ics, /DTSTART;VALUE=DATE:20260628/);
  const parsed = veventToItemPatch(ics);
  assert.ok(parsed);
  assert.equal(parsed.patch.due_date, due); // same local 23:59 marker
  // all-day events carry no meaningful duration estimate
  assert.equal(parsed.patch.estimate_minutes, undefined);
});

function veventTZ(tzid: string, dtstart: string, dtend: string): string {
  return (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:tz\r\n" +
    `DTSTART;TZID=${tzid}:${dtstart}\r\nDTEND;TZID=${tzid}:${dtend}\r\n` +
    "SUMMARY:Zoned\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
  );
}

test("inbound DTSTART with a TZID resolves to the correct UTC instant (no DST)", () => {
  // Australia/Melbourne in July is AEST (UTC+10): 09:00 local = 23:00Z the day before.
  const parsed = veventToItemPatch(
    veventTZ("Australia/Melbourne", "20260715T090000", "20260715T093000"),
  );
  assert.ok(parsed);
  assert.equal(parsed.patch.due_date, "2026-07-14T23:00:00.000Z");
  assert.equal(parsed.patch.estimate_minutes, 30);
});

test("inbound DTSTART with a TZID honours DST", () => {
  // Australia/Melbourne in January is AEDT (UTC+11): 09:00 local = 22:00Z the day before.
  const parsed = veventToItemPatch(
    veventTZ("Australia/Melbourne", "20260115T090000", "20260115T100000"),
  );
  assert.ok(parsed);
  assert.equal(parsed.patch.due_date, "2026-01-14T22:00:00.000Z");
  assert.equal(parsed.patch.estimate_minutes, 60);
});

test("an unrecognised TZID falls back without throwing", () => {
  const parsed = veventToItemPatch(
    veventTZ("Not/AZone", "20260715T090000", "20260715T093000"),
  );
  assert.ok(parsed); // no crash; interpreted as local wall-clock
  assert.ok(parsed.patch.due_date);
});

// ----- all-day timezone skew (CAL-1) ----------------------------------------
// Carbon stores an all-day date as "local 23:59 on that day". The encode/decode here
// must anchor that "local" to the *item owner's* zone (threaded in as the `tz` arg),
// not the server process's. These tests run the same logic under several owner zones —
// the deterministic analogue of the review's "run under TZ=UTC / Australia/Melbourne /
// America/Los_Angeles" reproduction — and assert the round-tripped calendar day and the
// all-day classification survive regardless of where the server (or these tests) run.

/** Wall-clock fields of an instant as seen in an IANA zone — the test-side mirror of the
 *  connector's zone resolution, used to assert what a user in `tz` actually sees. */
function partsInZone(
  iso: string,
  tz: string,
): { y: number; mo: number; da: number; hh: number; mm: number } {
  const f: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso)))
    if (p.type !== "literal") f[p.type] = Number(p.value);
  return {
    y: f.year,
    mo: f.month,
    da: f.day,
    hh: f.hour === 24 ? 0 : f.hour,
    mm: f.minute,
  };
}

function veventAllDay(ymd: string): string {
  return (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ad\r\n" +
    `DTSTART;VALUE=DATE:${ymd}\r\nDTEND;VALUE=DATE:${ymd}\r\n` +
    "SUMMARY:All day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
  );
}

function vtodoAllDay(ymd: string): string {
  return (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:ad\r\n" +
    `DUE;VALUE=DATE:${ymd}\r\nSUMMARY:All day\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`
  );
}

const OWNER_ZONES = ["UTC", "Australia/Melbourne", "America/Los_Angeles"];

for (const tz of OWNER_ZONES) {
  test(`all-day VEVENT round-trips on the same calendar day for an owner in ${tz}`, () => {
    // Import: an external all-day "2026-07-10" (no time, no zone) for this owner.
    const parsed = veventToItemPatch(veventAllDay("20260710"), tz);
    assert.ok(parsed);
    const due = parsed.patch.due_date;
    assert.ok(due);
    // Classified all-day → no meaningful duration.
    assert.equal(parsed.patch.estimate_minutes, undefined);
    // The stored instant is this owner's "local 23:59" on the intended day — so on their
    // own device it reads back as 2026-07-10 23:59, never sliding to the 9th or 11th.
    assert.deepEqual(partsInZone(due, tz), {
      y: 2026,
      mo: 7,
      da: 10,
      hh: 23,
      mm: 59,
    });
    // Export: back out to the calendar as an all-day VALUE=DATE on the same day...
    const ics = itemToVevent(
      item({ title: "All day", due_date: due }),
      "u",
      30,
      tz,
    );
    assert.match(ics, /DTSTART;VALUE=DATE:20260710/);
    assert.match(ics, /DTEND;VALUE=DATE:20260711/); // exclusive end = next day
    // ...and NOT misclassified as a timed event (the export-side half of the bug).
    assert.doesNotMatch(ics, /DTSTART:20260710T/);
  });

  test(`all-day VTODO DUE round-trips on the same calendar day for an owner in ${tz}`, () => {
    const parsed = vtodoToItemPatch(vtodoAllDay("20260710"), tz);
    assert.ok(parsed);
    const due = parsed.patch.due_date;
    assert.ok(due);
    assert.deepEqual(partsInZone(due, tz), {
      y: 2026,
      mo: 7,
      da: 10,
      hh: 23,
      mm: 59,
    });
    const ics = itemToVtodo(item({ title: "All day", due_date: due }), "u", tz);
    assert.match(ics, /DUE;VALUE=DATE:20260710/);
    assert.doesNotMatch(ics, /DUE:20260710T/);
  });
}

test("anchoring all-day to the owner's zone (not the server's) fixes the day shift", () => {
  // The exact bug from the review: a Melbourne (UTC+10) owner against a UTC server. If the
  // all-day date is anchored to the wrong (server/UTC) zone, the stored 23:59Z instant reads
  // back in Melbourne as 09:59 the *next* day — July 10 becomes July 11.
  const wrong = veventToItemPatch(veventAllDay("20260710"), "UTC");
  assert.ok(wrong?.patch.due_date);
  assert.equal(partsInZone(wrong.patch.due_date, "Australia/Melbourne").da, 11);
  // Anchoring to the owner's own zone keeps the calendar day intact.
  const right = veventToItemPatch(veventAllDay("20260710"), "Australia/Melbourne");
  assert.ok(right?.patch.due_date);
  assert.equal(partsInZone(right.patch.due_date, "Australia/Melbourne").da, 10);
  assert.equal(partsInZone(right.patch.due_date, "Australia/Melbourne").hh, 23);
});

test("export: a Melbourne owner's all-day instant is not misclassified as timed", () => {
  // A Melbourne browser stores "due July 10, all day" as 23:59 AEST = 2026-07-10T13:59:00Z.
  // Under the old server-local (UTC) logic that instant looked like 13:59 → a timed event.
  // With the owner zone threaded in, it's correctly an all-day VALUE=DATE on July 10.
  const melbAllDay = "2026-07-10T13:59:00.000Z";
  assert.deepEqual(partsInZone(melbAllDay, "Australia/Melbourne"), {
    y: 2026,
    mo: 7,
    da: 10,
    hh: 23,
    mm: 59,
  });
  const ics = itemToVevent(
    item({ title: "All day", due_date: melbAllDay }),
    "u",
    30,
    "Australia/Melbourne",
  );
  assert.match(ics, /DTSTART;VALUE=DATE:20260710/);
  assert.doesNotMatch(ics, /DTSTART:20260710T135900Z/);
});

test("with no owner zone, all-day falls back to the server-local marker (unchanged)", () => {
  // tz omitted → historical behaviour: the local 23:59 marker round-trips as VALUE=DATE.
  const due = new Date(2026, 5, 28, 23, 59, 0, 0).toISOString();
  const ics = itemToVevent(item({ title: "All day", due_date: due }), "u", 30);
  assert.match(ics, /DTSTART;VALUE=DATE:20260628/);
  const back = veventToItemPatch(ics);
  assert.ok(back);
  assert.equal(back.patch.due_date, due);
  assert.equal(back.patch.estimate_minutes, undefined);
});

test("contentHash is stable for unmapped changes, changes for mapped ones", () => {
  const base = item({
    title: "X",
    due_date: "2026-06-28T15:00:00.000Z",
    estimate_minutes: 30,
  });
  const h0 = contentHash("todo", base, 30);
  // changing an unmapped field (sort_order) must not change the hash
  assert.equal(contentHash("todo", item({ ...base, sort_order: 99 }), 30), h0);
  // changing the updated_at (only feeds DTSTAMP) must not change the hash
  assert.equal(
    contentHash(
      "todo",
      item({ ...base, updated_at: "2030-01-01T00:00:00.000Z" }),
      30,
    ),
    h0,
  );
  // changing a mapped field (title) must change the hash
  assert.notEqual(contentHash("todo", item({ ...base, title: "Y" }), 30), h0);
});
