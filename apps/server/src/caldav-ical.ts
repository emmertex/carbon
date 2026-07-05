import { createHash } from "node:crypto";
import { parseRecurrence, type Item, type ItemPatch } from "@carbon/core";

// ----- iCalendar (RFC 5545) mapping -----------------------------------------
// A small, dependency-free encoder/decoder for the VTODO/VEVENT subset Carbon
// syncs. We hand-roll it (rather than pull in a library) because the field set is
// tiny, it keeps the self-hosted server's dependency surface minimal, and it stays
// fully unit-testable with no DB or network. The two directions are deliberate
// inverses so a round-trip (push → pull) is stable.
//
// Known limitations (MVP, documented in docs/caldav.md):
//  - RRULE is encoded outbound only; inbound RRULE is ignored (no recurrence import).
//
// Timezone handling: dates carrying no zone information — all-day (VALUE=DATE) values
// and floating times — are anchored to the *item owner's* IANA zone, threaded in as `tz`
// by caldav.ts (resolved via getUserTimezone). This matters because Carbon's all-day
// convention stores an all-day date as "local 23:59 on that day", and "local" must mean
// the owner's zone, not the server process's. When no owner zone is known, `tz` is null
// and these fall back to the server's local clock (today's behaviour). UTC ("Z") and
// TZID-qualified times carry their own zone and resolve exactly regardless of `tz`.

const PRODID = "-//Carbon//CalDAV Connector//EN";

const pad = (n: number, l = 2): string => String(n).padStart(l, "0");

/** Wall-clock fields of an instant as seen in an IANA zone, or null when the zone name
 *  isn't recognised (the caller then falls back to the server's own local clock). Reuses
 *  the same Intl tz database (h23) as zoneOffsetMs/zonedWallClockToUtc — no external dep. */
function zonedParts(
  iso: string,
  tz: string,
): { y: number; mo: number; da: number; hh: number; mm: number } | null {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null; // not a valid IANA zone
  }
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(iso)))
    if (p.type !== "literal") f[p.type] = Number(p.value);
  // 'hour' can come back as 24 at midnight under h23; normalise to 0.
  const hh = f.hour === 24 ? 0 : f.hour;
  return { y: f.year, mo: f.month, da: f.day, hh, mm: f.minute };
}

/** Carbon stores an all-day defer/due at the "local 23:59" marker, where "local" is the
 *  item owner's zone (`tz`). Evaluated in that zone so the server process's own timezone
 *  can't misclassify an all-day value as timed. Falls back to server-local when tz is null. */
function isAllDay(iso: string, tz?: string | null): boolean {
  if (tz) {
    const p = zonedParts(iso, tz);
    if (p) return p.hh === 23 && p.mm === 59;
  }
  const d = new Date(iso);
  return d.getHours() === 23 && d.getMinutes() === 59;
}

function toICalUTC(iso: string): string {
  const d = new Date(iso);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Calendar date (YYYYMMDD) of an all-day value, taken in the owner's zone (`tz`) — the
 *  23:59 marker belongs to that zone, not the server's. Falls back to server-local. */
function toICalDate(iso: string, tz?: string | null): string {
  if (tz) {
    const p = zonedParts(iso, tz);
    if (p) return `${p.y}${pad(p.mo)}${pad(p.da)}`;
  }
  const d = new Date(iso);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** The calendar day after an all-day YYYYMMDD date (exclusive DTEND for all-day VEVENTs).
 *  Pure calendar arithmetic in UTC, so it's independent of any process/zone offset. */
function nextIcalDate(ymd: string): string {
  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6));
  const da = Number(ymd.slice(6, 8));
  const d = new Date(Date.UTC(y, mo - 1, da + 1));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** Offset (ms) of an IANA zone at a given instant: how far the zone is ahead of UTC.
 *  Uses the Intl tz database bundled with Node — no external dependency. */
function zoneOffsetMs(instant: number, dtf: Intl.DateTimeFormat): number {
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(instant)))
    if (p.type !== "literal") f[p.type] = Number(p.value);
  // 'hour' can come back as 24 at midnight under h23; normalise to 0.
  const hour = f.hour === 24 ? 0 : f.hour;
  const asZone = Date.UTC(f.year, f.month - 1, f.day, hour, f.minute, f.second);
  return asZone - instant;
}

/** Convert a wall-clock time in an IANA zone (e.g. from DTSTART;TZID=…) to the correct
 *  UTC instant. Returns null if the zone name isn't recognised, so the caller can fall
 *  back to floating/local interpretation. Two-pass so DST transitions resolve exactly. */
