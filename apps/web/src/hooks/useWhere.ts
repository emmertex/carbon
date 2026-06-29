import { useSyncExternalStore } from 'react';
import { getWhere, subscribeWhere, type WhereState } from '@/lib/where';

/**
 * The user's current location ({ zone, point, place }), resolved by combining the
 * server's HA zone/GPS with native geolocation. Shared module-level state keeps the
 * Sidebar and the Nearby view in sync. Resolution is async and degrades gracefully
 * (offline / denied permission → nulls), so consumers should treat all fields as
 * optional. `hasLocation` is the gate the sidebar uses to show/hide the nav item.
 */
export function useWhere(): WhereState & { hasLocation: boolean } {
  const where = useSyncExternalStore(subscribeWhere, getWhere, getWhere);
  // `hasLocation` gates the sidebar nav item + the Nearby route. It tracks whether we
  // have *any* location data at all (so manually disabling every source doesn't hide
  // the view / eject the user) — task matching still uses the active-only zone/point.
  const hasLocation = !!where.haZone || where.devices.length > 0;
  return { ...where, hasLocation };
}
