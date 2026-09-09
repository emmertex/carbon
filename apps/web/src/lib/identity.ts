import { getServerConfig, getCurrentUser, workspaceHostOf } from "./config";

/**
 * Identity — the (workspace, user) pair that names every per-user store.
 * See docs/internal/a3/design.md.
 *
 * An identity key looks like `carbon.etx.sx|u:42` (workspace host + user id),
 * `myhost.io|u:alice`, or `local|local` for device-local (pre-sign-in /
 * offline-kept / open-mode) data. The DB snapshot store, the blob stores and
 * the per-user settings keys are all namespaced by it, so one account's data
 * is never addressable through another's API — and a stale tab stays bound to
 * the identity it booted with (db.ts captures it at initDb).
 */

const OFFLINE_USER_KEY = "carbon.offlineUser";

/** A user signed out *with offline data kept*: the record that keeps their
 *  data bound to their identity (instead of the device-local store). */
export interface OfflineUser {
  ws: string;
  id: string;
}

export function readOfflineUser(): OfflineUser | null {
  try {
    const raw = localStorage.getItem(OFFLINE_USER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<OfflineUser>;
    return p.ws && p.id ? (p as OfflineUser) : null;
  } catch {
    return null;
  }
}

export function saveOfflineUser(u: OfflineUser | null): void {
  if (u) localStorage.setItem(OFFLINE_USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(OFFLINE_USER_KEY);
}

/** The workspace this device is currently pointed at ('local' when no server). */
export function currentWorkspace(): string {
  return workspaceHostOf(getServerConfig().url) || "local";
}

/**
 * The current identity key:
 *  - a real (non-open) signed-in user → `<ws>|u:<id>` (live workspace)
 *  - signed out with offline data kept → the record's own `<ws>|u:<id>`. The
 *    record carries the workspace it was saved under, so the binding survives
 *    the URL being cleared afterwards (the "detach and go offline" escape) —
 *    a live-workspace match would orphan the kept data. A real signed-in user
 *    always outranks the record.
 *  - otherwise (no server, pre-sign-in capture, open mode, …) → `local|local`
 */
export function identityKey(): string {
  const u = getCurrentUser();
  if (u && !u.open && u.id) return `${currentWorkspace()}|u:${u.id}`;
  const off = readOfflineUser();
  if (off) return `${off.ws}|u:${off.id}`;
  return "local|local";
}

/** The user part of an identity key ('u:42' or 'local'). */
export function userPartOf(key: string): string {
  const i = key.lastIndexOf("|");
  return i >= 0 ? key.slice(i + 1) : key;
}

/** The user part of the current identity — the settings-namespace suffix. */
export function settingsUserPart(): string {
  return userPartOf(identityKey());
}

/**
 * A localStorage settings key namespaced by the full workspace/user identity:
 * `carbon.collapsed::https://host|u:42`, `carbon.viewprefs.<view>::local|local`, …
 * Device-level keys (theme, localOnly, settingsSync, server, user) are
 * deliberately NOT namespaced.
 */
export function settingsKey(base: string, extra?: string): string {
  const up = identityKey();
  return extra ? `${base}.${extra}::${up}` : `${base}::${up}`;
}

// ----- one-time legacy settings migration ------------------------------------

const LEGACY_SETTING_KEYS = [
  "carbon.collapsed",
  "carbon.expanded",
  "carbon.ui",
  "carbon.perspectives",
] as const;
const LEGACY_VIEWPREFS_PREFIX = "carbon.viewprefs.";

/**
 * Move the pre-A3 global settings keys into their namespaced equivalents, once
 * per identity. Idempotent: the legacy keys are removed after the move and a
 * flag records the migration for this identity. Call at module load of the
 * first settings reader (store.ts), before any namespaced key is read.
 */
export function migrateLegacySettings(): void {
  const up = identityKey();
  try {
    if (localStorage.getItem(`carbon.settingsMigrated::${up}`) === "1") return;
    const legacyUser = settingsUserPart();
    const claimKey = `carbon.settingsOwner::${legacyUser}`;
    const owner = localStorage.getItem(claimKey);
    if (!owner) localStorage.setItem(claimKey, identityKey());
    if (!owner || owner === identityKey()) {
      const candidates = Array.from({ length: localStorage.length }, (_, i) =>
        localStorage.key(i),
      );
      for (const key of candidates) {
        if (!key?.endsWith(`::${legacyUser}`)) continue;
        const base = key.slice(0, -`::${legacyUser}`.length);
        if (
          !LEGACY_SETTING_KEYS.includes(
            base as (typeof LEGACY_SETTING_KEYS)[number],
          ) &&
          !base.startsWith(LEGACY_VIEWPREFS_PREFIX)
        )
          continue;
        const target = `${base}::${identityKey()}`;
        if (localStorage.getItem(target) === null)
          localStorage.setItem(target, localStorage.getItem(key)!);
        localStorage.removeItem(key);
      }
    }
    for (const k of LEGACY_SETTING_KEYS) {
      const raw = localStorage.getItem(k);
      if (raw) {
        const target = settingsKey(k);
        if (!localStorage.getItem(target)) localStorage.setItem(target, raw);
        localStorage.removeItem(k);
      }
    }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LEGACY_VIEWPREFS_PREFIX)) continue;
      if (k.includes("::")) continue; // belongs to a namespaced identity; never steal it
      const view = k.slice(LEGACY_VIEWPREFS_PREFIX.length);
      const raw = localStorage.getItem(k);
      if (raw) {
        const target = settingsKey("carbon.viewprefs", view);
        if (!localStorage.getItem(target)) localStorage.setItem(target, raw);
      }
      localStorage.removeItem(k);
    }
    localStorage.setItem(`carbon.settingsMigrated::${up}`, "1");
  } catch {
    /* localStorage unavailable (node) — nothing to migrate */
  }
}

/** Erase only this identity's private settings; retain device and auth config. */
export function eraseIdentitySettings(namespace: string): void {
  const suffix = `::${namespace}`;
  const keys = Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.key(i),
  );
  for (const key of keys) {
    if (!key?.endsWith(suffix)) continue;
    const base = key.slice(0, -suffix.length);
    if (
      LEGACY_SETTING_KEYS.includes(
        base as (typeof LEGACY_SETTING_KEYS)[number],
      ) ||
      base.startsWith(LEGACY_VIEWPREFS_PREFIX)
    ) {
      localStorage.removeItem(key);
    }
  }
  // Never resurrect erased settings from the ambiguous legacy global/user keys.
  localStorage.setItem(`carbon.settingsMigrated::${namespace}`, "1");
  const userPart = userPartOf(namespace);
  if (!localStorage.getItem(`carbon.settingsOwner::${userPart}`))
    localStorage.setItem(`carbon.settingsOwner::${userPart}`, namespace);
}
