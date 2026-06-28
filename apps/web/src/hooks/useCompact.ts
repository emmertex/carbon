import { useSyncExternalStore } from 'react';

/** The single "compact vs roomy" line — matches Tailwind's `lg` breakpoint. A
 *  foldable's wide inner screen lands above this and gets the desktop layout. */
const COMPACT_QUERY = '(max-width: 1023.98px)';

function subscribe(cb: () => void): () => void {
  const mql = window.matchMedia(COMPACT_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

function getSnapshot(): boolean {
  return window.matchMedia(COMPACT_QUERY).matches;
}

/** True on phone-width screens; reactive to resize and folding. Use for
 *  render-time layout branching (event handlers can still read innerWidth). */
export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
