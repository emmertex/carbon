import { getServerConfig, authHeaders } from './config';
import { useStore } from './store';
import { getCurrentPosition } from './location';
import { getDeviceId, getDeviceName, resolveDeviceName } from './device';

// Resolves "where the user currently is" by combining the Home Assistant zone with a
// list of *device* GPS fixes (the HA device-tracker, this browser/phone, and any other
// signed-in device that reported recently). Each is a toggleable source; the merged
// point feeds task matching. Reverse-geocoding is best-effort and never blocks.
// Everything degrades gracefully when offline or when permission is denied.

/** A single device's GPS fix, with metadata for the source pills. */
export interface DeviceFix {
  /** Stable per-device id ('haZone' is reserved for the zone, never a device). */
  deviceId: string;
  /** Human label, e.g. "Andrew's Pixel". */
  name: string | null;
  /** Provenance: this device's live fix, another reporting device, or the HA tracker. */
  source: 'self' | 'device' | 'ha';
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres, when known. */
  accuracy: number | null;
  /** Epoch ms of the fix (server timestamp, or fetch time for the own live fix). */
  updatedAt: number;
}

/** The HA zone the user is currently in (event-driven: cleared on leave). */
export interface ZoneFix {
  name: string;
  updatedAt: number;
}

/** A source key is the reserved zone key or a device id. */
export const ZONE_KEY = 'haZone';
export type SourceKey = string;

/** Manual per-source override: true = force on, false = force off, absent = automatic. */
export type SourceOverrides = Record<string, boolean>;

export interface WhereState {
  /** Home Assistant zone (cleared on leave; not time-decayed). */
  haZone: ZoneFix | null;
  /** One entry per fresh device (HA tracker, this device, other devices). */
  devices: DeviceFix[];

  // --- Per-source enable/disable state, surfaced as toggleable pills ---
  /** Whether each present source (zone or device) is contributing to the merged
   *  location. Automatic (fresh + accurate enough) unless the user overrode it. */
  active: Record<SourceKey, boolean>;
  /** Manual overrides (true=force on, false=force off, absent=automatic). */
  overrides: SourceOverrides;

  // --- Merged convenience fields used for task matching + the sidebar gate ---
  zone: string | null;
  point: { lat: number; lng: number } | null;
  /** Reverse-geocoded place name for `point`, if resolved (best-effort). */
  place: string | null;
  /** True once at least one source has been consulted. */
  resolved: boolean;
}

const EMPTY: WhereState = {
  haZone: null,
  devices: [],
  active: {},
  overrides: {},
  zone: null,
  point: null,
  place: null,
  resolved: false,
};

/** GPS fixes older than this no longer auto-contribute to the merged point (the user
 *  can still force a device on by tapping its pill). The server already drops devices
 *  unseen for >24h from the list entirely. */
export const GPS_STALE_MS = 30 * 60_000; // 30 min
export const isFixStale = (updatedAt: number): boolean => Date.now() - updatedAt > GPS_STALE_MS;

/** Fixes with accuracy worse than this are too imprecise to trust for "where am I",
 *  so they auto-disable. A fix with no reported accuracy is kept. */
export const GPS_ACCURACY_LIMIT_M = 5_000; // 5 km
export const isFixTooInaccurate = (accuracy: number | null): boolean =>
  accuracy != null && accuracy > GPS_ACCURACY_LIMIT_M;

/** Automatic eligibility for a device fix: fresh and accurate enough. */
export function deviceAutoEligible(d: Pick<DeviceFix, 'updatedAt' | 'accuracy'>): boolean {
  return !isFixStale(d.updatedAt) && !isFixTooInaccurate(d.accuracy);
}

type Sources = Pick<WhereState, 'haZone' | 'devices'>;

/** Each source's automatic on/off state. Zone is event-driven (present ⇒ eligible);
 *  devices must also pass the staleness + accuracy gates. */
export function autoEligible(sources: Sources): Record<SourceKey, boolean> {
  const out: Record<SourceKey, boolean> = { [ZONE_KEY]: !!sources.haZone };
  for (const d of sources.devices) out[d.deviceId] = deviceAutoEligible(d);
  return out;
}

/** Effective active state per source: a present source is active when its override says
 *  so, or — absent an override — when automatically eligible. */
