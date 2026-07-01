// Real silent-download, confirmed-install auto-update for the Tauri desktop
// build, via tauri-plugin-updater. The plugin checks the endpoint configured
// in tauri.conf.json (a `latest.json` published alongside each GitHub release)
// and verifies the downloaded bundle against the signing key baked into that
// config before installing — see docs/RELEASING.md for the signing setup.
//
// Dynamically imported so the plain web/Capacitor builds never pull in Tauri's
// JS bindings (mirrors the pattern in notify.ts for plugin-notification).

import { isTauri } from './platform';

export interface TauriUpdate {
  version: string;
  /** Downloads and installs the update, then relaunches the app. Throws on failure. */
  install: () => Promise<void>;
}

/** Checks the configured updater endpoint for a newer build. Returns null on
 *  the web/Capacitor, when already up to date, or on any check failure (e.g.
 *  offline, endpoint unreachable). */
export async function checkTauriUpdate(): Promise<TauriUpdate | null> {
  if (!isTauri) return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      install: async () => {
        await update.downloadAndInstall();
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      },
    };
  } catch {
    return null;
  }
}
