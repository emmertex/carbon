// Native scheduled reminders (Capacitor only). Unlike the web foreground scanner
// in localReminders.ts, these are handed to the OS via @capacitor/local-notifications
// and fire even when the app is closed or killed — no server / FCM required.
//
// Strategy: whenever data changes (and periodically while open) we recompute the set
// of *future* reminder/due/defer times and reconcile it against what the OS already
// has pending — scheduling new ones and cancelling stale ones. Reusing a stable id
// per (task, kind) makes rescheduling idempotent.

import { allItems } from '@carbon/core';
import { getDb } from './db';

async function load() {
  try {
    return await import('@capacitor/local-notifications');
  } catch {
    return null;
  }
}

// Stable, non-zero 31-bit id from a string (Android notification ids must be ints).
function hashId(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2_000_000_000) + 1;
}

interface Pending {
  id: number;
  title: string;
  body: string;
  at: Date;
}

function collect(): Pending[] {
  const now = Date.now();
  const out: Pending[] = [];
  for (const i of allItems(getDb())) {
    if (i.type !== 'task' || i.status !== 'active' || i.deleted) continue;
    const body = i.title || 'Untitled task';
    const checks: Array<[string, string | null, string]> = [
      ['reminder', i.reminder_at, 'Reminder'],
      ['due', i.due_date, 'Task due'],
      ['defer', i.defer_date, 'Task now available'],
    ];
    for (const [kind, when, title] of checks) {
      if (!when) continue;
      const t = new Date(when).getTime();
      if (Number.isNaN(t) || t <= now) continue;
      out.push({ id: hashId(`${i.id}:${kind}`), title, body, at: new Date(t) });
    }
  }
  return out;
}

export async function nativeRemindersSupported(): Promise<boolean> {
  return !!(await load());
}

/** Request OS notification permission; resolves true if granted. */
export async function requestNativePermission(): Promise<boolean> {
  const mod = await load();
  if (!mod) return false;
  let perm = await mod.LocalNotifications.checkPermissions();
  if (perm.display !== 'granted') perm = await mod.LocalNotifications.requestPermissions();
  return perm.display === 'granted';
}

/** Reconcile the OS's pending notifications with the current set of future times. */
export async function syncNativeSchedule(): Promise<void> {
  const mod = await load();
  if (!mod) return;
  if ((await mod.LocalNotifications.checkPermissions()).display !== 'granted') return;

  const desired = collect();
  const desiredIds = new Set(desired.map((d) => d.id));

  const pending = await mod.LocalNotifications.getPending();
  const stale = pending.notifications.filter((n) => !desiredIds.has(n.id)).map((n) => ({ id: n.id }));
  if (stale.length) await mod.LocalNotifications.cancel({ notifications: stale });

  if (desired.length) {
    await mod.LocalNotifications.schedule({
      notifications: desired.map((d) => ({
        id: d.id,
        title: d.title,
        body: d.body,
        // allowWhileIdle so reminders survive Doze; smallIcon falls back to the app icon.
        schedule: { at: d.at, allowWhileIdle: true },
      })),
    });
  }
}

/** Drop every reminder we scheduled (used when the user turns reminders off). */
export async function cancelAllNative(): Promise<void> {
  const mod = await load();
  if (!mod) return;
  const pending = await mod.LocalNotifications.getPending();
  if (pending.notifications.length) {
    await mod.LocalNotifications.cancel({
      notifications: pending.notifications.map((n) => ({ id: n.id })),
    });
  }
}
