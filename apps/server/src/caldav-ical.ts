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
//  - Non-UTC DTSTART/DUE with a TZID are interpreted as local wall-clock time (we
//    don't carry a full tz database); UTC ("Z") and all-day (VALUE=DATE) are exact.

const PRODID = "-//Carbon//CalDAV Connector//EN";

const pad = (n: number, l = 2): string => String(n).padStart(l, "0");

/** Carbon stores an all-day defer/due at the local 23:59 marker (see core repo). */
function isAllDay(iso: string): boolean {
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

/** Local calendar date for an all-day value (the 23:59 marker is local). */
function toICalDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Parse an iCal DATE / DATE-TIME value into a Carbon ISO string + all-day flag. */
function parseICalDateTime(
  value: string,
  params: Record<string, string>,
): { iso: string; allDay: boolean } | null {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (params.VALUE === "DATE" || dateOnly) {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    // Represent an all-day date at the local 23:59 marker Carbon uses.
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      23,
      59,
      0,
      0,
    );
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
  // Floating time or an (unresolved) TZID: interpret as local wall-clock time.
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

function extractComponent(
  ics: string,
  comp: "VTODO" | "VEVENT",
): Prop[] | null {
  const lines = unfold(ics).split(/\r?\n/);
  let found = false;
  let inside = false;
  const props: Prop[] = [];
  for (const line of lines) {
    if (line === `BEGIN:${comp}`) {
      found = true;
      inside = true;
      continue;
    }
    if (line === `END:${comp}`) break;
    if (inside && line) {
      const p = parseLine(line);
      if (p) props.push(p);
    }
  }
  return found ? props : null;
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

function dateProp(name: string, iso: string): string {
  return isAllDay(iso)
    ? `${name};VALUE=DATE:${toICalDate(iso)}`
    : `${name}:${toICalUTC(iso)}`;
}

export function itemToVtodo(item: Item, uid: string): string {
  const L: string[] = [
    "BEGIN:VTODO",
    `UID:${uid}`,
    `DTSTAMP:${toICalUTC(item.updated_at)}`,
  ];
  L.push(`SUMMARY:${escapeText(item.title || "")}`);
  if (item.note) L.push(`DESCRIPTION:${escapeText(item.note)}`);
  if (item.due_date) L.push(dateProp("DUE", item.due_date));
  if (item.defer_date) L.push(dateProp("DTSTART", item.defer_date));
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
): string {
  const due = item.due_date as string;
  const allDay = isAllDay(due);
  const L: string[] = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toICalUTC(item.updated_at)}`,
  ];
  L.push(`SUMMARY:${escapeText(item.title || "")}`);
  if (item.note) L.push(`DESCRIPTION:${escapeText(item.note)}`);
  if (allDay) {
    L.push(`DTSTART;VALUE=DATE:${toICalDate(due)}`);
    const next = new Date(due);
    next.setDate(next.getDate() + 1); // DTEND is exclusive for all-day
    L.push(`DTEND;VALUE=DATE:${toICalDate(next.toISOString())}`);
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

export function vtodoToItemPatch(ics: string): ParsedTodo | null {
  const props = extractComponent(ics, "VTODO");
  if (!props) return null;
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
      ? (parseICalDateTime(due.value, due.params)?.iso ?? null)
      : null,
    defer_date: start
      ? (parseICalDateTime(start.value, start.params)?.iso ?? null)
      : null,
    priority: prio ? icalToCarbonPriority(Number(prio.value)) : 0,
  };
  const completed = status === "COMPLETED" || percent === 100;
  return { uid, title, patch, completed };
}

export interface ParsedEvent {
  uid: string | null;
  title: string;
  patch: ItemPatch;
}

export function veventToItemPatch(ics: string): ParsedEvent | null {
  const props = extractComponent(ics, "VEVENT");
  if (!props) return null;
  const uid = getProp(props, "UID")?.value ?? null;
  const title = unescapeText(getProp(props, "SUMMARY")?.value ?? "");
  const descr = getProp(props, "DESCRIPTION");
  const startP = getProp(props, "DTSTART");
  const endP = getProp(props, "DTEND");
  const start = startP ? parseICalDateTime(startP.value, startP.params) : null;
  const end = endP ? parseICalDateTime(endP.value, endP.params) : null;

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
  return { uid, title, patch };
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
): string {
  const ics =
    kind === "todo"
      ? itemToVtodo(item, "x")
      : itemToVevent(item, "x", defaultMinutes);
  const stable = ics
    .split(/\r?\n/)
    .filter((l) => !/^(DTSTAMP|UID):/.test(l))
    .join("\n");
  return createHash("sha256").update(stable).digest("hex");
}
