import { allItems, tasksAtLocation } from '@carbon/core';
import { getDb } from './db';
import { useStore } from './store';

// Foreground-only geofencing: the web Geolocation API only runs while the app is
// open. For reliable background geofencing, drive it from Home Assistant (which
// calls the server's /api/geo/event webhook on zone enter/leave).

let watchId: number | null = null;
const inside = new Set<string>(); // tasks we're currently within (avoid repeat alerts)
const PREF_KEY = 'carbon.geofence';

export function geofencingSupported(): boolean {
  return 'geolocation' in navigator;
}
export function geofencingActive(): boolean {
  return watchId !== null;
}
export function geofencePref(): boolean {
  return localStorage.getItem(PREF_KEY) === '1';
}

function notify(title: string): void {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Location reminder', { body: title, icon: '/icon-192.png' });
  }
}

export function startGeofencing(): boolean {
  if (!geofencingSupported()) return false;
  if (watchId !== null) return true;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const point = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const matches = tasksAtLocation(allItems(getDb()), point);
      const matchIds = new Set(matches.map((t) => t.id));
      for (const t of matches) {
        if (!inside.has(t.id)) {
          inside.add(t.id);
          notify(t.title || 'Task');
        }
      }
      // Forget tasks we've left, so re-entering alerts again.
      for (const id of [...inside]) if (!matchIds.has(id)) inside.delete(id);
    },
    (err) => {
      // Surface the failure instead of silently leaving the toggle "on" while nothing
      // fires (W6). Permission-denied is terminal, so turn the toggle back off.
      console.warn('[carbon] geolocation error', err.message);
      const denied = err.code === err.PERMISSION_DENIED;
      useStore.getState().showToast({
        message: denied
          ? 'Location permission denied — foreground geofencing is off.'
          : `Location error: ${err.message}`,
      });
      if (denied) stopGeofencing();
    },
    { enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 },
  );
  localStorage.setItem(PREF_KEY, '1');
  return true;
}

export function stopGeofencing(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  inside.clear();
  localStorage.removeItem(PREF_KEY);
}
