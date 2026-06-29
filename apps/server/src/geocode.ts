/**
 * Pluggable place geocoding for the agent API.
 *
 * Supports "remind me to get milk next time I'm at Coles" → find the nearest Coles to
 * the user and stamp its coordinates onto the `coles` tag's geofence. The default
 * provider is OpenStreetMap (Overpass for brand-nearest, Nominatim as a fallback) — no
 * API key needed — but it sits behind the `GeocodeProvider` interface so it can be
 * swapped (Google, a self-hosted Nominatim/Photon) or stubbed in tests.
 *
 * Privacy/abuse posture: every outbound request goes through `safeFetch` (the SSRF
 * guard) and any failure degrades to `null` — the route then falls back to
 * caller-supplied coordinates and never 500s. Geocoding is opt-in under a base domain.
 */
import { distanceMeters } from '@carbon/core';
import { safeFetch } from './safe-fetch';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeocodeProvider {
  /**
   * Nearby places matching `query` (brand/name/address) to `near`, sorted nearest-first.
   * Empty when nothing is found (or the lookup fails). `limit` caps the result count.
   */
  search(
    query: string,
    near: GeoPoint,
    opts?: { radiusM?: number; limit?: number },
  ): Promise<Array<{ point: GeoPoint; label: string }>>;
  /** Nearest place matching `query` (brand/name) to `near`, or null if none found. */
  nearestBrand(
    query: string,
    near: GeoPoint,
    opts?: { radiusM?: number },
  ): Promise<{ point: GeoPoint; label: string } | null>;
}

export interface GeocodeConfig {
  enabled: boolean;
  nominatimUrl: string;
  overpassUrl: string;
  userAgent: string;
  /** Default brand-search radius in metres. */
  radiusM: number;
}

const DEFAULT_NOMINATIM = 'https://nominatim.openstreetmap.org';
const DEFAULT_OVERPASS = 'https://overpass-api.de/api/interpreter';
const DEFAULT_UA =
  'CarbonTasks/1.0 (+https://github.com/carbon-tasks/carbon; self-hosted task manager)';

// OSM usage policy: ≤1 request/sec to the public endpoints, and cache results. We
// serialize outbound geocode requests with a minimum spacing and memoize recent
// lookups so a burst of NL commands can't get the deployment rate-limited/banned.
const MIN_REQUEST_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Read geocoder config from the environment.
 *
 * `CARBON_GEOCODE_ENABLED` controls it explicitly ("1"/"true"/"on" → on, "0"/… → off).
 * When unset it defaults ON for single-tenant self-host and OFF under a base domain
 * (multi-tenant) — callers pass `multiTenant` so one workspace can't make the host
 * geocode on its behalf without the operator opting in.
 */
export function geocodeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  multiTenant = false,
): GeocodeConfig {
  const raw = (env.CARBON_GEOCODE_ENABLED ?? '').trim().toLowerCase();
  const enabled =
    raw === '1' || raw === 'true' || raw === 'on'
      ? true
      : raw === '0' || raw === 'false' || raw === 'off'
        ? false
        : !multiTenant; // default: on for single-tenant, off for multi-tenant
  const radius = Number(env.CARBON_GEOCODE_RADIUS_M);
  return {
    enabled,
    nominatimUrl: (env.CARBON_NOMINATIM_URL || DEFAULT_NOMINATIM).replace(/\/$/, ''),
    overpassUrl: env.CARBON_OVERPASS_URL || DEFAULT_OVERPASS,
    userAgent: env.CARBON_GEOCODE_UA || DEFAULT_UA,
    radiusM: Number.isFinite(radius) && radius > 0 ? radius : 5000,
  };
}

interface OverpassElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name?: string;
  name?: string;
  address?: {
    suburb?: string;
    town?: string;
    city?: string;
    village?: string;
  };
}

/** "Coles, Ringwood" — append a locality to the place name when one is known. */
function withLocality(name: string, locality: string | undefined): string {
  const loc = locality?.trim();
  return loc && loc.toLowerCase() !== name.trim().toLowerCase() ? `${name}, ${loc}` : name;
}

