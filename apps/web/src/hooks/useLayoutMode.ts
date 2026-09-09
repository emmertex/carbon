import { useSyncExternalStore } from 'react';

/**
 * Determines the app layout based on available width rather than device
 * classification. Three tiers:
 *   - narrow: < 640px — full-width detail overlays, minimal chrome
 *   - medium: 640px - 1023px — list/detail split with collapsible sidebar
 *   - wide: >= 1024px — full three-pane layout (sidebar + list + detail)
 */
const NARROW_QUERY = '(max-width: 639.98px)';
const MEDIUM_QUERY = '(max-width: 1023.98px)';

function subscribeNarrow(cb: () => void): () => void {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

function subscribeMedium(cb: () => void): () => void {
  const mql = window.matchMedia(MEDIUM_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

function isMedium(): boolean {
  return window.matchMedia(MEDIUM_QUERY).matches;
}

export type LayoutMode = 'narrow' | 'medium' | 'wide';

function getMode(): LayoutMode {
  if (isNarrow()) return 'narrow';
  if (isMedium()) return 'medium';
  return 'wide';
}

/**
 * Reactive hook returning the current layout mode based on available width.
 * This replaces the binary compact/roomy distinction with a more nuanced
 * width-based approach that works across phones, fold interiors, and desktops.
 */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(
    () => {
      const unsubNarrow = subscribeNarrow(getMode);
      const unsubMedium = subscribeMedium(getMode);
      return () => {
        unsubNarrow();
        unsubMedium();
      };
    },
    () => getMode(),
    () => 'wide',
  );
}

/** Imperative check for event handlers that can't call hooks. */
export function currentLayoutMode(): LayoutMode {
  return getMode();
}

/**
 * Returns true when the available width supports a docked detail pane.
 * On narrow phones, detail opens as a full-screen overlay.
 */
export function supportsDockedDetail(): boolean {
  return !isNarrow();
}

/**
 * Returns true when the available width supports a permanently visible
 * sidebar. On medium and narrow screens, the sidebar is a collapsible drawer.
 */
export function supportsPermanentSidebar(): boolean {
  return !isMedium();
}
