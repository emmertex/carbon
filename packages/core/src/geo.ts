import type { GeoReminder, Item } from './types';
import type { Db } from './db';
import { allItems, getItem, projectAncestor } from './repo';

export function parseGeo(json: string | null): GeoReminder | null {
  if (!json) return null;
  try {
    const g = JSON.parse(json) as GeoReminder;
    if (typeof g.lat !== 'number' || typeof g.lng !== 'number') return null;
    const radius = typeof g.radius === 'number' && g.radius > 0 ? g.radius : 100;
    return { lat: g.lat, lng: g.lng, radius, label: g.label };
  } catch {
    return null;
  }
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Active tasks whose geofence the given point is inside. */
export function tasksAtLocation(
  items: Item[],
  point: { lat: number; lng: number },
): Item[] {
  return items.filter((i) => {
    if (i.type !== 'task' || i.status !== 'active' || i.deleted) return false;
    const g = parseGeo(i.geo);
    return g !== null && distanceMeters(point, g) <= g.radius;
  });
}

/** Active tasks whose geo label matches a (Home Assistant) zone name. */
export function tasksInZone(items: Item[], zone: string): Item[] {
  const z = zone.trim().toLowerCase();
  return items.filter((i) => {
    if (i.type !== 'task' || i.status !== 'active' || i.deleted) return false;
    const g = parseGeo(i.geo);
    return !!g?.label && g.label.trim().toLowerCase() === z;
  });
}

/** The user's resolved current location: an HA zone name and/or a GPS point. */
export interface CurrentLocation {
  zone?: string | null;
  point?: { lat: number; lng: number } | null;
}

/** Does a single geo reminder match the current location (zone name or radius)? */
function geoMatches(geo: GeoReminder, loc: CurrentLocation): boolean {
  if (loc.zone && geo.label && geo.label.trim().toLowerCase() === loc.zone.trim().toLowerCase()) {
    return true;
  }
  if (loc.point && distanceMeters(loc.point, geo) <= geo.radius) return true;
  return false;
}

/**
 * Active tasks that are location-matched to the user's current location, where a
 * task matches if the task ITSELF, ANY of its parents, OR its project ancestor has
 * a geo reminder matching `loc` — by HA zone name (case-insensitive label equality)
 * OR by GPS point-in-radius. Walking ancestors needs the item graph, so this takes
 * the `Db` (uses `getItem`/`projectAncestor`). Results are de-duplicated.
 */
export function tasksNearLocation(db: Db, loc: CurrentLocation): Item[] {
  // Nothing to match against → no nearby tasks.
  if (!loc.zone && !loc.point) return [];

  // A geo cache keyed by item id, so each ancestor is parsed/tested at most once.
  const cache = new Map<string, boolean>();
  const itemMatches = (id: string): boolean => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const it = getItem(db, id);
    const g = it ? parseGeo(it.geo) : null;
    const hit = !!g && !it!.deleted && geoMatches(g, loc);
    cache.set(id, hit);
    return hit;
  };

  const out: Item[] = [];
  for (const t of allItems(db)) {
    if (t.type !== 'task' || t.status !== 'active' || t.deleted) continue;

    // The task itself, then every ancestor up the parent chain.
    let matched = itemMatches(t.id);
    if (!matched) {
      const seen = new Set<string>([t.id]);
      let pid = t.parent_id;
      while (pid && !seen.has(pid)) {
        seen.add(pid);
        if (itemMatches(pid)) {
          matched = true;
          break;
        }
        pid = getItem(db, pid)?.parent_id ?? null;
      }
    }
    // Finally the nearest project ancestor (cheap if already walked above).
    if (!matched) {
      const proj = projectAncestor(db, t.id);
      if (proj && itemMatches(proj.id)) matched = true;
    }

    if (matched) out.push(t);
  }
  return out;
}