function effectiveActive(sources: Sources, overrides: SourceOverrides): Record<SourceKey, boolean> {
  const auto = autoEligible(sources);
  const active: Record<SourceKey, boolean> = {};
  if (sources.haZone) active[ZONE_KEY] = overrides[ZONE_KEY] ?? auto[ZONE_KEY];
  for (const d of sources.devices) active[d.deviceId] = overrides[d.deviceId] ?? auto[d.deviceId];
  return active;
}

// Manual overrides persist across reloads so a user's "keep this source off" sticks.
const OVERRIDES_KEY = 'carbon.where.overrides';

function loadOverrides(): SourceOverrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: SourceOverrides = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'boolean') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function saveOverrides(overrides: SourceOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(OVERRIDES_KEY);
    else localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    /* storage unavailable (private mode) — overrides just won't persist */
  }
}

let state: WhereState = { ...EMPTY, overrides: loadOverrides() };
const listeners = new Set<() => void>();
let started = false;

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

interface ServerDevice {
  deviceId: string;
  name: string | null;
  source: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  updatedAt: string;
}
interface ServerWhere {
  zone: { name: string; updatedAt: string } | null;
  devices?: ServerDevice[];
  /** Legacy alias (pre-multi-device servers) — folded into devices if present. */
  haGps?: { lat: number; lng: number; accuracy: number | null; updatedAt: string } | null;
}

/** Parse a server timestamp to epoch ms; an unparseable value becomes 0 (epoch) so the
 *  fix reads as *stale* rather than NaN — NaN comparisons are false, which would make a
 *  bad timestamp look perpetually fresh. */
function parseTs(s: string | undefined): number {
  const n = s ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function fetchServerWhere(): Promise<{ haZone: ZoneFix | null; devices: DeviceFix[] } | null> {
  if (!serverAvailable()) return null;
  const cfg = getServerConfig();
  try {
    const res = await fetch(`${cfg.url}/api/where`, { headers: authHeaders(cfg) });
    if (!res.ok) return null;
    const body = (await res.json()) as ServerWhere;
    const haZone = body.zone
      ? { name: body.zone.name, updatedAt: parseTs(body.zone.updatedAt) }
      : null;
    let devices: DeviceFix[] = (body.devices ?? []).map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      source: d.source === 'ha' ? 'ha' : 'device',
      lat: d.lat,
      lng: d.lng,
      accuracy: d.accuracy ?? null,
      updatedAt: parseTs(d.updatedAt),
    }));
    // Back-compat: an old server only returns haGps — present it as one HA device.
    if (!body.devices && body.haGps) {
      devices = [
        {
          deviceId: 'ha',
          name: null,
          source: 'ha',
          lat: body.haGps.lat,
          lng: body.haGps.lng,
          accuracy: body.haGps.accuracy ?? null,
          updatedAt: parseTs(body.haGps.updatedAt),
        },
      ];
    }
    return { haZone, devices };
  } catch {
    return null; // offline / network error — degrade gracefully
  }
}

