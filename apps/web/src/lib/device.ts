// Per-device identity for the multi-device location feature. Distinct from the CRDT
// sync device id in db.ts (that one identifies the local DB replica); this one labels
// *this install/browser* as a location source the user can see, name, and remove.

import { isCapacitor } from './platform';

const ID_KEY = 'carbon.device.id';
const NAME_KEY = 'carbon.device.name'; // user-set override
const NATIVE_NAME_KEY = 'carbon.device.nativeName'; // cached native/auto name

/** A v4 UUID, falling back when `crypto.randomUUID` is unavailable — it only exists in
 *  secure contexts, and this PWA may be served over plain HTTP on a LAN. */
function newId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* insecure context — fall through to a manual UUID */
    }
  }
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/** Stable id for this browser/install (generated once, persisted). */
export function getDeviceId(): string {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = newId();
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

/** Rotate the id — the old device row goes stale and ages out server-side. */
export function regenerateDeviceId(): string {
  const id = newId();
  localStorage.setItem(ID_KEY, id);
  return id;
}

/** A friendly fallback label from UA hints (web/desktop). */
function uaFallback(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /Edg/.test(ua)
    ? 'Edge'
    : /Chrome/.test(ua)
      ? 'Chrome'
      : /Firefox/.test(ua)
        ? 'Firefox'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${os} · ${browser}` : browser;
}

/** Best-known name right now (sync): user override → cached native → UA fallback. */
export function getDeviceName(): string {
  return localStorage.getItem(NAME_KEY) || localStorage.getItem(NATIVE_NAME_KEY) || uaFallback();
}

/** True when the user has set their own name (vs an auto/native one). */
export function hasUserDeviceName(): boolean {
  return !!localStorage.getItem(NAME_KEY);
}

/** Set (or clear, with null) the user's chosen device name. */
export function setDeviceName(name: string | null): void {
  const n = name?.trim();
  if (n) localStorage.setItem(NAME_KEY, n);
  else localStorage.removeItem(NAME_KEY);
}

// Loaded lazily so the plain web build neither bundles nor requires the plugin.
async function loadCapacitorDevice() {
  try {
    return await import('@capacitor/device');
  } catch {
    return null;
  }
}

/**
 * Resolve and cache the native device name (Capacitor only). Call once on startup; it
 * updates the value `getDeviceName()` returns when the user hasn't set their own.
 */
export async function resolveDeviceName(): Promise<void> {
  if (!isCapacitor) return;
  const mod = await loadCapacitorDevice();
  if (!mod) return;
  try {
    const info = await mod.Device.getInfo();
    const name = info.name || info.model;
    if (name) localStorage.setItem(NATIVE_NAME_KEY, name);
  } catch {
    /* ignore — fall back to UA label */
  }
}
