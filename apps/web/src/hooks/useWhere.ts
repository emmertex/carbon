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
  return { ...where, hasLocation: !!where.zone || !!where.point };
}
