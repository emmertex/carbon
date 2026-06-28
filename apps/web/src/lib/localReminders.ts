import { allItems } from '@carbon/core';
import { getDb } from './db';
import { getServerConfig } from './config';
import { useStore } from './store';

// Foreground local reminders: when the server isn't pushing for us (no server, or
// not signed in), scan due / reminder / defer times while the app is open and fire
// a local notification. Works without any server — like geofencing, foreground only.

const PREF_KEY = 'carbon.localreminders';
const SENT_KEY = 'carbon.localreminders.sent';
let timer: ReturnType<typeof setInterval> | null = null;

export function localRemindersSupported(): boolean {
  return typeof Notification !== 'undefined';
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

/** Start scanning (call after Notification permission is granted). */
export function startLocalReminders(): void {
  localStorage.setItem(PREF_KEY, '1');
  if (timer) return;
  void scan();
  timer = setInterval(() => void scan(), 60_000);
}

export function stopLocalReminders(): void {
  localStorage.removeItem(PREF_KEY);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
