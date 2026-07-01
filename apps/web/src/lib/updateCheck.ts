// Update detection for the sideloaded Android build. The PWA never needs this —
// Workbox (`registerType: 'autoUpdate'` in vite.config.ts) already pulls new
// assets in the background. Tauri desktop has its own real auto-update via
// tauri-plugin-updater (see tauriUpdater.ts) — Android has no equivalent OS
// mechanism for a sideloaded APK, so this just links the user to the new one.

import { isCapacitor, capacitorOS } from './platform';

const REPO = 'emmertex/carbon';
const CACHE_KEY = 'carbon.updateCheck';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  url: string;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}
interface GithubRelease {
  tag_name: string;
  html_url: string;
  assets: GithubAsset[];
}

interface CacheEntry {
  checkedAt: number;
  info: UpdateInfo | null;
}

function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // storage unavailable/full — skip caching, next call just re-fetches
  }
}

/** Compares dotted version strings numerically (e.g. "0.5.10" > "0.5.9"). */
function isNewer(remote: string, local: string): boolean {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = r[i] ?? 0;
    const b = l[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** Direct link to the .apk asset when available, otherwise the release page. */
function pickUrl(release: GithubRelease): string {
  const apk = release.assets.find((a) => a.name.endsWith('.apk'));
  return apk?.browser_download_url ?? release.html_url;
}

/** Checks GitHub Releases for a version newer than `currentVersion`. Only
 *  meaningful on the sideloaded Android build; returns null everywhere else,
 *  on any fetch failure, or when already up to date. Cached for a day to stay
 *  well under GitHub's unauthenticated rate limit. */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  if (!isCapacitor || capacitorOS() !== 'android') return null;

  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached.info;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) return cached?.info ?? null;
    const release = (await res.json()) as GithubRelease;
    const info = isNewer(release.tag_name, currentVersion)
      ? { version: release.tag_name.replace(/^v/, ''), url: pickUrl(release) }
      : null;
    writeCache({ checkedAt: Date.now(), info });
    return info;
  } catch {
    return cached?.info ?? null;
  }
}
