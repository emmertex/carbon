/** Edge-gesture width as a fraction of the row width. A wide-ish zone (1/5 of
 *  the width) lets the swipe *start* inward, away from the very edge, so it can
 *  be triggered without first landing in Android's system back-gesture strip —
 *  the narrow fixed zone was effectively unreachable on Android. */
export const EDGE_FRACTION = 1 / 5;
/** Floor so the zone stays usable on very narrow rows. */
export const EDGE_ZONE_MIN = 28;

export type Zone = 'leftEdge' | 'rightEdge' | 'center';

/** Width of an edge zone for a given row width. */
export function edgeZone(width: number): number {
  return Math.max(EDGE_ZONE_MIN, width * EDGE_FRACTION);
}

/** Classify a touch by its start X. With pane gestures off, everything is the
 *  centre zone so task swipes get the full row width and panes open via the menu. */
export function zoneForX(x: number, width: number, paneGestures: boolean): Zone {
  if (!paneGestures) return 'center';
  const edge = edgeZone(width);
  if (x <= edge) return 'leftEdge';
  if (x >= width - edge) return 'rightEdge';
  return 'center';
}
