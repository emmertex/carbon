// Cross-device sync for UI preferences, per-view filters, and saved perspectives.
//
// These live in localStorage (not the CRDT item graph), so they ride a dedicated
// `setting` record-op entity instead: one row per scope ('ui' / 'views'), carrying
// the full JSON blob. The server scopes `setting` ops to their owning user
// (data.user_id, forced server-side), so a user's devices converge but no one else
// sees them. Merge is last-writer-wins by the op's causal ts.
//
// Sync is on by default and can be turned off per device; first login on a fresh
// device pulls the server's settings via the normal sync backfill.

import { recordRecordOp, type RecordOp } from '@carbon/core';
import { getMeta, setMeta } from './db';
import { mutate } from './mutate';
import { getServerConfig, getUiPrefs, saveUiPrefs } from './config';
import { useStore } from './store';
import { onSettingsChanged, withSuppressedSettings, type SettingsScope } from './settings-events';

const ENABLED_KEY = 'carbon.settingsSync';
const VIEWPREFS_PREFIX = 'carbon.viewprefs.';
const PERSPECTIVES_KEY = 'carbon.perspectives';
const COLLAPSE_KEY = 'carbon.collapsed';
const EXPAND_KEY = 'carbon.expanded';
const APPLIED_META = (scope: string) => `settings_applied_${scope}`;

export function isSettingsSyncEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) !== '0'; // default on
}

export function setSettingsSyncEnabled(v: boolean): void {
  localStorage.setItem(ENABLED_KEY, v ? '1' : '0');
  useStore.getState().setSettingsSyncEnabled(v);
  // Enabling: push the local state up so this device's settings start converging.
  if (v) {
    schedulePush('ui');
    schedulePush('views');
  }
}

// ----- snapshots (localStorage -> blob) -------------------------------------

function snapshotUi(): unknown {
  const s = useStore.getState();
  return {
    ...getUiPrefs(),
    collapsedIds: [...s.collapsed],
    expandedIds: [...s.expanded],
  };
}

function snapshotViews(): { prefs: Record<string, unknown>; perspectives: unknown } {
  const prefs: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(VIEWPREFS_PREFIX)) continue;
    try {
      prefs[k.slice(VIEWPREFS_PREFIX.length)] = JSON.parse(localStorage.getItem(k)!);
    } catch {
      /* skip a corrupt entry */
    }
  }
  let perspectives: unknown = [];
  try {
    perspectives = JSON.parse(localStorage.getItem(PERSPECTIVES_KEY) || '[]');
  } catch {
    /* keep [] */
  }
  return { prefs, perspectives };
}

// ----- apply (blob -> localStorage + store) ---------------------------------

function applyUi(payload: unknown): void {
  const { collapsedIds, expandedIds, ...uiPayload } = (payload ?? {}) as {
    collapsedIds?: string[];
    expandedIds?: string[];
    [k: string]: unknown;
  };
  withSuppressedSettings(() => {
    saveUiPrefs(uiPayload as never);
    // getUiPrefs re-normalizes (fills defaults / nested rowIcons), so the store
    // always holds a complete object even if a peer sent a partial one.
    useStore.setState({ uiPrefs: getUiPrefs() });
    if (Array.isArray(collapsedIds)) {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedIds));
      useStore.setState({ collapsed: new Set(collapsedIds) });
    }
    if (Array.isArray(expandedIds)) {
      localStorage.setItem(EXPAND_KEY, JSON.stringify(expandedIds));
      useStore.setState({ expanded: new Set(expandedIds) });
    }
  });
}

function applyViews(payload: unknown): void {
  const p = (payload ?? {}) as { prefs?: Record<string, unknown>; perspectives?: unknown };
  withSuppressedSettings(() => {
    if (p.prefs) {
      for (const [key, val] of Object.entries(p.prefs)) {
        localStorage.setItem(VIEWPREFS_PREFIX + key, JSON.stringify(val));
      }
    }
    if (p.perspectives !== undefined) {
      localStorage.setItem(PERSPECTIVES_KEY, JSON.stringify(p.perspectives));
    }
  });
  // View components re-read prefs/perspectives on the next render driven by the
  // db revision; bump so the sidebar perspective list and open view refresh.
  useStore.getState().bump();
}

// ----- push (debounced) -----------------------------------------------------

const pushTimers: Partial<Record<SettingsScope, ReturnType<typeof setTimeout>>> = {};

function schedulePush(scope: SettingsScope): void {
  if (!isSettingsSyncEnabled()) return;
  if (pushTimers[scope]) clearTimeout(pushTimers[scope]);
  pushTimers[scope] = setTimeout(() => pushNow(scope), 600);
}

function pushNow(scope: SettingsScope): void {
  if (!isSettingsSyncEnabled()) return;
  const cfg = getServerConfig();
  const user = useStore.getState().currentUser;
  if (!cfg.url || !user || user.open) return; // local-only / open mode: nothing to sync to
  const payload = scope === 'ui' ? snapshotUi() : snapshotViews();
  const op = mutate(
    (db, dev) => recordRecordOp(db, dev, 'setting', scope, { user_id: user.id, payload }),
    'setting',
  );
  // Remember our own write so the echo coming back from the server is ignored.
  setMeta(APPLIED_META(scope), String(op.ts));
}

// ----- inbound (called from sync after ingest) ------------------------------

/** Apply freshly-received `setting` record-ops into localStorage + the store.
 *  Skips ops we've already applied (LWW by causal ts) and is a no-op when this
 *  device has sync turned off. */
export function applyInboundSettings(fresh: RecordOp[]): void {
  if (!isSettingsSyncEnabled()) return;
  for (const op of fresh) {
    if (op.entity !== 'setting') continue;
    const applied = Number(getMeta(APPLIED_META(op.row_id)) ?? 0);
    if (op.ts <= applied) continue;
    const data = op.data as { payload?: unknown };
    if (op.row_id === 'ui') applyUi(data.payload);
    else if (op.row_id === 'views') applyViews(data.payload);
    setMeta(APPLIED_META(op.row_id), String(op.ts));
  }
}

// ----- init -----------------------------------------------------------------

/** Register the settings-changed listener so local edits get pushed. Call once at boot. */
export function initSettingsSync(): void {
  useStore.getState().setSettingsSyncEnabled(isSettingsSyncEnabled());
  onSettingsChanged((scope) => schedulePush(scope));
}
