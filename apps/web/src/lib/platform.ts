// Which shell is hosting the web build. The same Vite bundle runs as a browser
// PWA, inside Tauri (desktop), and inside Capacitor (Android) — feature code keys
// off this instead of sniffing the user-agent. Detection is runtime-only and never
// imports the Tauri/Capacitor libraries, so the plain web build has no dependency
// on them being installed.

export type Platform = 'web' | 'tauri' | 'capacitor';

interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}
interface CapacitorWindow {
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
}

function detect(): Platform {
  if (typeof window === 'undefined') return 'web';
  const w = window as unknown as TauriWindow & CapacitorWindow;
  if (w.__TAURI_INTERNALS__ || w.__TAURI__) return 'tauri';
  if (w.Capacitor?.isNativePlatform?.()) return 'capacitor';
  return 'web';
}

export const platform: Platform = detect();

export const isNative = platform !== 'web';
export const isTauri = platform === 'tauri';
export const isCapacitor = platform === 'capacitor';

/** Underlying OS as Capacitor reports it ('android' | 'ios' | 'web'), else null. */
export function capacitorOS(): string | null {
  if (!isCapacitor) return null;
  return (window as unknown as CapacitorWindow).Capacitor?.getPlatform?.() ?? null;
}
