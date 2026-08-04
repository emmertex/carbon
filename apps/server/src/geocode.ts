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
  /** Min ms between outbound requests. Defaults to 1100 to honour OSM ≤1 req/s policy. */
  requestIntervalMs?: number;
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

// Concise tracing so a failing place search can be diagnosed from the server log:
// which tier ran, the upstream HTTP status, and the hit count. Off by default
// (mirrors CARBON_NL_DEBUG); set CARBON_GEO_DEBUG=1 (or true) to enable.
const GEO_DEBUG =
  process.env.CARBON_GEO_DEBUG === '1' || process.env.CARBON_GEO_DEBUG === 'true';
function geoDbg(msg: string): void {
  if (GEO_DEBUG) console.log(`[geo] ${msg}`);
}

// The public Overpass endpoint is frequently overloaded; cap its wait short so a slow
// Overpass falls through to Nominatim quickly instead of stalling the whole search.
const OVERPASS_TIMEOUT_MS = 8_000;

/** One-line cause for a thrown fetch: ENOTFOUND/EAI_AGAIN = no DNS/egress, TimeoutError
 *  = upstream too slow, EndpointError = SSRF guard blocked the URL. */
function describeErr(e: unknown): string {
  const err = e as { name?: string; code?: string; message?: string; cause?: unknown };
  const cause = err.cause as { code?: string; message?: string } | undefined;
  return (
    `${err.name ?? 'Error'}` +
    `${err.code ? ` code=${err.code}` : ''}` +
    `${cause?.code ? ` cause=${cause.code}` : ''}` +
    ` — ${err.message ?? cause?.message ?? 'unknown'}`
  );
}

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

/** Minimal runtime shape check: an array of objects each carrying string lat/lon. Nominatim's
 *  contract is a JSON array, but nothing stops an upstream error page or proxy from returning
 *  something else with a 200 — this keeps a malformed body from crashing the `.map`/property
 *  access below instead of degrading to "no hits" like every other failure mode in this file. */
function isNominatimResultArray(v: unknown): v is NominatimResult[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) => r && typeof r === 'object' && typeof (r as NominatimResult).lat === 'string' && typeof (r as NominatimResult).lon === 'string',
    )
  );
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

  const requestIntervalMs = cfg.requestIntervalMs ?? MIN_REQUEST_INTERVAL_MS;

  // Space out outbound requests to honour the OSM ≤1 req/s policy. A request reserves
  // the next free time-slot; an isolated request pays no delay, only bunched ones wait.
  let nextSlot = 0;
  async function paced<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + requestIntervalMs;
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
      `[out:json][timeout:8];(` +
      `nwr["brand"~"${q}",i]${filter};` +
      `nwr["name"~"${q}",i]${filter};` +
      `);out center 40;`;
    const res = await safeFetch(
      cfg.overpassUrl,
      allowPrivate,
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'user-agent': cfg.userAgent },
        body: 'data=' + encodeURIComponent(ql),
      },
      OVERPASS_TIMEOUT_MS,
    );
    if (!res.ok) {
      geoDbg(`overpass HTTP ${res.status} for "${q}" (host may be blocking server requests)`);
      return [];
    }
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

  /**
   * Nominatim free-text search around `near`.
   *
   * `bounded` (default) hard-restricts results to a tight viewbox (~0.3° ≈ 30km) — the
   * local "what's near me" pass. With `bounded: false` the viewbox is only a soft ranking
   * bias over a wide span (`spanDeg`), so an explicit "Ikea Springvale" / "Bunnings
   * Melbourne" still resolves a place outside the immediate area (Nominatim parses the
   * "<brand> <locality>" string the same way osm.org does), preferring the user's region
   * for ambiguous names. Either way hits carry their distance from `near` for nearest-first
   * sorting.
   */
  async function viaNominatim(
    query: string,
    near: GeoPoint,
    opts?: { bounded?: boolean; spanDeg?: number },
  ): Promise<Hit[]> {
    const bounded = opts?.bounded ?? true;
    const d = opts?.spanDeg ?? 0.3;
    const vb = [near.lng - d, near.lat + d, near.lng + d, near.lat - d].join(',');
    const url =
      `${cfg.nominatimUrl}/search?format=jsonv2&addressdetails=1&limit=20` +
      (bounded ? '&bounded=1' : '') +
      `&viewbox=${encodeURIComponent(vb)}&q=${encodeURIComponent(query)}`;
    const res = await safeFetch(url, allowPrivate, {
      headers: { 'user-agent': cfg.userAgent, accept: 'application/json' },
    });
    if (!res.ok) {
      geoDbg(
        `nominatim HTTP ${res.status} for "${query}" (bounded=${bounded}); ` +
          `403/429 means the public host is blocking this server's requests`,
      );
      return [];
    }
    const rawJson: unknown = await res.json();
    if (!isNominatimResultArray(rawJson)) {
      geoDbg(`nominatim returned an unexpected shape for "${query}" (bounded=${bounded}) — treating as no hits`);
      return [];
    }
    const rows = rawJson;
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
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      geoDbg(`"${query}" → ${cached.hits.length} hit(s) (cache)`);
      return cached.hits.slice(0, limit).map((h) => ({ point: h.point, label: h.label }));
    }

    // Each tier is fault-isolated: a failure (timeout, rate-limit, bad JSON) degrades to
    // empty and falls through to the next provider — one slow Overpass must not abort the
    // Nominatim tiers that would have answered. Tiers, in order:
    //   1) brand/name near me (Overpass)         — best for "nearest <brand> to me"
    //   2) free-text near me (Nominatim, bounded) — local place/address match
    //   3) free-text region-wide (Nominatim)      — explicit far place ("Ikea Springvale")
    const tiers: Array<{ name: string; run: () => Promise<Hit[]> }> = [
      { name: 'overpass', run: () => viaOverpass(query, near, radiusM) },
      { name: 'nominatim/local', run: () => viaNominatim(query, near) },
      {
        name: 'nominatim/region',
        run: () => viaNominatim(query, near, { bounded: false, spanDeg: 10 }),
      },
    ];
    let hits: Hit[] = [];
    let tier = 'none';
    for (const t of tiers) {
      let h: Hit[] = [];
      try {
        h = await paced(t.run);
      } catch (e) {
        geoDbg(`"${query}" ${t.name} failed: ${describeErr(e)} — trying next tier`);
        continue;
      }
      if (h.length > 0) {
        hits = h.sort((a, b) => a.dist - b.dist);
        tier = t.name;
        break;
      }
    }
    geoDbg(
      `"${query}" @ ${near.lat.toFixed(3)},${near.lng.toFixed(3)} → ${hits.length} hit(s) via ${tier}`,
    );
    // Cache only successful lookups: a transient upstream failure must not pin an empty
    // result for the whole TTL and keep failing on retry.
    if (hits.length > 0) cache.set(key, { at: Date.now(), hits });
    return hits.slice(0, limit).map((h) => ({ point: h.point, label: h.label }));
  }

  return {
    search,
    async nearestBrand(query, near, opts) {
      return (await search(query, near, { ...opts, limit: 1 }))[0] ?? null;
    },
  };
}
