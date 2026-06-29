import { getServerConfig, authHeaders } from './config';
import { useStore } from './store';
import { getCurrentPosition } from './location';

// Resolves "where the user currently is" by combining, in priority order:
//   1. Home Assistant zone (from the server, set by the zone enter/leave webhook)
//   2. GPS from Home Assistant (the server's latest device-tracker fix)
//   3. Native device GPS (navigator.geolocation), as a fallback / extra source
// Reverse-geocoding to a place name is best-effort and never blocks. Everything
// degrades gracefully when offline or when permission is denied.

/** A single GPS fix from one source, with metadata for the source icons. */
export interface GpsFix {
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres, when the source reports it. */
  accuracy: number | null;
  /** Epoch ms when this fix was recorded (server timestamp, or fetch time for device). */
  updatedAt: number;
}

/** The HA zone the user is currently in (event-driven: cleared on leave). */
export interface ZoneFix {
  name: string;
  updatedAt: number;
}

export interface WhereState {
  // --- Distinct sources, surfaced individually by the Nearby view ---
  /** Home Assistant zone (cleared on leave; not time-decayed). */
  haZone: ZoneFix | null;
  /** Home Assistant device-tracker GPS fix. */
  haGps: GpsFix | null;
  /** Native device GPS (navigator.geolocation / Capacitor). */
  deviceGps: GpsFix | null;

  // --- Merged convenience fields used for task matching + the sidebar gate ---
  /** Home Assistant zone name, if the server knows one. */
  zone: string | null;
  /** Best current GPS point (server HA fix, else native geolocation). */
  point: { lat: number; lng: number } | null;
  /** Reverse-geocoded place name for `point`, if resolved (best-effort). */
  place: string | null;
  /** True once at least one source has been consulted. */
  resolved: boolean;
}

const EMPTY: WhereState = {
  haZone: null,
  haGps: null,
  deviceGps: null,
  zone: null,
  point: null,
  place: null,
  resolved: false,
};

/** GPS fixes older than this are treated as stale and hidden from the source
 *  icons. Zones are event-driven (cleared on leave) and so are never time-decayed. */
export const GPS_STALE_MS = 30 * 60_000; // 30 min
export const isFixStale = (updatedAt: number): boolean => Date.now() - updatedAt > GPS_STALE_MS;

let state: WhereState = EMPTY;
const listeners = new Set<() => void>();
let started = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function emit(next: Partial<WhereState>): void {
  state = { ...state, ...next, resolved: true };
  for (const l of listeners) l();
}

export function getWhere(): WhereState {
  return state;
}

/** True when a server is configured and we're signed in as a real (non-open) user. */
function serverAvailable(): boolean {
  const user = useStore.getState().currentUser;
  return !!getServerConfig().url && !!user && !user.open;
}

interface ServerWhere {
  zone: { name: string; updatedAt: string } | null;
  haGps: { lat: number; lng: number; accuracy: number | null; updatedAt: string } | null;
}

async function fetchServerWhere(): Promise<{ haZone: ZoneFix | null; haGps: GpsFix | null } | null> {
  if (!serverAvailable()) return null;
  const cfg = getServerConfig();
  try {
    const res = await fetch(`${cfg.url}/api/where`, { headers: authHeaders(cfg) });
    if (!res.ok) return null;
    const body = (await res.json()) as ServerWhere;
    const haZone = body.zone
      ? { name: body.zone.name, updatedAt: Date.parse(body.zone.updatedAt) }
      : null;
    const haGps = body.haGps
      ? {
          lat: body.haGps.lat,
          lng: body.haGps.lng,
          accuracy: body.haGps.accuracy ?? null,
          updatedAt: Date.parse(body.haGps.updatedAt),
        }
      : null;
    return { haZone, haGps };
  } catch {
    return null; // offline / network error — degrade gracefully
  }
}

