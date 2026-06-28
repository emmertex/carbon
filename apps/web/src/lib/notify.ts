// Unified push/notification surface across the three shells. The UI calls these
// four functions; this module routes to the right backend for the host platform:
//
//   web        → Web Push (VAPID) via ./push  — server delivers when app is closed
//   capacitor  → FCM via @capacitor/push-notifications — server delivers via FCM
//   tauri      → OS-native notifications (foreground); server push is N/A in the
//                desktop webview, so "enable" just grants the native channel.
//
// The Capacitor/Tauri libraries are imported dynamically with @vite-ignore so the
// plain web build neither bundles nor requires them.

import { platform } from './platform';
import { getServerConfig, authHeaders } from './config';
import * as webPush from './push';

export interface PushResult {
  ok: boolean;
  message: string;
}

export interface NotifyProvider {
  kind: 'web' | 'fcm' | 'tauri';
  supported(): boolean;
  isEnabled(): Promise<boolean>;
  enable(): Promise<PushResult>;
  disable(): Promise<void>;
}

function serverUrl(path: string): string {
  return getServerConfig().url.replace(/\/$/, '') + path;
}

// ----- web (Web Push / VAPID) ----------------------------------------------

const webProvider: NotifyProvider = {
  kind: 'web',
  supported: webPush.pushSupported,
  isEnabled: webPush.isPushEnabled,
  enable: webPush.enablePush,
  disable: webPush.disablePush,
};

// ----- capacitor (FCM) ------------------------------------------------------

// Registers for FCM and hands the device token to the server, which sends through
// FCM instead of Web Push. Token is stored under carbon.fcmToken so disable() can
// tell the server to drop it.
const FCM_TOKEN_KEY = 'carbon.fcmToken';

// The plugin packages are bundled into the web build as lazy chunks (dynamic
// import) and only loaded when the host platform matches, so the browser PWA pays
// nothing for them and the native bridges are present when they are.
async function loadCapacitorPush() {
  try {
    return await import('@capacitor/push-notifications');
  } catch {
    return null;
  }
}

const fcmProvider: NotifyProvider = {
  kind: 'fcm',
  supported: () => true,
  async isEnabled() {
    return !!localStorage.getItem(FCM_TOKEN_KEY);
  },
  async enable() {
    const cfg = getServerConfig();
    if (!cfg.url) return { ok: false, message: 'Configure a sync server first' };
    const mod = await loadCapacitorPush();
    if (!mod) return { ok: false, message: 'Push module unavailable' };
    const { PushNotifications } = mod;

    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== 'granted' && perm.receive !== 'denied') {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== 'granted') return { ok: false, message: 'Notification permission denied' };

    // registration resolves with the FCM token asynchronously via an event.
    const token = await new Promise<string | null>((resolve) => {
      const to = setTimeout(() => resolve(null), 10_000);
      void PushNotifications.addListener('registration', (t: { value: string }) => {
        clearTimeout(to);
        resolve(t.value);
      });
      void PushNotifications.addListener('registrationError', () => {
        clearTimeout(to);
        resolve(null);
      });
      void PushNotifications.register();
    });
    if (!token) return { ok: false, message: 'Failed to obtain a device token' };

    const res = await fetch(serverUrl('/api/push/fcm'), {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return { ok: false, message: `Failed to register (${res.status})` };
    localStorage.setItem(FCM_TOKEN_KEY, token);
    return { ok: true, message: 'Reminders enabled on this device' };
  },
  async disable() {
    const token = localStorage.getItem(FCM_TOKEN_KEY);
    const cfg = getServerConfig();
    if (token && cfg.url) {
      await fetch(serverUrl('/api/push/fcm/unsubscribe'), {
        method: 'POST',
        headers: authHeaders(cfg),
        body: JSON.stringify({ token }),
      }).catch(() => {});
    }
    localStorage.removeItem(FCM_TOKEN_KEY);
  },
};

// ----- tauri (OS-native, foreground) ---------------------------------------

const TAURI_PREF_KEY = 'carbon.tauriNotify';

async function loadTauriNotification() {
  try {
    return await import('@tauri-apps/plugin-notification');
  } catch {
    return null;
  }
}

const tauriProvider: NotifyProvider = {
  kind: 'tauri',
  supported: () => true,
  async isEnabled() {
    return localStorage.getItem(TAURI_PREF_KEY) === '1';
  },
  async enable() {
    const mod = await loadTauriNotification();
    if (!mod) return { ok: false, message: 'Notification module unavailable' };
    let granted = await mod.isPermissionGranted();
    if (!granted) granted = (await mod.requestPermission()) === 'granted';
    if (!granted) return { ok: false, message: 'Notification permission denied' };
    localStorage.setItem(TAURI_PREF_KEY, '1');
    return { ok: true, message: 'Desktop notifications enabled' };
  },
  async disable() {
    localStorage.removeItem(TAURI_PREF_KEY);
  },
};

// ----- selection + public API ----------------------------------------------

export const provider: NotifyProvider =
  platform === 'tauri' ? tauriProvider : platform === 'capacitor' ? fcmProvider : webProvider;

export const pushSupported = (): boolean => provider.supported();
export const isPushEnabled = (): Promise<boolean> => provider.isEnabled();
export const enablePush = (): Promise<PushResult> => provider.enable();
export const disablePush = (): Promise<void> => provider.disable();

/** Whether the active channel delivers while the app is closed (server-driven). */
export const pushDeliversWhenClosed = (): boolean =>
  provider.kind === 'web' || provider.kind === 'fcm';

// Immediate native local notifications on Capacitor. Ids must be ints; a counter
// derived from the clock keeps them unique without collisions with scheduled ones.
let localNotifSeq = Date.now() % 1_000_000;
async function loadCapacitorLocalNotifications() {
  try {
    return await import('@capacitor/local-notifications');
  } catch {
    return null;
  }
}

/** Show a notification locally on this device (used by foreground reminders). */
export async function showLocalNotification(p: {
  title: string;
  body: string;
  tag?: string;
}): Promise<void> {
  if (platform === 'tauri') {
    const mod = await loadTauriNotification();
    if (mod && (await mod.isPermissionGranted())) {
      mod.sendNotification({ title: p.title, body: p.body });
      return;
    }
  }
  if (platform === 'capacitor') {
    const mod = await loadCapacitorLocalNotifications();
    if (mod && (await mod.LocalNotifications.checkPermissions()).display === 'granted') {
      localNotifSeq = (localNotifSeq + 1) % 2_000_000_000;
      await mod.LocalNotifications.schedule({
        notifications: [{ id: localNotifSeq + 1, title: p.title, body: p.body }],
      });
      return;
    }
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(p.title, { body: p.body, tag: p.tag });
  }
}