/** Build the OSM provider, or null when disabled (caller must then supply coords). */
export function makeOsmProvider(cfg: GeocodeConfig, allowPrivate: boolean): GeocodeProvider | null {
  if (!cfg.enabled) return null;

  type Hit = { point: GeoPoint; label: string; dist: number };

  // Space out outbound requests to honour the OSM ≤1 req/s policy. A request reserves
  // the next free time-slot; an isolated request pays no delay, only bunched ones wait.
  let nextSlot = 0;
  async function paced<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_INTERVAL_MS;
    if (wait) await new Promise((res) => setTimeout(res, wait));
    return fn();
  }

  // Memoize the full sorted hit list per (query, rounded location, radius). Callers
  // slice it to their own limit, so nearestBrand and search share one upstream call.
  const cache = new Map<string, { at: number; hits: Hit[] }>();
  const cacheKey = (query: string, near: GeoPoint, radiusM: number) =>
    `${query.trim().toLowerCase()}|${near.lat.toFixed(3)},${near.lng.toFixed(3)}|${radiusM}`;

  async function viaOverpass(
    query: string,
    near: GeoPoint,
    radiusM: number,
  ): Promise<Hit[]> {
    // Match either the brand or the name (case-insensitive), node/way/relation.
    // Strip QL-string chars (" \) AND regex metacharacters: the value is interpolated
    // into an Overpass case-insensitive regex (~"..."), so an unescaped `.*` would match
    // every place in radius. We deliberately match the plain term only.
    const q = query.replace(/["\\.*+?^${}()|[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q) return [];
    const filter = `(around:${radiusM},${near.lat},${near.lng})`;
    const ql =
      `[out:json][timeout:15];(` +
      `nwr["brand"~"${q}",i]${filter};` +
      `nwr["name"~"${q}",i]${filter};` +
      `);out center 40;`;
    const res = await safeFetch(cfg.overpassUrl, allowPrivate, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': cfg.userAgent },
      body: 'data=' + encodeURIComponent(ql),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { elements?: OverpassElement[] };
    const hits: Array<{ point: GeoPoint; label: string; dist: number }> = [];
    for (const el of data.elements ?? []) {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      const name = el.tags?.name || el.tags?.brand || query;
      const locality = el.tags?.['addr:suburb'] || el.tags?.['addr:city'] || el.tags?.['addr:town'];
      hits.push({
        point: { lat, lng },
        label: withLocality(name, locality),
        dist: distanceMeters(near, { lat, lng }),
      });
    }
    return hits;
  }

  async function viaNominatim(query: string, near: GeoPoint): Promise<Hit[]> {
    // Bias the search to a viewbox around `near` (~0.3° ≈ 30km), bounded.
    const d = 0.3;
    const vb = [near.lng - d, near.lat + d, near.lng + d, near.lat - d].join(',');
    const url =
      `${cfg.nominatimUrl}/search?format=jsonv2&addressdetails=1&limit=20&bounded=1` +
      `&viewbox=${encodeURIComponent(vb)}&q=${encodeURIComponent(query)}`;
    const res = await safeFetch(url, allowPrivate, {
      headers: { 'user-agent': cfg.userAgent, accept: 'application/json' },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as NominatimResult[];
    const hits: Array<{ point: GeoPoint; label: string; dist: number }> = [];
    for (const r of rows) {
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const name = r.name || r.display_name || query;
      const a = r.address;
      const locality = a?.suburb || a?.town || a?.city || a?.village;
      // Only enrich a short brand/name label; a full display_name already carries locality.
      const label = r.name ? withLocality(name, locality) : name;
      hits.push({ point: { lat, lng }, label, dist: distanceMeters(near, { lat, lng }) });
    }
    return hits;
  }

  async function search(
    query: string,
    near: GeoPoint,
    opts?: { radiusM?: number; limit?: number },
  ): Promise<Array<{ point: GeoPoint; label: string }>> {
    const radiusM = opts?.radiusM ?? cfg.radiusM;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 5;
    const key = cacheKey(query, near, radiusM);
    const cached = cache.get(key);
    let hits: Hit[];
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      hits = cached.hits;
    } else {
      try {
        let h = await paced(() => viaOverpass(query, near, radiusM));
        if (h.length === 0) h = await paced(() => viaNominatim(query, near));
        hits = h.sort((a, b) => a.dist - b.dist);
        cache.set(key, { at: Date.now(), hits });
      } catch {
        // EndpointError (SSRF/url), network, timeout, or bad JSON → "nothing found".
        return [];
      }
    }
    return hits.slice(0, limit).map((h) => ({ point: h.point, label: h.label }));
  }

  return {
    search,
    async nearestBrand(query, near, opts) {
      return (await search(query, near, { ...opts, limit: 1 }))[0] ?? null;
    },
  };
}
