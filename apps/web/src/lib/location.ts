// Native-aware geolocation. Uses the phone's sensors via @capacitor/geolocation
// when running inside the Android/iOS shell (proper runtime permission prompts +
// native location services), and falls back to the browser Geolocation API for the
// plain web PWA and desktop. Both are *foreground* only — see geo.ts / where.ts for
// how the results are consumed, and the server's HA webhook path for background.

import { isCapacitor } from './platform';

export interface GeoPoint {
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres, when the source reports it. */
  accuracy?: number;
}

// Loaded lazily so the plain web build neither bundles nor requires the plugin.
async function loadCapacitorGeo() {
  try {
    return await import('@capacitor/geolocation');
  } catch {
    return null;
  }
}

export function geolocationSupported(): boolean {
  return isCapacitor || (typeof navigator !== 'undefined' && 'geolocation' in navigator);
}

/** Ensure location permission on Capacitor; resolves true if usable. */
async function ensureNativePermission(
  mod: Awaited<ReturnType<typeof loadCapacitorGeo>>,
): Promise<boolean> {
  if (!mod) return false;
  let perm = await mod.Geolocation.checkPermissions();
  if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
    perm = await mod.Geolocation.requestPermissions();
  }
  return perm.location === 'granted' || perm.coarseLocation === 'granted';
}

interface PosOptions {
  highAccuracy?: boolean;
  timeout?: number;
  /** Accept a cached fix up to this many ms old (web only). */
  maximumAge?: number;
}

/** One-shot current position, or null if unavailable / denied. Never throws. */
export async function getCurrentPosition(opts: PosOptions = {}): Promise<GeoPoint | null> {
  const highAccuracy = opts.highAccuracy ?? true;
  const timeout = opts.timeout ?? 60_000;
  if (isCapacitor) {
    const mod = await loadCapacitorGeo();
    if (mod) {
      try {
        if (!(await ensureNativePermission(mod))) return null;
        const pos = await mod.Geolocation.getCurrentPosition({
          enableHighAccuracy: highAccuracy,
          timeout,
        });
        return {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
      } catch {
        return null;
      }
    }
  }
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: highAccuracy, timeout, maximumAge: opts.maximumAge ?? 30_000 },
    );
  });
}

/** Handle returned by watchPosition; call clear() to stop the watch. */
export interface PositionWatch {
  clear(): void;
}

/**
 * Continuous position watch. Routes to the native plugin on Capacitor, else the
 * browser API. Returns null if geolocation is unavailable or permission denied.
 * onError reports the message and whether the failure is a (terminal) permission
 * denial so callers can flip a toggle back off.
 */
export async function watchPosition(
  onPosition: (p: GeoPoint) => void,
  onError?: (message: string, denied: boolean) => void,
): Promise<PositionWatch | null> {
  if (isCapacitor) {
    const mod = await loadCapacitorGeo();
    if (mod) {
      if (!(await ensureNativePermission(mod))) {
        onError?.('Location permission denied', true);
        return null;
      }
      const id = await mod.Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: 60_000 },
        (pos, err) => {
          if (err) {
            onError?.(err.message ?? 'Location error', /denied|permission/i.test(err.message ?? ''));
            return;
          }
          if (pos)
            onPosition({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            });
        },
      );
      return { clear: () => void mod.Geolocation.clearWatch({ id }) };
    }
  }
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    onError?.('Geolocation unsupported', false);
    return null;
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
    (err) => onError?.(err.message, err.code === err.PERMISSION_DENIED),
    { enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 },
  );
  return { clear: () => navigator.geolocation.clearWatch(id) };
}
