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
