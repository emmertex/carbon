import { useEffect, useRef, useState } from 'react';

/**
 * A momentary boolean for "Saved ✓" / "Copied" feedback. Calling `flash()` turns
 * it on for `ms`, then auto-resets. The timer is cleared on unmount so we never
 * setState after the component is gone (was an un-cleared `setTimeout` in every
 * settings sub-component).
 */
export function useSavedFlash(ms = 1500): readonly [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function flash() {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  }
  return [on, flash] as const;
}