function zonedWallClockToUtc(
  y: number,
  mo: number,
  da: number,
  hh: number,
  mm: number,
  ss: number,
  tz: string,
): Date | null {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null; // not a valid IANA zone
  }
  const guess = Date.UTC(y, mo - 1, da, hh, mm, ss);
  const off1 = zoneOffsetMs(guess, dtf);
  let utc = guess - off1;
  const off2 = zoneOffsetMs(utc, dtf); // re-evaluate across a possible DST edge
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

/** Parse an iCal DATE / DATE-TIME value into a Carbon ISO string + all-day flag. `tz` is
 *  the item owner's IANA zone, used to anchor values that carry no zone of their own
 *  (all-day dates and floating times); null falls back to the server's local clock. */
function parseICalDateTime(
  value: string,
  params: Record<string, string>,
  tz?: string | null,
): { iso: string; allDay: boolean } | null {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (params.VALUE === "DATE" || dateOnly) {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const da = Number(m[3]);
    // All-day → Carbon's "local 23:59" marker, anchored to the owner's zone so the stored
    // instant lands on the right calendar day for that user. Server-local only as fallback.
    if (tz) {
      const d = zonedWallClockToUtc(y, mo, da, 23, 59, 0, tz);
      if (d) return { iso: d.toISOString(), allDay: true };
    }
    const d = new Date(y, mo - 1, da, 23, 59, 0, 0);
    return { iso: d.toISOString(), allDay: true };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!dt) return null;
  const [, y, mo, da, hh, mm, ss, z] = dt;
  if (z === "Z") {
    return {
      iso: new Date(Date.UTC(+y, +mo - 1, +da, +hh, +mm, +ss)).toISOString(),
      allDay: false,
    };
  }
  // TZID present → resolve it against the IANA tz database for an exact instant.
  if (params.TZID) {
    const d = zonedWallClockToUtc(+y, +mo, +da, +hh, +mm, +ss, params.TZID);
    if (d) return { iso: d.toISOString(), allDay: false };
  }
  // Floating time (or an unrecognised TZID): interpret as wall-clock in the owner's zone,
  // falling back to the server's local clock when no owner zone is known.
  if (tz) {
    const d = zonedWallClockToUtc(+y, +mo, +da, +hh, +mm, +ss, tz);
    if (d) return { iso: d.toISOString(), allDay: false };
  }
  return {
    iso: new Date(+y, +mo - 1, +da, +hh, +mm, +ss).toISOString(),
    allDay: false,
  };
}

// ----- TEXT (de)escaping + line folding -------------------------------------

function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) =>
    c === "n" || c === "N" ? "\n" : c,
  );
}

/** Fold a content line to ≤75 octets per RFC 5545 (approximate, char-based). */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const out: string[] = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    out.push(" " + rest.slice(0, 72));
    rest = rest.slice(72);
  }
  if (rest.length) out.push(" " + rest);
  return out.join("\r\n");
}