async function nativeFix(): Promise<DeviceFix | null> {
  const p = await getCurrentPosition({ highAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
  if (!p) return null;
  return {
    deviceId: getDeviceId(),
    name: getDeviceName(),
    source: 'self',
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy ?? null,
    updatedAt: Date.now(),
  };
}

/** Best-effort: push this device's own fix to the server so other devices see it. */
function selfReport(fix: DeviceFix): void {
  if (!serverAvailable()) return;
  const cfg = getServerConfig();
  void fetch(`${cfg.url}/api/gps`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({
      device_id: fix.deviceId,
      name: fix.name,
      lat: fix.lat,
      lng: fix.lng,
      accuracy: fix.accuracy ?? undefined,
    }),
  }).catch(() => {
    /* fire-and-forget */
  });
}

/** Merge the live own-device fix into the server list, replacing the server's echo of
 *  the same device (the local fix is always fresher). */
function withOwn(devices: DeviceFix[], own: DeviceFix | null): DeviceFix[] {
  if (!own) return devices;
  return [own, ...devices.filter((d) => d.deviceId !== own.deviceId)];
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
async function reverseGeocode(
  point: { lat: number; lng: number },
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&addressdetails=1&lat=${point.lat}&lon=${point.lng}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
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

/** Recompute the merged zone/point from the sources, honouring each source's effective
 *  active state. Hierarchy for the point: this device's live fix → then the most-recent
 *  other active device. Zone matching is driven separately by the (active) HA zone.
 *  Inactive sources — stale, too inaccurate, or manually off — never contribute. */
function merge(sources: Sources, overrides: SourceOverrides): Partial<WhereState> {
  const active = effectiveActive(sources, overrides);
  const activeDevices = sources.devices.filter((d) => active[d.deviceId]);
  const own = activeDevices.find((d) => d.source === 'self');
  const best =
    own ?? [...activeDevices].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  return {
    haZone: sources.haZone,
    devices: sources.devices,
    active,
    overrides,
    zone: active[ZONE_KEY] ? (sources.haZone?.name ?? null) : null,
    point: best ? { lat: best.lat, lng: best.lng } : null,
  };
}

// Coalesce reverse-geocode lookups: rapid pill toggles all resolve to roughly the same
// spot, so we cache the label per ~10m cell (a cache hit needs no network) and abort any
// in-flight request when the point moves — one outbound request at a time, respecting
// OSM's rate policy. The cache also restores the label after resolve()'s `place: null`
// reset without re-fetching.
const geoCache = new Map<string, string>();
let geoAbort: AbortController | null = null;
const geoKey = (p: { lat: number; lng: number }): string => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

/** Reverse-geocode the merged point in the background; update once it arrives, but only
 *  if the user is still at that exact point (avoids a late label clobbering a newer fix). */
function geocodeInto(point: { lat: number; lng: number } | null): void {
  if (!point) return;
  const key = geoKey(point);
  const cached = geoCache.get(key);
  if (cached) {
    emit({ place: cached });
    return;
  }
  geoAbort?.abort();
  geoAbort = new AbortController();
  void reverseGeocode(point, geoAbort.signal).then((place) => {
    if (!place) return;
    geoCache.set(key, place);
    if (state.point && state.point.lat === point.lat && state.point.lng === point.lng) {
      emit({ place });
    }
  });
}

// Guards against overlapping resolves (5-min interval + sign-in refresh + device-name
// save can all fire at once): each run claims a generation; a superseded run stops
// emitting so a slow earlier run can't clobber newer state.
let resolveGen = 0;

async function resolve(): Promise<void> {
  const gen = ++resolveGen;
  const server = await fetchServerWhere();
  if (gen !== resolveGen) return;
  const haZone = server?.haZone ?? null;
  const serverDevices = server?.devices ?? [];

  // Emit the server-derived state first so Nearby stays responsive, then fill in the
  // native device fix (which may take up to ~15s) in the background.
  const ownPrev = state.devices.find((d) => d.source === 'self') ?? null;
  emit({ ...merge({ haZone, devices: withOwn(serverDevices, ownPrev) }, state.overrides), place: null });

  const own = await nativeFix();
  if (own) selfReport(own); // report our fix even if a newer resolve has superseded us
  if (gen !== resolveGen) return;
  const devices = withOwn(serverDevices, own ?? ownPrev);
  const merged = merge({ haZone, devices }, state.overrides);
  emit({ ...merged, place: null });
  geocodeInto(merged.point ?? null);
}

/**
 * Manually enable or disable a source (zone or device), overriding the automatic
 * hierarchy. Pass `undefined` to clear the override. Re-merges immediately (no refetch).
 */
export function setSourceOverride(key: SourceKey, enabled: boolean | undefined): void {
  const overrides: SourceOverrides = { ...state.overrides };
  if (enabled === undefined) delete overrides[key];
  else overrides[key] = enabled;
  saveOverrides(overrides);
  const merged = merge({ haZone: state.haZone, devices: state.devices }, overrides);
  emit({ ...merged, place: null });
  geocodeInto(merged.point ?? null);
}

/** Toggle a source on/off relative to its current effective state (one-tap pill). */
export function toggleSource(key: SourceKey): void {
  setSourceOverride(key, !state.active[key]);
}

/** Begin resolving location (idempotent). Refreshes periodically while running. */
export function startWhere(): void {
  if (started) return;
  started = true;
  void resolveDeviceName(); // populate the native device name (Capacitor) for self-report
  void resolve();
  setInterval(() => void resolve(), 5 * 60_000);
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

/** All of the account's currently-known devices (≤24h), for the settings list. */
export async function fetchDevices(): Promise<DeviceFix[]> {
  return (await fetchServerWhere())?.devices ?? [];
}

/** Remove one of the account's devices server-side (a retired phone). */
export async function removeDevice(deviceId: string): Promise<void> {
  if (!serverAvailable()) return;
  const cfg = getServerConfig();
  await fetch(`${cfg.url}/api/where/device/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: authHeaders(cfg),
  });
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
