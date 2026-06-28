import type { GeoReminder, Item } from './types';

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
