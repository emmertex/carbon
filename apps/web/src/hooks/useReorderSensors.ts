import { MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';

/**
 * The single drag-to-reorder activation shared by every sortable list in the app
 * — the sidebar projects/folders, the sidebar tags, the task outliner, the flat
 * task lists, and the plan view — so they behave identically on desktop and on
 * touch.
 *
 * Press-and-hold (~200ms) lifts a row; moving more than 5px before the hold
 * elapses is treated as a tap/scroll, never a drag. That lets the whole row be
 * both the click/navigation target and the drag handle, with no separate grip.
 *
 * Why MouseSensor + TouchSensor rather than PointerSensor: on touch, PointerSensor
 * aborts on `pointercancel`, which the browser fires the moment it claims the
 * gesture for native scrolling — so a hold-to-drag was cancelled before it could
 * start. (The sidebar "just scrolled"; task rows only limped along because their
 * swipe wrapper's `touch-action: pan-y` happened to keep the browser from
 * cancelling, hence the "start with a sideways drag" workaround.) TouchSensor
 * instead listens for `touchcancel` — not fired for scroll arbitration — and
 * registers a non-passive global `touchmove` listener so `preventDefault()` takes
 * effect once the hold activates (required by iOS Safari). The result: a reliable
 * hold-to-drag everywhere, while a quick swipe still scrolls the list.
 */
export function useReorderSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );
}
