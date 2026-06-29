// Place lookup for the location editor. Thin client over the server's read-only
// `/api/agent/geocode` route, which fronts the same OSM geocoder the NL agent uses.
// Never throws — callers render an inline message from the returned `error`/empty list.

import { getServerConfig, authHeaders } from './config';
import type { GeoPoint } from './location';

/** One nearby candidate, ready to drop straight into the GeoReminder fields. */
export interface PlaceHit {
  lat: number;
  lng: number;
  radius: number;
  label: string;
}

export interface PlaceSearchResult {
  candidates: PlaceHit[];
  /** Server error code (e.g. 'geocoding_disabled') when the lookup couldn't run. */
  error?: string;
}

/**
 * Look up nearby places matching `q`, biased to `near`. Returns nearest-first
 * candidates; on a failure the list is empty and `error` carries the reason
 * (so the UI can tell "search is off" from "found nothing nearby").
 */
export async function searchPlaces(q: string, near: GeoPoint): Promise<PlaceSearchResult> {
  const cfg = getServerConfig();
  try {
    const res = await fetch(`${cfg.url}/api/agent/geocode`, {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify({ q, near: { lat: near.lat, lng: near.lng } }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      candidates?: PlaceHit[];
      error?: string;
    };
    if (!res.ok) return { candidates: [], error: body.error || `http_${res.status}` };
    return { candidates: body.candidates ?? [] };
  } catch {
    return { candidates: [], error: 'offline' };
  }
}
