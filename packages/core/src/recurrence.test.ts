import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextOccurrence, nextDueDate } from './recurrence';
import type { Item, RecurrenceRule } from './types';

const at = (s: string) => new Date(s);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// Build dates in LOCAL time so day-of-month assertions don't depend on the test
// machine's zone (recurrence math uses local getters/setters throughout).
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);
const localDay = (x: Date | null) =>
  x ? `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` : null;

test('daily / weekly basic intervals', () => {
  assert.equal(day(nextOccurrence({ type: 'daily', interval: 1 }, at('2026-06-24T09:00:00Z'))), '2026-06-25');
  assert.equal(day(nextOccurrence({ type: 'daily', interval: 3 }, at('2026-06-24T09:00:00Z'))), '2026-06-27');
  assert.equal(day(nextOccurrence({ type: 'weekly', interval: 1 }, at('2026-06-24T09:00:00Z'))), '2026-07-01');
  assert.equal(day(nextOccurrence({ type: 'weekly', interval: 2 }, at('2026-06-24T09:00:00Z'))), '2026-07-08');
});

// C1: setMonth must not overflow when the source day doesn't exist in the target month.
test('monthly from Jan 31 lands on Feb 28, not early March', () => {
  assert.equal(localDay(nextOccurrence({ type: 'monthly', interval: 1 }, local(2026, 1, 31))), '2026-02-28');
});

test('monthly with dayOfMonth=31 clamps to the target month length', () => {
  assert.equal(
    localDay(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 31 }, local(2026, 1, 15))),
    '2026-02-28',
  );
  // A 31-day target month keeps the 31st.
  assert.equal(
    localDay(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 31 }, local(2026, 2, 15))),
    '2026-03-31',
  );
});

test('monthly preserves the source day-of-month across a normal month', () => {
  assert.equal(localDay(nextOccurrence({ type: 'monthly', interval: 1 }, local(2026, 6, 15))), '2026-07-15');
});

// C2 (yearly leap): Feb 29 + 1yr must clamp to Feb 28, not roll to Mar 1.
test('yearly from Feb 29 clamps to Feb 28 in a non-leap year', () => {
  assert.equal(localDay(nextOccurrence({ type: 'yearly', interval: 1 }, local(2024, 2, 29))), '2025-02-28');
  // Leap → leap keeps Feb 29.
  assert.equal(localDay(nextOccurrence({ type: 'yearly', interval: 4 }, local(2024, 2, 29))), '2028-02-29');
});

// C3: weekly with daysOfWeek must honour the interval (skip the off weeks).
test('weekly every-2-weeks on a single weekday skips the in-between week', () => {
  // 2026-06-22 is a Monday (getDay 1).
  const mon = local(2026, 6, 22);
  const rule: RecurrenceRule = { type: 'weekly', interval: 2, daysOfWeek: [1] };
  const next = nextOccurrence(rule, mon);
  assert.equal(localDay(next), '2026-07-06', 'should be two weeks later, not the next Monday');
});

test('weekly interval=1 with daysOfWeek returns the next matching weekday', () => {
  const mon = local(2026, 6, 22); // Monday
  const rule: RecurrenceRule = { type: 'weekly', interval: 1, daysOfWeek: [1, 3] }; // Mon, Wed
  assert.equal(localDay(nextOccurrence(rule, mon)), '2026-06-24', 'Wednesday of the same week');
});

// C2 (catch-up): completing a long-overdue, due-anchored recurrence must produce a
// FUTURE occurrence, not another past one.
test('nextDueDate advances a far-overdue due-anchored task past now', () => {
  const item = {
    recurrence: JSON.stringify({ type: 'daily', interval: 1, fromCompletion: false }),
    due_date: '2026-05-25T12:00:00.000Z',
  } as Item;
  const now = at('2026-06-24T12:00:00.000Z');
  const next = nextDueDate(item, now);
  assert.ok(next && new Date(next) > now, `expected a future date, got ${next}`);
});

test('nextDueDate with fromCompletion anchors on the completion time', () => {
  const item = {
    recurrence: JSON.stringify({ type: 'daily', interval: 1, fromCompletion: true }),
    due_date: '2026-05-25T12:00:00.000Z',
  } as Item;
  const now = at('2026-06-24T12:00:00.000Z');
  assert.equal(nextDueDate(item, now)?.slice(0, 10), '2026-06-25');
});

test("from='completed-keep-time' advances by the completion date but keeps the scheduled time", () => {
  // Due was 09:00; completed late in the day. Next due should be the day after
  // completion, at the original 09:00 — not the completion time-of-day.
  const item = {
    recurrence: JSON.stringify({ type: 'daily', interval: 1, from: 'completed-keep-time' }),
    due_date: local(2026, 5, 25, 9).toISOString(),
  } as Item;
  const completedAt = local(2026, 6, 24, 21); // 9pm
  const next = nextDueDate(item, completedAt);
  assert.ok(next);
  const d = new Date(next!);
  assert.equal(localDay(d), '2026-06-25', 'date advances from the completion date');
  assert.equal(d.getHours(), 9, 'time-of-day stays at the scheduled 09:00');
});

test("from='completed' anchors on the completion date and time", () => {
  const item = {
    recurrence: JSON.stringify({ type: 'daily', interval: 1, from: 'completed' }),
    due_date: local(2026, 5, 25, 9).toISOString(),
  } as Item;
  const completedAt = local(2026, 6, 24, 21);
  const next = nextDueDate(item, completedAt);
  const d = new Date(next!);
  assert.equal(localDay(d), '2026-06-25');
  assert.equal(d.getHours(), 21, 'time-of-day follows the completion time');
});

test('nextDueDate returns null when there is no recurrence rule', () => {
  assert.equal(nextDueDate({ recurrence: null } as Item, new Date()), null);
});
