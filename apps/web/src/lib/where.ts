import { getServerConfig, authHeaders } from './config';
import { useStore } from './store';
import { getCurrentPosition } from './location';

// Resolves "where the user currently is" by combining, in priority order:
//   1. Home Assistant zone (from the server, set by the zone enter/leave webhook)
//   2. GPS from Home Assistant (the server's latest device-tracker fix)
//   3. Native device GPS (navigator.geolocation), as a fallback / extra source
// Reverse-geocoding to a place name is best-effort and never blocks. Everything
// degrades gracefully when offline or when permission is denied.

export interface WhereState {
  /** Home Assistant zone name, if the server knows one. */
  zone: string | null;
  /** Best current GPS point (server HA fix, else native geolocation). */
  point: { lat: number; lng: number } | null;
  /** Reverse-geocoded place name for `point`, if resolved (best-effort). */
  place: string | null;
  /** True once at least one source has been consulted. */
  resolved: boolean;
}

const EMPTY: WhereState = { zone: null, point: null, place: null, resolved: false };

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

async function fetchServerWhere(): Promise<{ zone: string | null; point: { lat: number; lng: number } | null } | null> {
  if (!serverAvailable()) return null;
  const cfg = getServerConfig();
  try {
    const res = await fetch(`${cfg.url}/api/where`, { headers: authHeaders(cfg) });
    if (!res.ok) return null;
    const body = (await res.json()) as { zone: string | null; lat: number | null; lng: number | null };
    const point =
      typeof body.lat === 'number' && typeof body.lng === 'number'
        ? { lat: body.lat, lng: body.lng }
        : null;
    return { zone: body.zone ?? null, point };
  } catch {
    return null; // offline / network error — degrade gracefully
  }
}

async function nativePoint(): Promise<{ lat: number; lng: number } | null> {
  // Uses the phone's sensors via @capacitor/geolocation on native, browser API on
  // the web. Never throws to the UI.
  const p = await getCurrentPosition({ highAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
  return p ? { lat: p.lat, lng: p.lng } : null;
}

/** Best-effort reverse geocode via OpenStreetMap Nominatim (no key). Never blocks. */
async function reverseGeocode(point: { lat: number; lng: number }): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&lat=${point.lat}&lon=${point.lng}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string; display_name?: string };
    return body.name || body.display_name || null;
  } catch {
    return null;
  }
}

async function resolve(): Promise<void> {
  const server = await fetchServerWhere();
  // Server HA GPS wins over native; fall back to native if the server has none.
  const point = server?.point ?? (await nativePoint());
  emit({ zone: server?.zone ?? null, point, place: null });

  // Reverse-geocode in the background; update once it arrives. Don't block.
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
