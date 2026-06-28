/** The one knob for edge-gesture width. Kept small on purpose: wide edge zones
 *  cause task-swipe misfires and, on Android, collide with the system back
 *  gesture. ~28px ≈ 12–15% of a phone's width is enough to be reachable. */
export const EDGE_ZONE = 28;

export type Zone = 'leftEdge' | 'rightEdge' | 'center';

/** Classify a touch by its start X. With pane gestures off, everything is the
 *  centre zone so task swipes get the full row width and panes open via the menu. */
export function zoneForX(x: number, width: number, paneGestures: boolean): Zone {
  if (!paneGestures) return 'center';
  if (x <= EDGE_ZONE) return 'leftEdge';
  if (x >= width - EDGE_ZONE) return 'rightEdge';
  return 'center';
}
