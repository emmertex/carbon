import { allItems, tasksAtLocation } from '@carbon/core';
import { getDb } from './db';
import { useStore } from './store';
import { watchPosition, geolocationSupported, type PositionWatch } from './location';
import { showLocalNotification } from './notify';

// Foreground-only geofencing: the device Geolocation watch only runs while the app
// is open (via @capacitor/geolocation natively, or the browser API on the web). For
// reliable background geofencing, drive it from Home Assistant (which calls the
// server's /api/geo/event webhook on zone enter/leave).

let watch: PositionWatch | null = null;
let starting = false;
const inside = new Set<string>(); // tasks we're currently within (avoid repeat alerts)
const PREF_KEY = 'carbon.geofence';

export function geofencingSupported(): boolean {
  return geolocationSupported();
}
export function geofencePref(): boolean {
  return localStorage.getItem(PREF_KEY) === '1';
}

export async function startGeofencing(): Promise<boolean> {
  if (!geofencingSupported()) return false;
  if (watch !== null || starting) return true;
  starting = true;
  localStorage.setItem(PREF_KEY, '1');
  watch = await watchPosition(
    (point) => {
      const matches = tasksAtLocation(allItems(getDb()), point);
      const matchIds = new Set(matches.map((t) => t.id));
      for (const t of matches) {
        if (!inside.has(t.id)) {
          inside.add(t.id);
          void showLocalNotification({ title: 'Location reminder', body: t.title || 'Task' });
        }
      }
      // Forget tasks we've left, so re-entering alerts again.
      for (const id of [...inside]) if (!matchIds.has(id)) inside.delete(id);
    },
    (message, denied) => {
      // Surface the failure instead of silently leaving the toggle "on" while nothing
      // fires (W6). Permission-denied is terminal, so turn the toggle back off.
      console.warn('[carbon] geolocation error', message);
      useStore.getState().showToast({
        message: denied
          ? 'Location permission denied — foreground geofencing is off.'
          : `Location error: ${message}`,
      });
      if (denied) stopGeofencing();
    },
  );
  starting = false;
  if (watch === null) {
    localStorage.removeItem(PREF_KEY);
    return false;
  }
  return true;
}

export function stopGeofencing(): void {
  if (watch !== null) {
    watch.clear();
    watch = null;
  }
  inside.clear();
  localStorage.removeItem(PREF_KEY);
}
