import { getServerConfig, authHeaders } from './config';

function url(path: string): string {
  return getServerConfig().url.replace(/\/$/, '') + path;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function isPushEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}

export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  if (!pushSupported()) return { ok: false, message: 'Notifications not supported here' };
  const cfg = getServerConfig();
  if (!cfg.url) return { ok: false, message: 'Configure a sync server first' };
  if ((await Notification.requestPermission()) !== 'granted') {
    return { ok: false, message: 'Notification permission denied' };
  }
  const reg = await navigator.serviceWorker.ready;
  const vapid = await fetch(url('/api/push/vapid'), { headers: authHeaders(cfg) }).then((r) =>
    r.text(),
  );
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid) as BufferSource,
    });
  }
  const res = await fetch(url('/api/push/subscribe'), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify(sub),
  });
  return res.ok
    ? { ok: true, message: 'Reminders enabled on this device' }
    : { ok: false, message: `Failed to register (${res.status})` };
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const cfg = getServerConfig();
  if (cfg.url) {
    // If the server-side unsubscribe fails, leave the browser subscription in
    // place so a later retry can still tell the server to drop it, instead of
    // clearing the only record of a subscription the server thinks is live.
    const ok = await fetch(url('/api/push/unsubscribe'), {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    })
      .then((res) => res.ok)
      .catch((e) => {
        console.warn('[carbon] WebPush unsubscribe request failed:', e);
        return false;
      });
    if (!ok) return;
  }
  await sub.unsubscribe();
}
