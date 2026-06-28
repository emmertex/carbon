import { useEffect, useState } from 'react';

/** Re-render on an interval (for live elapsed-time displays). Pass enabled=false
 *  to stop ticking — important so the app is idle when no timer is running. */
export function useTicker(intervalMs = 1000, enabled = true): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return Date.now();
}
