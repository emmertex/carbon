import { useSyncExternalStore } from 'react';

/** Reserve at least 380px each for the list and docked detail. Sidebar width is
 * already excluded by measuring the actual workspace pane container. */
export const COMPACT_BREAKPOINT_PX = 760;

export function isCompactViewport(): boolean {
  if (typeof window === 'undefined') return false;
  const panes = document.querySelector('[data-workspace-panes]');
  const width = panes?.getBoundingClientRect().width ?? window.innerWidth;
  return width < COMPACT_BREAKPOINT_PX;
}
function subscribe(cb: () => void): () => void {
  const panes = document.querySelector('[data-workspace-panes]');
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(cb) : null;
  if (panes) observer?.observe(panes);
  window.addEventListener('resize', cb);
  cb();
  return () => { observer?.disconnect(); window.removeEventListener('resize', cb); };
}
export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, isCompactViewport, () => false);
}