async function nativeFix(): Promise<GpsFix | null> {
  // Uses the phone's sensors via @capacitor/geolocation on native, browser API on
  // the web. Never throws to the UI. Stamped with fetch time (the device fix is
  // always "now").
  const p = await getCurrentPosition({ highAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
  return p ? { lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, updatedAt: Date.now() } : null;
}

interface NominatimAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  village?: string;
  town?: string;
  city?: string;
  municipality?: string;
  state?: string;
  postcode?: string;
}

/** Build a concise street-level label, e.g. "55 Named St, Michigan, NSW, 4000". */
function formatAddress(addr: NominatimAddress): string | null {
  const street = [addr.house_number, addr.road].filter(Boolean).join(' ');
  const locality =
    addr.suburb ?? addr.neighbourhood ?? addr.village ?? addr.town ?? addr.city ?? addr.municipality;
  const parts = [street, locality, addr.state, addr.postcode].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Best-effort reverse geocode via OpenStreetMap Nominatim (no key). Never blocks. */
async function reverseGeocode(point: { lat: number; lng: number }): Promise<string | null> {
  try {
    // zoom=18 resolves to building/street-number level; addressdetails gives the
    // structured fields we assemble into a short label instead of the verbose
    // display_name (or the bare POI `name`, which is often empty for a house).
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&addressdetails=1&lat=${point.lat}&lon=${point.lng}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      name?: string;
      display_name?: string;
      address?: NominatimAddress;
    };
    return (body.address && formatAddress(body.address)) || body.name || body.display_name || null;
  } catch {
    return null;
  }
}

/** Recompute the merged convenience fields (zone/point) from the three sources.
 *  Server HA GPS wins over the native device fix; the zone drives task matching. */
function merge(sources: Pick<WhereState, 'haZone' | 'haGps' | 'deviceGps'>): Partial<WhereState> {
  // HA GPS still wins over the native fix, but only while it's fresh: a stale HA
  // device-tracker fix must not override a live device position (it would put the
  // merged point — and the reverse-geocoded place + task matching — somewhere the
  // user no longer is). Same staleness window as the source icons.
  const haGps = sources.haGps && !isFixStale(sources.haGps.updatedAt) ? sources.haGps : null;
  const deviceGps =
    sources.deviceGps && !isFixStale(sources.deviceGps.updatedAt) ? sources.deviceGps : null;
  const gps = haGps ?? deviceGps;
  return {
    ...sources,
    zone: sources.haZone?.name ?? null,
    point: gps ? { lat: gps.lat, lng: gps.lng } : null,
  };
}

async function resolve(): Promise<void> {
  const server = await fetchServerWhere();
  const haZone = server?.haZone ?? null;
  const haGps = server?.haGps ?? null;

  // Emit the server-derived state first so Nearby stays responsive, then fill in
  // the native device fix (which may take up to ~15s) in the background.
  emit({ ...merge({ haZone, haGps, deviceGps: state.deviceGps }), place: null });

  const deviceGps = await nativeFix();
  const merged = merge({ haZone, haGps, deviceGps });
  emit({ ...merged, place: null });

  // Reverse-geocode the merged point in the background; update once it arrives.
  const point = merged.point ?? null;
  if (point) {
    void reverseGeocode(point).then((place) => {
      if (place && state.point && state.point.lat === point.lat && state.point.lng === point.lng) {
        emit({ place });
      }
    });
  }
}

/** Begin resolving location (idempotent). Refreshes periodically while running. */
export function startWhere(): void {
  if (started) return;
  started = true;
  void resolve();
  refreshTimer = setInterval(() => void resolve(), 5 * 60_000);
}

export function subscribeWhere(listener: () => void): () => void {
  startWhere();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Force an immediate re-resolve (e.g. after sign-in). */
export function refreshWhere(): void {
  void resolve();
}

// Re-resolve when the sign-in state changes (so the server source kicks in).
let lastUserId: string | null = null;
useStore.subscribe((s) => {
  const id = s.currentUser?.id ?? null;
  if (id !== lastUserId) {
    lastUserId = id;
    if (started) refreshWhere();
  }
});

export function stopWhere(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  started = false;
  state = EMPTY;
}