function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | null {
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const segs = head.split(";");
  const name = segs[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let k = 1; k < segs.length; k++) {
    const eq = segs[k].indexOf("=");
    if (eq === -1) continue;
    params[segs[k].slice(0, eq).toUpperCase()] = segs[k]
      .slice(eq + 1)
      .replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** Every component block of a type in a (possibly multi-component) calendar.
 *  CalDAV resources hold one component; a subscribed iCal feed packs many. */
function extractAllComponents(
  ics: string,
  comp: "VTODO" | "VEVENT",
): Prop[][] {
  const lines = unfold(ics).split(/\r?\n/);
  const blocks: Prop[][] = [];
  let cur: Prop[] | null = null;
  for (const line of lines) {
    if (line === `BEGIN:${comp}`) {
      cur = [];
      continue;
    }
    if (line === `END:${comp}`) {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (cur && line) {
      const p = parseLine(line);
      if (p) cur.push(p);
    }
  }
  return blocks;
}

/** First component of a type (CalDAV's one-resource-one-component case). */
function extractComponent(
  ics: string,
  comp: "VTODO" | "VEVENT",
): Prop[] | null {
  return extractAllComponents(ics, comp)[0] ?? null;
}

function getProp(props: Prop[], name: string): Prop | undefined {
  return props.find((p) => p.name === name);
}

/** Which component a fetched resource carries (a collection may mix types). */
export function detectKind(ics: string): "todo" | "event" | null {
  if (/(^|\n)BEGIN:VTODO/.test(ics)) return "todo";
  if (/(^|\n)BEGIN:VEVENT/.test(ics)) return "event";
  return null;
}

// ----- priority maps --------------------------------------------------------

/** Carbon priority (0 none,1 low,2 med,3 high) → iCal PRIORITY (0,9,5,1). */
export function carbonToIcalPriority(p: number): number {
  return p === 3 ? 1 : p === 2 ? 5 : p === 1 ? 9 : 0;
}

/** iCal PRIORITY (0 none, 1–4 high, 5 med, 6–9 low) → Carbon priority. */
export function icalToCarbonPriority(p: number): number {
  if (!p || p <= 0) return 0;
  if (p <= 4) return 3;
  if (p === 5) return 2;
  return 1;
}

// ----- recurrence (outbound only) -------------------------------------------

function recurrenceToRrule(json: string | null): string | null {
  const r = parseRecurrence(json);
  if (!r) return null;
  const freq = {
    daily: "DAILY",
    weekly: "WEEKLY",
    monthly: "MONTHLY",
    yearly: "YEARLY",
  }[r.type];
  if (!freq) return null;
  const parts = [`FREQ=${freq}`, `INTERVAL=${Math.max(1, r.interval)}`];
  if (r.type === "weekly" && r.daysOfWeek?.length) {
    const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    parts.push(
      "BYDAY=" +
        r.daysOfWeek
          .map((d) => days[d])
          .filter(Boolean)
          .join(","),
    );
  }
  if (r.type === "monthly" && r.dayOfMonth)
    parts.push(`BYMONTHDAY=${r.dayOfMonth}`);
  return parts.join(";");
}

// ----- encode: Item → iCalendar ---------------------------------------------

function wrapVCalendar(component: string[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    ...component,
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

function dateProp(name: string, iso: string, tz?: string | null): string {
  return isAllDay(iso, tz)
    ? `${name};VALUE=DATE:${toICalDate(iso, tz)}`
    : `${name}:${toICalUTC(iso)}`;
}

export function itemToVtodo(item: Item, uid: string, tz?: string | null): string {
  const L: string[] = [
    "BEGIN:VTODO",
    `UID:${uid}`,
    `DTSTAMP:${toICalUTC(item.updated_at)}`,
  ];
  L.push(`SUMMARY:${escapeText(item.title || "")}`);
  if (item.note) L.push(`DESCRIPTION:${escapeText(item.note)}`);
  if (item.due_date) L.push(dateProp("DUE", item.due_date, tz));
  if (item.defer_date) L.push(dateProp("DTSTART", item.defer_date, tz));
  const prio = carbonToIcalPriority(item.priority);
  if (prio) L.push(`PRIORITY:${prio}`);
  if (item.status === "done") {
    L.push("STATUS:COMPLETED", "PERCENT-COMPLETE:100");
    if (item.completed_at) L.push(`COMPLETED:${toICalUTC(item.completed_at)}`);
  } else {
    L.push("STATUS:NEEDS-ACTION");
  }
  const rrule = recurrenceToRrule(item.recurrence);
  if (rrule) L.push(`RRULE:${rrule}`);
  L.push("END:VTODO");
  return wrapVCalendar(L);
}

/** Encode a dated task as a VEVENT. Caller must ensure `item.due_date` is set. */
export function itemToVevent(
  item: Item,
  uid: string,
  defaultMinutes: number,
  tz?: string | null,
): string {
  const due = item.due_date as string;
  const allDay = isAllDay(due, tz);
  const L: string[] = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toICalUTC(item.updated_at)}`,
  ];
  L.push(`SUMMARY:${escapeText(item.title || "")}`);
  if (item.note) L.push(`DESCRIPTION:${escapeText(item.note)}`);
  if (allDay) {
    const startYmd = toICalDate(due, tz); // owner-zone calendar day
    L.push(`DTSTART;VALUE=DATE:${startYmd}`);
    // DTEND is exclusive for all-day; compute the next day from the owner-zone date, not
    // via server-local setDate (which could roll to the wrong day near the zone boundary).
    L.push(`DTEND;VALUE=DATE:${nextIcalDate(startYmd)}`);
  } else {
    L.push(`DTSTART:${toICalUTC(due)}`);
    const mins =
      item.estimate_minutes && item.estimate_minutes > 0
        ? item.estimate_minutes
        : defaultMinutes;
    L.push(
      `DTEND:${toICalUTC(new Date(new Date(due).getTime() + mins * 60000).toISOString())}`,
    );
  }
  const rrule = recurrenceToRrule(item.recurrence);
  if (rrule) L.push(`RRULE:${rrule}`);
  L.push("END:VEVENT");
  return wrapVCalendar(L);
}

// ----- decode: iCalendar → Item patch ---------------------------------------

export interface ParsedTodo {
  uid: string | null;
  title: string;
  patch: ItemPatch;
  completed: boolean;
}

function mapVtodo(props: Prop[], tz?: string | null): ParsedTodo {
  const uid = getProp(props, "UID")?.value ?? null;
  const title = unescapeText(getProp(props, "SUMMARY")?.value ?? "");
  const descr = getProp(props, "DESCRIPTION");
  const due = getProp(props, "DUE");
  const start = getProp(props, "DTSTART");
  const prio = getProp(props, "PRIORITY");
  const status = getProp(props, "STATUS")?.value?.toUpperCase() ?? "";
  const percent = Number(getProp(props, "PERCENT-COMPLETE")?.value ?? "");

  const patch: ItemPatch = {
    title,
    note: descr ? unescapeText(descr.value) : null,
    due_date: due
      ? (parseICalDateTime(due.value, due.params, tz)?.iso ?? null)
      : null,
    defer_date: start
      ? (parseICalDateTime(start.value, start.params, tz)?.iso ?? null)
      : null,
    priority: prio ? icalToCarbonPriority(Number(prio.value)) : 0,
  };
  const completed = status === "COMPLETED" || percent === 100;
  return { uid, title, patch, completed };
}

export function vtodoToItemPatch(
  ics: string,
  tz?: string | null,
): ParsedTodo | null {
  const props = extractComponent(ics, "VTODO");
  return props ? mapVtodo(props, tz) : null;
}

/** Every VTODO in a (multi-component) calendar feed. */
export function parseAllVtodos(ics: string, tz?: string | null): ParsedTodo[] {
  return extractAllComponents(ics, "VTODO").map((p) => mapVtodo(p, tz));
}

export interface ParsedEvent {
  uid: string | null;
  title: string;
  patch: ItemPatch;
  /** Carries an RRULE (a recurring series). We don't import the rule itself, but a
   *  recurring event is "ongoing", so callers must not treat its past DTSTART as over. */
  recurs: boolean;
}

function mapVevent(props: Prop[], tz?: string | null): ParsedEvent {
  const uid = getProp(props, "UID")?.value ?? null;
  const title = unescapeText(getProp(props, "SUMMARY")?.value ?? "");
  const descr = getProp(props, "DESCRIPTION");
  const startP = getProp(props, "DTSTART");
  const endP = getProp(props, "DTEND");
  const start = startP
    ? parseICalDateTime(startP.value, startP.params, tz)
    : null;
  const end = endP ? parseICalDateTime(endP.value, endP.params, tz) : null;

  const patch: ItemPatch = {
    title,
    note: descr ? unescapeText(descr.value) : null,
    due_date: start?.iso ?? null,
  };
  // estimate = event duration (timed events only; all-day duration is meaningless here)
  if (start && end && !start.allDay) {
    const mins = Math.round(
      (new Date(end.iso).getTime() - new Date(start.iso).getTime()) / 60000,
    );
    if (mins > 0) patch.estimate_minutes = mins;
  }
  return { uid, title, patch, recurs: !!getProp(props, "RRULE") };
}

export function veventToItemPatch(
  ics: string,
  tz?: string | null,
): ParsedEvent | null {
  const props = extractComponent(ics, "VEVENT");
  return props ? mapVevent(props, tz) : null;
}

/** Every VEVENT in a (multi-component) calendar feed. */
export function parseAllVevents(
  ics: string,
  tz?: string | null,
): ParsedEvent[] {
  return extractAllComponents(ics, "VEVENT").map((p) => mapVevent(p, tz));
}

// ----- content hash (push diffing + echo suppression) -----------------------

/**
 * Stable hash of an item's *mapped* representation for a kind. Excludes the
 * volatile DTSTAMP/UID lines so it changes only when a synced field changes. Drives
 * the push side ("did the local item change since we last pushed it?"); echo
 * suppression on the pull side is handled by the stored ETag, not this hash.
 */
export function contentHash(
  kind: "todo" | "event",
  item: Item,
  defaultMinutes: number,
  tz?: string | null,
): string {
  const ics =
    kind === "todo"
      ? itemToVtodo(item, "x", tz)
      : itemToVevent(item, "x", defaultMinutes, tz);
  const stable = ics
    .split(/\r?\n/)
    .filter((l) => !/^(DTSTAMP|UID):/.test(l))
    .join("\n");
  return createHash("sha256").update(stable).digest("hex");
}
