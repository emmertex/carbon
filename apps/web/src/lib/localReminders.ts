import { allItems } from '@carbon/core';
import { getDb } from './db';
import { getServerConfig } from './config';
import { useStore } from './store';
import { isCapacitor } from './platform';
import { requestNativePermission, syncNativeSchedule, cancelAllNative } from './nativeReminders';

// Local reminders: when the server isn't pushing for us (no server, or not signed
// in), fire reminder / due / defer alerts on this device.
//
//   web/desktop  → foreground scan: while the app is open, an interval checks for
//                  newly-passed times and shows a notification.
//   capacitor    → native OS scheduling via @capacitor/local-notifications, so the
//                  reminders fire even when the app is closed (see nativeReminders.ts).
//                  The interval just re-reconciles the schedule with current data.

const PREF_KEY = 'carbon.localreminders';
const SENT_KEY = 'carbon.localreminders.sent';
let timer: ReturnType<typeof setInterval> | null = null;

export function localRemindersSupported(): boolean {
  return isCapacitor || typeof Notification !== 'undefined';
}
export function localRemindersPref(): boolean {
  return localStorage.getItem(PREF_KEY) === '1';
}
export function localRemindersActive(): boolean {
  return timer !== null;
}

/** True when the server is handling reminders for us (so local would duplicate). */
function pushActive(): boolean {
  const user = useStore.getState().currentUser;
  return !!getServerConfig().url && !!user && !user.open;
}

function sentMarkers(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SENT_KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}
function markSent(markers: Set<string>): void {
  // Keep the list bounded so it can't grow forever.
  const arr = [...markers].slice(-500);
  localStorage.setItem(SENT_KEY, JSON.stringify(arr));
}

async function notify(title: string, body: string, tag: string): Promise<void> {
  if (Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  const opts = { body, icon: '/icon-192.png', tag } as NotificationOptions;
  if (reg) await reg.showNotification(title, opts);
  else new Notification(title, opts);
}

async function scan(): Promise<void> {
  if (pushActive() || Notification.permission !== 'granted') return;
  const nowIso = new Date().toISOString();
  const markers = sentMarkers();
  let changed = false;
  for (const i of allItems(getDb())) {
    if (i.type !== 'task' || i.status !== 'active' || i.deleted) continue;
    const checks: Array<[string, string | null, string, string]> = [
      ['reminder', i.reminder_at, 'Reminder', i.title || 'Untitled task'],
      ['due', i.due_date, 'Task due', i.title || 'Untitled task'],
      ['defer', i.defer_date, 'Task now available', i.title || 'Untitled task'],
    ];
    for (const [kind, when, title, body] of checks) {
      if (!when || when > nowIso) continue;
      const marker = `${i.id}:${kind}:${when}`;
      if (markers.has(marker)) continue;
      markers.add(marker);
      changed = true;
      void notify(title, body, marker);
    }
  }
  if (changed) markSent(markers);
}

/**
 * Enable local reminders on this device. On web/desktop the caller is expected to
 * have already granted Notification permission; on Capacitor we request the native
 * permission ourselves. Resolves false if a needed permission was denied.
 */
export async function startLocalReminders(): Promise<boolean> {
  localStorage.setItem(PREF_KEY, '1');
  if (isCapacitor) {
    if (!(await requestNativePermission())) {
      localStorage.removeItem(PREF_KEY);
      return false;
    }
    await syncNativeSchedule();
    // Re-reconcile periodically so edits made while the app is open are picked up.
    if (!timer) timer = setInterval(() => void syncNativeSchedule(), 300_000);
    return true;
  }
  if (!timer) {
    void scan();
    timer = setInterval(() => void scan(), 60_000);
  }
  return true;
}

export function stopLocalReminders(): void {
  localStorage.removeItem(PREF_KEY);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (isCapacitor) void cancelAllNative();
}

/** Re-reconcile the native schedule now (call after data sync on Capacitor). */
export function refreshLocalReminders(): void {
  if (isCapacitor && localRemindersPref()) void syncNativeSchedule();
}
