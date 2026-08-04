import { useEffect, useRef } from 'react';

/**
 * dnd-kit's MouseSensor/TouchSensor register a capture-phase `click` listener on
 * `document` that calls `stopPropagation` but NOT `preventDefault`. For rows
 * whose click target has no default action (a `<div>` or `<button>`) that's
 * enough — but the sidebar's project rows wrap a react-router `<NavLink>`, an
 * `<a>` whose default action is a full page navigation. dnd-kit's listener fires
 * in the capture phase on `document`, so the click never reaches React's root
 * container, the NavLink's onClick never runs (so react-router never
 * `preventDefault`s), and the browser follows the `href` — reloading the page
 * after every successful drag of a project row.
 *
 * This installs a matching document-level capture click listener that
 * `preventDefault`s (and stops) the first click after a drag ends, so the row's
 * anchor never gets the click. Call the returned marker from your DndContext's
 * `onDragEnd` (early returns and all — a drag that ends without a reorder still
 * fires a stray click that must be swallowed).
 *
 * `stopPropagation` alone is not enough: it only halts further propagation, not
 * the default action, so the `<a>` navigation runs regardless. The two together
 * cover both the default action and any React onClick handlers that would
 * re-trigger it via `useNavigate`.
 */
export function useSuppressClickAfterDrag(): () => void {
  const suppress = useRef(false);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!suppress.current) return;
      suppress.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener('click', onClick, { capture: true });
    return () =>
      document.removeEventListener('click', onClick, { capture: true });
  }, []);
  return () => {
    suppress.current = true;
  };
}
