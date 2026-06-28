import { useStore } from './store';

// Global grace before just-completed tasks hide from not-completed views. The
// timer is GLOBAL and resets on every completion, so ticking several tasks in a
// row doesn't make the list shift under you — the whole batch hides together once
// you stop (after GRACE_MS of no completions).

export const COMPLETE_GRACE_MS = 2500;

let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Ids of completed tasks currently held visible during the grace window. */
export function pendingHideIds(): Set<string> {
  return pending;
}

function resetTimer(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    pending = new Set();
    timer = null;
    useStore.getState().bump(); // re-render so the held tasks now hide
  }, COMPLETE_GRACE_MS);
}

/** Mark a task just-completed: hold it visible and (re)arm the global hide timer. */
export function holdCompleted(id: string): void {
  pending.add(id);
  resetTimer();
}

/** A task was un-completed before it hid — stop holding it. */
export function releaseCompleted(id: string): void {
  pending.delete(id);
}
