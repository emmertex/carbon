// A tiny decoupled bus so the localStorage settings helpers (config.ts, views.ts)
// can announce "something changed" without importing the sync layer — which would
// create an import cycle. settings-sync.ts registers the single listener at boot.

export type SettingsScope = 'ui' | 'views';
type Listener = (scope: SettingsScope) => void;

let listener: Listener | null = null;
let suppressed = false;

export function onSettingsChanged(fn: Listener): void {
  listener = fn;
}

export function notifySettingsChanged(scope: SettingsScope): void {
  if (suppressed) return; // applying inbound sync — don't echo it straight back out
  listener?.(scope);
}

/** Run `fn` without emitting settings-changed events (used while writing inbound
 *  synced settings into localStorage, so they aren't immediately re-pushed). */
export function withSuppressedSettings<T>(fn: () => T): T {
  const prev = suppressed;
  suppressed = true;
  try {
    return fn();
  } finally {
    suppressed = prev;
  }
}
