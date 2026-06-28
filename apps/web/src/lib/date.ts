import {
  format,
  isToday,
  isTomorrow,
  isYesterday,
  isThisYear,
  differenceInCalendarDays,
  addDays,
} from 'date-fns';

/** Parse to a Date, or null if invalid — keeps callers from ever throwing. */
function safeDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO of a constructed Date, or null if invalid (never throws). */
function safeIso(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A short, human label for a due/defer date. */
export function formatDay(iso: string | null): string {
  const d = safeDate(iso);
  if (!d) return '';
  if (isToday(d)) return 'Today';
  if (isTomorrow(d)) return 'Tomorrow';
  if (isYesterday(d)) return 'Yesterday';
  const days = differenceInCalendarDays(d, new Date());
  if (days > 1 && days < 7) return format(d, 'EEEE'); // weekday name
  return isThisYear(d) ? format(d, 'MMM d') : format(d, 'MMM d, yyyy');
}

/** <input type="date"> value (yyyy-MM-dd) for today + `n` days — drives the
 *  Today / Tomorrow / 3 Days / 1 Week scheduling shortcut buttons. */
export function dateInputOffset(n: number): string {
  return format(addDays(new Date(), n), 'yyyy-MM-dd');
}

/** Date-input value (yyyy-MM-dd) for `iso` shifted by `n` days (negative = earlier).
 *  Returns '' when `iso` is empty/invalid. Drives the defer "-1 day / -1 week" chips. */
export function dateInputShift(iso: string | null, n: number): string {
  const d = safeDate(iso);
  return d ? format(addDays(d, n), 'yyyy-MM-dd') : '';
}

/** Shift an ISO instant by `minutes` (negative = earlier), or null if invalid.
 *  Drives the reminder "15 min / 1 hour / 1 day before" chips. */
export function shiftMinutes(iso: string | null, minutes: number): string | null {
  const d = safeDate(iso);
  return d ? safeIso(new Date(d.getTime() + minutes * 60000)) : null;
}

/** Value for an <input type="date">, in local time. */
export function toDateInput(iso: string | null): string {
  const d = safeDate(iso);
  return d ? format(d, 'yyyy-MM-dd') : '';
}

/** Convert an <input type="date"> value to a stored ISO string (local midday).
 *  Returns null for empty or invalid (out-of-range) input. */
export function fromDateInput(value: string): string | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (![y, m, d].every((n) => Number.isFinite(n))) return null;
  return safeIso(new Date(y!, m! - 1, d!, 12, 0, 0));
}

// ----- due date as datetime (date + optional time) --------------------------
// A due with no specific time is stored at local end-of-day (23:59), which also
// acts as the "all-day" sentinel: the time field shows blank for it.

/** <input type="time"> value for a due datetime; '' when it's an all-day due. */
export function toTimeInput(iso: string | null): string {
  const d = safeDate(iso);
  if (!d) return '';
  if (d.getHours() === 23 && d.getMinutes() === 59) return '';
  return format(d, 'HH:mm');
}

/** Combine a date value (yyyy-mm-dd) and optional time (HH:mm) into a stored ISO.
 *  Returns null for empty or invalid input. */
export function combineDateTime(date: string, time: string): string | null {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  if (![y, m, d].every((n) => Number.isFinite(n))) return null;
  if (time) {
    const [hh, mm] = time.split(':').map(Number);
    if (![hh, mm].every((n) => Number.isFinite(n))) return null;
    return safeIso(new Date(y!, m! - 1, d!, hh!, mm!, 0));
  }
  return safeIso(new Date(y!, m! - 1, d!, 23, 59, 0));
}

/** True when a due datetime has no specific time (all-day / end of day). */
export function isAllDay(iso: string | null): boolean {
  const d = safeDate(iso);
  return !!d && d.getHours() === 23 && d.getMinutes() === 59;
}

/** Human label for a due date — adds the time when one is set. */
export function formatDue(iso: string | null): string {
  const d = safeDate(iso);
  if (!d) return '';
  return isAllDay(iso) ? formatDay(iso) : `${formatDay(iso)} ${format(d, 'h:mm a')}`;
}

/** ISO -> <input type="datetime-local"> value (local time, minute precision). */
export function toDateTimeInput(iso: string | null): string {
  const d = safeDate(iso);
  return d ? format(d, "yyyy-MM-dd'T'HH:mm") : '';
}

/** <input type="datetime-local"> value -> stored ISO string, or null if invalid. */
export function fromDateTimeInput(value: string): string | null {
  const d = safeDate(value);
  return d ? safeIso(d) : null;
}

/** Format a whole-minute estimate as "45m" or "1h 30m" / "2h". */
export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Format a millisecond duration as "1h 04m" or "12m 30s" or "45s". */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Elapsed/total duration of a time log (open logs run to now). */
export function logDuration(startISO: string, endISO: string | null): number {
  const start = safeDate(startISO);
  if (!start) return 0;
  const end = safeDate(endISO)?.getTime() ?? Date.now();
  return Math.max(0, end - start.getTime());
}
