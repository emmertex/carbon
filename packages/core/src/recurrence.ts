import type { Item, RecurrenceRule } from './types';

export function parseRecurrence(json: string | null): RecurrenceRule | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as RecurrenceRule;
    if (!r || typeof r.interval !== 'number') return null;
    return r;
  } catch {
    return null;
  }
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * Given a recurrence rule and the date to count from (either the previous due
 * date or the completion date, depending on rule.fromCompletion), return the
 * next occurrence's date, or null if the rule is exhausted/invalid.
 */
export function nextOccurrence(rule: RecurrenceRule, from: Date): Date | null {
  const interval = Math.max(1, rule.interval);
  switch (rule.type) {
    case 'daily':
      return addDays(from, interval);
    case 'weekly': {
      if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
        // Next matching weekday after `from`, but honour `interval`: for "every N
        // weeks" only weeks that are a multiple of N from `from`'s week count. With
        // interval=1 this is just the next matching weekday (unchanged) (C3).
        const weekStart = (d: Date): number => {
          const x = new Date(d);
          x.setHours(0, 0, 0, 0);
          x.setDate(x.getDate() - x.getDay());
          return x.getTime();
        };
        const anchor = weekStart(from);
        for (let i = 1; i <= 7 * interval + 7; i++) {
          const cand = addDays(from, i);
          if (!rule.daysOfWeek.includes(cand.getDay())) continue;
          const weeks = Math.round((weekStart(cand) - anchor) / (7 * 86_400_000));
          if (weeks % interval === 0) return cand;
        }
        return addDays(from, 7 * interval);
      }
      return addDays(from, 7 * interval);
    }
    case 'monthly': {
      // Advance the month from day 1 first, THEN clamp the target day to the new
      // month's real length. Setting the month while the date is e.g. the 31st
      // overflows (Jan 31 + 1mo → Mar 3), skipping a month and drifting the series.
      const x = new Date(from);
      const dom = rule.dayOfMonth ?? from.getDate();
      x.setDate(1);
      x.setMonth(x.getMonth() + interval);
      const lastDay = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
      x.setDate(Math.min(dom, lastDay));
      return x;
    }
    case 'yearly': {
      // Same overflow guard: Feb 29 + 1yr would roll to Mar 1 and never return to
      // February. Clamp the day to the target month's length (Feb 29 → Feb 28).
      const x = new Date(from);
      const dom = from.getDate();
      x.setDate(1);
      x.setFullYear(x.getFullYear() + interval);
      const lastDay = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
      x.setDate(Math.min(dom, lastDay));
      return x;
    }
    default:
      return null;
  }
}

/** The effective recurrence anchor, tolerating the legacy `fromCompletion` flag. */
export function repeatBasis(
  rule: RecurrenceRule,
): 'scheduled' | 'completed' | 'completed-keep-time' {
  if (rule.from) return rule.from;
  return rule.fromCompletion ? 'completed' : 'scheduled';
}

/** Compute the next due date for a recurring item being completed `at`. */
export function nextDueDate(item: Item, at: Date): string | null {
  const rule = parseRecurrence(item.recurrence);
  if (!rule) return null;
  const basis = repeatBasis(rule);
  let base: Date;
  if (basis === 'completed') {
    base = at;
  } else if (basis === 'completed-keep-time') {
    // Count the interval from the completion *date*, but keep the originally
    // scheduled clock time so the new alarm/defer/due fire at their planned
    // time-of-day rather than whenever the task happened to be checked off.
    base = new Date(at);
    if (item.due_date) {
      const due = new Date(item.due_date);
      base.setHours(due.getHours(), due.getMinutes(), due.getSeconds(), due.getMilliseconds());
    }
  } else {
    base = item.due_date ? new Date(item.due_date) : at;
  }
  let next = nextOccurrence(rule, base);
  if (!next) return null;
  // For due-date-anchored recurrence, a long-overdue task would otherwise spawn
  // another occurrence still in the past (complete a daily chore 30 days late →
  // "next" is 29 days ago). Advance to the first occurrence after `at`, like
  // OmniFocus. Capped so a degenerate rule can't loop forever.
  if (basis === 'scheduled') {
    let guard = 0;
    while (next <= at && guard++ < 1000) {
      const after = nextOccurrence(rule, next);
      if (!after || after.getTime() === next.getTime()) break;
      next = after;
    }
  }
  return next.toISOString();
}
