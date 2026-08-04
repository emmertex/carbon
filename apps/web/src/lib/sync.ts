import {
  getUnsyncedOps,
  markOpsSynced,
  compactNoteOps,
  compactSettingRecordOps,
  ingestOps,
  getUnsyncedRecordOps,
  markRecordOpsSynced,
  ingestRecordOps,
  upsertUser,
  claimUnowned,
  missingSharedItemIds,
  itemsMissingCreate,
  type Op,
  type RecordOp,
  type User,
} from '@carbon/core';
import { getDb, getDeviceId, getMeta, setMeta, persist, schedulePersist, wipeLocalDb } from './db';
import {
  getServerConfig,
  saveServerConfig,
  authHeaders,
  saveCurrentUser,
  defaultServerUrl,
  type CurrentUser,
} from './config';
import { isNative } from './platform';
import { useStore } from './store';
import { uploadPendingBlobs, syncBlobCache } from './blobs';
import { backfillThumbs } from './thumbs';
import { getNlConfig } from './admin';
import { applyInboundSettings } from './settings-sync';

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + path;
}

const SYNC_EPOCH_META = 'sync_epoch';

/** Locally bound sync epoch, or null if this device has never bound to a server epoch. */
export function getLocalSyncEpoch(): number | null {
  const raw = getMeta(SYNC_EPOCH_META);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function bindSyncEpoch(epoch: number): void {
  setMeta(SYNC_EPOCH_META, String(Math.max(1, Math.floor(epoch))));
}

/**
 * Compare a server-advertised syncEpoch to the local bind.
 * - Fresh device (no bind, cursors at 0) → bind without alarming.
 * - Already-synced device with no bind (pre-epoch clients) → treat as epoch 1.
 * - Local ≠ server → set mismatch gate and return false (caller must not ingest).
 * - Match → clear any stale mismatch flag, return true.
 * - null/undefined server epoch → no-op (apex/app hosts).
 */
export function handleServerSyncEpoch(serverEpoch: number | null | undefined): boolean {
  if (serverEpoch == null || !Number.isFinite(serverEpoch) || serverEpoch < 1) return true;
  const epoch = Math.floor(serverEpoch);
  let local = getLocalSyncEpoch();
  if (local == null) {
    const since = Number(getMeta('last_sync_seq') ?? 0);
    const rsince = Number(getMeta('last_sync_rseq') ?? 0);
    if (since > 0 || rsince > 0) {
      // Pre-epoch client that already syncs: bind as epoch 1 so a server bump is visible.
      local = 1;
      bindSyncEpoch(1);
    } else {
      bindSyncEpoch(epoch);
      useStore.getState().setSyncEpochMismatch(false);
      return true;
    }
  }
  if (local !== epoch) {
    useStore.getState().setSyncEpochMismatch(true, epoch);
    return false;
  }
  useStore.getState().setSyncEpochMismatch(false);
  return true;
}

/** Refresh the Add box's NL keyword/enable state from the server (best-effort). */
export async function loadNlConfig(): Promise<void> {
  if (!getServerConfig().url) return;
  try {
    const cfg = await getNlConfig();
    useStore.getState().setNlConfig(cfg);
  } catch {
    /* not configured / offline — keep defaults (disabled) */
  }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
/** One thumbnail backfill sweep per session even if no sync ever brings changes. */
let backfilledThisSession = false;
// Backstop for the backfill follow-up chain. The fresh-ops-only logic already makes it
// self-terminating, but cap consecutive auto-follow-ups so no pathological case can
// spin the 500ms loop forever (M7).
let followUpDepth = 0;
const MAX_FOLLOWUP_ROUNDS = 8;
/** Ops (and record-ops) pushed per request. The server caps a sync push (MAX_SYNC_BATCH,
 *  10k per array) so no single request can queue unbounded work; a client that had been
 *  offline long enough to exceed that would otherwise be stuck failing forever, so drain
 *  in chunks and sync again immediately until the backlog is gone. */
const SYNC_PUSH_CHUNK = 2500;

// Roots to re-request a full-subtree backfill for, because access to them was just
// (re)granted — their children may have been added while we couldn't see them and
// the monotonic op-cursor has already moved past those ops. Persisted so the request
// survives a reload; cleared once served.
function getPendingBackfill(): string[] {
  try {
    return JSON.parse(getMeta('pending_backfill') ?? '[]') as string[];
  } catch {
    return [];
  }
}
function setPendingBackfill(ids: string[]): void {
  setMeta('pending_backfill', JSON.stringify([...new Set(ids)]));
}
/** Item ids for which this sync response (re)granted us access — their subtrees
 *  should be backfilled next round. */
function grantedRoots(recordOps: RecordOp[], myUserId: string): string[] {
  const out: string[] = [];
  for (const r of recordOps) {
    if (r.entity !== 'share' && r.entity !== 'assignee') continue;
    const d = r.data as { user_id?: string; item_id?: string; deleted?: boolean };
    if (d.user_id === myUserId && !d.deleted && d.item_id) out.push(d.item_id);
  }
  return out;
}

/**
 * Ask the current origin what it is (apex landing / tenant workspace / unknown /
 * single-tenant self-host) so the UI can show the right entry screen. Hits the
 * current origin, independent of any configured sync URL — except on native shells
 * (Capacitor/Tauri), where the app isn't served from the real server's origin
 * (Capacitor uses https://localhost, Tauri a tauri:// scheme), so we ask the
 * configured (or default hosted) server instead, purely to learn its version.
 */
export async function fetchHostInfo(): Promise<void> {
  try {
    const origin = isNative ? getServerConfig().url || defaultServerUrl() : window.location.origin;
    if (!origin) return;
    const res = await fetch(`${origin}/api/health`);
    if (!res.ok) return;
    const h = (await res.json()) as {
      role?: 'single' | 'apex' | 'app' | 'tenant' | 'unknown';
      baseDomain?: string | null;
      appHost?: string | null;
      locked?: boolean;
      expiresAt?: string | null;
      version?: string;
      syncEpoch?: number | null;
    };
    if (h.role) {
      useStore.getState().setHostInfo({
        role: h.role,
        baseDomain: h.baseDomain ?? null,
        appHost: h.appHost ?? null,
        version: h.version ?? null,
      });
      // expiresAt is only present on /api/health while locked (avoids leaking expiry).
      useStore.getState().setWorkspaceLock(!!h.locked, h.locked ? (h.expiresAt ?? null) : null);
      // Early mismatch detection before the next sync poll (authoritative check
      // still happens on /api/sync). Skip on apex/app where syncEpoch is null.
      if (h.syncEpoch != null) handleServerSyncEpoch(h.syncEpoch);
      // The role-driven server-config wiring below only makes sense when `origin`
      // is where the app is actually served from (the browser/PWA case) — on native
      // it's just the sync target, and role there doesn't mean the same thing (e.g.
      // the default hosted server IS the 'app' offline host at the origin level).
      if (isNative) return;
      // The dedicated offline host never syncs — detach from any server so it's a
      // pure local-first PWA, and remember the choice for this origin.
      if (h.role === 'app') {
        saveServerConfig({ ...getServerConfig(), url: '', username: '', password: '', token: '' });
        saveCurrentUser(null);
        useStore.getState().setCurrentUser(null);
        useStore.getState().setAuthRequired(false);
        useStore.getState().setLocalOnly(true);
      } else if ((h.role === 'tenant' || h.role === 'single') && !getServerConfig().url) {
        // A workspace subdomain or single-tenant self-host syncs to (and requires
        // sign-in against) its own origin — wire it up so a fresh visit lands on the
        // sign-in gate, not an empty local app.
        saveServerConfig({ ...getServerConfig(), url: window.location.origin });
      }
    }
  } catch {
    /* offline — leave hostRole null; the app falls back to normal behaviour */
  }
}

/** Debounced background sync, triggered after mutations. */
export function scheduleSync(): void {
  const cfg = getServerConfig();
  if (!cfg.url || !cfg.autoSync) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncNow(), 800);
}

export type SignInResult =
  | 'ok'
  | 'open'
  | 'badCredentials'
  | 'error'
  | { status: 'needs_enrollment'; challenge: string }
  | { status: 'needs_2fa'; challenge: string; factors: { email: boolean; totp: boolean } };

/**
 * Exchange a password for a session token (POST /api/login, Basic auth), or return
 * an MFA challenge when the device is new / 2FA is not yet enrolled. On a full
 * success the token is persisted and the password is discarded.
 */
export async function signIn(password: string): Promise<SignInResult> {
  const cfg = getServerConfig();
  if (!cfg.url || !cfg.username) return 'badCredentials';
  const { loginWithPassword } = await import('./mfa');
  const result = await loginWithPassword(cfg.username, password);
  if (result.status === 'badCredentials' || result.status === 'error') return result.status;
  if (result.status === 'open') return 'open';
  if (result.status === 'ok') {
    saveServerConfig({ ...getServerConfig(), token: result.token, password: '' });
    return 'ok';
  }
  if (result.status === 'needs_enrollment') {
    return { status: 'needs_enrollment', challenge: result.challenge };
  }
  return {
    status: 'needs_2fa',
    challenge: result.challenge,
    factors: result.factors,
  };
}

/** Persist a session token minted after MFA enroll/verify. */
export function saveSessionToken(token: string): void {
  saveServerConfig({ ...getServerConfig(), token, password: '' });
}

/**
 * Migrate a legacy persisted password (from before session tokens) into a token,
 * wiping the plaintext. No-op once a token exists or there's nothing to exchange.
 */
async function ensureSession(): Promise<void> {
  const cfg = getServerConfig();
  if (cfg.token || !cfg.url || !cfg.username || !cfg.password) return;
  await signIn(cfg.password);
}

/** Sign out: revoke the session server-side and drop all local credentials.
 *  Local data is left in place unless `eraseLocal` is set — see the sign-out
 *  prompt in Settings. When erasing, the caller reloads the app after this
 *  resolves so it comes back up on an empty, local-only database. */
export async function signOut(eraseLocal = false): Promise<void> {
  const cfg = getServerConfig();
  if (cfg.url && cfg.token) {
    try {
      await fetch(joinUrl(cfg.url, '/api/logout'), { method: 'POST', headers: authHeaders(cfg) });
    } catch {
      /* best-effort; the token still expires server-side */
    }
  }
  saveServerConfig({ ...getServerConfig(), token: '', password: '' });
  saveCurrentUser(null);
  useStore.getState().setCurrentUser(null);
  if (eraseLocal) await wipeLocalDb();
}

/**
 * Discard the entire local database and reload so the app re-pulls everything
 * fresh from the server. Signed-in credentials (in localStorage) are kept, so the
 * reload lands signed in and a full sync repopulates projects/tasks. This is the
 * recovery path for a corrupt or half-migrated local DB — the server copy is the
 * source of truth. Callers must confirm with the user first: any local changes not
 * yet pushed to the server are discarded. */
export async function resetLocalDataAndReload(): Promise<void> {
  await wipeLocalDb();
  window.location.reload();
}

/**
 * Fetch the authenticated identity (/api/me) into the store. On the first login
 * (a new user id), claim all locally-captured unowned items for that user so they
 * sync with correct ownership.
 */
export async function fetchIdentity(): Promise<void> {
  const cfg = getServerConfig();
  if (!cfg.url) {
    // Local-only (no server): not a login situation.
    saveCurrentUser(null);
    useStore.getState().setCurrentUser(null);
    useStore.getState().setAuthRequired(false);
    return;
  }
  // Trade any legacy stored password for a session token before authenticating.
  await ensureSession();
  try {
    const res = await fetch(joinUrl(cfg.url, '/api/me'), { headers: authHeaders(getServerConfig()) });
    if (res.status === 401) {
      // Auth missing/wrong or the session expired/was revoked — drop the dead token
      // and surface the sign-in gate.
      saveServerConfig({ ...getServerConfig(), token: '', password: '' });
      saveCurrentUser(null);
      useStore.getState().setCurrentUser(null);
      useStore.getState().setAuthRequired(true);
      return;
    }
    if (!res.ok) return; // transient; keep cached
    const user = (await res.json()) as CurrentUser;
    const prev = useStore.getState().currentUser;
    saveCurrentUser(user);
    useStore.getState().setCurrentUser(user);
    useStore.getState().setAuthRequired(false); // signed in (or open mode)
    void loadNlConfig(); // refresh the Add box's keyword/enable state

    // Claim local items only when signing in as a *real* account (not the open
    // server's synthetic 'local' identity).
    if (!user.open && (!prev || prev.id !== user.id)) {
      const claimed = claimUnowned(getDb(), getDeviceId(), user.id);
      if (claimed > 0) {
        schedulePersist();
        useStore.getState().bump();
      }
    }
  } catch {
    /* offline / unreachable — keep cached identity */
  }
}

/** Update the signed-in user's own profile (display name + avatar). */
export async function updateProfile(patch: {
  display_name?: string | null;
  avatar_color?: string | null;
  avatar_initial?: string | null;
  plan_startup_min?: number | null;
  plan_default_estimate_min?: number | null;
}): Promise<void> {
  const cfg = getServerConfig();
  if (!cfg.url) return;
  const res = await fetch(joinUrl(cfg.url, '/api/me'), {
    method: 'PATCH',
    headers: authHeaders(cfg),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Couldn't save profile (${res.status})`);
  await fetchIdentity();
  void syncNow(); // propagate the roster change to peers
}

/** Link this Carbon user to a Home Assistant person entity (for geo webhooks). */
export async function updateHaPerson(person: string | null): Promise<void> {
  const cfg = getServerConfig();
  if (!cfg.url) return;
  const res = await fetch(joinUrl(cfg.url, '/api/me'), {
    method: 'PATCH',
    headers: authHeaders(cfg),
    body: JSON.stringify({ ha_person: person }),
  });
  if (!res.ok) throw new Error(`Couldn't save (${res.status})`);
  await fetchIdentity();
}

export async function syncNow(): Promise<boolean> {
  const cfg = getServerConfig();
  const store = useStore.getState();
  if (!cfg.url) {
    store.setSyncStatus('disabled');
    store.setSettingsHydrated(true); // local-only: no synced settings to wait for
    return false;
  }
  // Don't push/pull across an epoch mismatch — the server log was rebuilt.
  if (store.syncEpochMismatch) {
    store.setSyncStatus('error');
    store.setSyncError('Sync server history was rebuilt — clear local cache to continue');
    store.setSettingsHydrated(true);
    return false;
  }
  if (inFlight) return false;
  inFlight = true;
  store.setSyncStatus('syncing');

  try {
    // Always refresh identity so credential changes take effect immediately.
    await fetchIdentity();
    if (!useStore.getState().currentUser) {
      // Server requires sign-in and we're not authenticated — don't push/pull. Use
      // 'disabled' (not 'idle') so a real auth failure isn't shown as healthy and
      // doesn't clear a genuine sync error (W3).
      store.setSyncStatus('disabled');
      return false;
    }
    const db = getDb();
    const pendingOps = getUnsyncedOps(db);
    const pendingRecords = getUnsyncedRecordOps(db);
    // Push at most one chunk of each; the rest go out on the follow-up round below.
    const unsynced = pendingOps.slice(0, SYNC_PUSH_CHUNK);
    const unsyncedRecords = pendingRecords.slice(0, SYNC_PUSH_CHUNK);
    const backlog =
      pendingOps.length > unsynced.length || pendingRecords.length > unsyncedRecords.length;
    const since = Number(getMeta('last_sync_seq') ?? 0);
    const rsince = Number(getMeta('last_sync_rseq') ?? 0);
    // Shared items we have a grant for but no local content (access granted after we
    // synced past their ops), plus roots whose access was just (re)granted (children
    // may have been added while we couldn't see them). Server backfills the subtree.
    const me = useStore.getState().currentUser;
    const need =
      me && !me.open
        ? [...new Set([...missingSharedItemIds(db, me.id), ...getPendingBackfill()])]
        : [];

    const res = await fetch(joinUrl(cfg.url, '/api/sync'), {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify({ since, rsince, ops: unsynced, recordOps: unsyncedRecords, need }),
    });
    if (!res.ok) throw new Error(`sync failed: ${res.status}`);
    const data = (await res.json()) as {
      ops: Op[];
      cursor: number;
      recordOps: RecordOp[];
      rcursor: number;
      users: User[];
      syncEpoch?: number;
    };

    // Authoritative epoch check — refuse to ingest/advance cursors on mismatch.
    // Note: we may have already pushed unsynced ops in this request; that is OK for
    // a first bind, but after a server rebuild the client should wipe before pushing.
    // Health usually surfaces the mismatch first so this path is a safety net.
    if (!handleServerSyncEpoch(data.syncEpoch ?? null)) {
      store.setSyncStatus('error');
      store.setSyncError('Sync server history was rebuilt — clear local cache to continue');
      return false;
    }

    // Each ingest opens its own transaction; don't nest (sql.js has no savepoints).
    if (data.users?.length) for (const u of data.users) upsertUser(db, u);
    // Keep only the genuinely-new ops/records — re-sent ones (e.g. shares echoed by a
    // subtree backfill) must not re-trigger another backfill, or it loops forever.
    const freshOps = data.ops?.length ? ingestOps(db, data.ops, true) : [];
    const freshRecords = data.recordOps?.length ? ingestRecordOps(db, data.recordOps, true) : [];
    // Apply any synced UI prefs / view filters / perspectives into localStorage + store.
    if (freshRecords.length) applyInboundSettings(freshRecords);
    if (unsynced.length) markOpsSynced(db, unsynced.map((o) => o.id));
    if (unsyncedRecords.length) markRecordOpsSynced(db, unsyncedRecords.map((o) => o.id));
    // Reclaim local op-log space: prune superseded note-only ops we've already pushed
    // (synced=1). syncedOnly is mandatory here — an unsynced op hasn't reached the
    // server, so deleting it would lose it entirely. The server holds the retained
    // winner, so a pruned loser can never change our (or any peer's) converged state.
    // Gated on having just pushed a note op (the only source of new supersession), so
    // idle syncs don't scan the whole op-log.
    const pushedNoteItemIds = [
      ...new Set(
        unsynced
          .filter((o) => o.fields && 'note' in o.fields)
          .map((o) => o.item_id),
      ),
    ];
    if (pushedNoteItemIds.length) {
      compactNoteOps(db, { syncedOnly: true, itemIds: pushedNoteItemIds });
    }
    if (unsyncedRecords.some((o) => o.entity === 'setting')) {
      compactSettingRecordOps(db, { syncedOnly: true });
    }
    setMeta('last_sync_seq', String(data.cursor));
    setMeta('last_sync_rseq', String(data.rcursor));

    // The `need` we sent has now been served, so reset it — then queue any roots whose
    // access was (re)granted in this response for a subtree backfill next round.
    let followUp = false;
    if (me && !me.open) {
      // Roots whose access was just (re)granted, plus items we received a *new* op for
      // but are missing their creation (e.g. moved into a subtree we can now see).
      const fresh = [
        ...grantedRoots(freshRecords, me.id),
        ...itemsMissingCreate(db, freshOps.map((o) => o.item_id)),
      ];
      setPendingBackfill(fresh);
      followUp = fresh.length > 0;
    }

    await persist();
    await uploadPendingBlobs();
    store.setSyncStatus('idle');
    // Blob housekeeping runs detached: fetching thumbnails / pruning the cache can
    // take a while on a big workspace and must not hold the sync status at
    // "syncing" or delay the UI bump below. Failures are logged, never fatal.
    const changed = freshOps.length > 0 || freshRecords.length > 0;
    void (async () => {
      const eager = getServerConfig().blobFetch === 'all';
      await syncBlobCache(db);
      // Notes written before thumbnails existed (or imported) get one on the first
      // sync that can see their image — cache-only unless we're fetching everything.
      // Only worth re-scanning when something actually arrived (or on the first
      // sync of the session); an idle 30s poll shouldn't re-walk every note whose
      // source image simply isn't cached on this device.
      if (changed || !backfilledThisSession) {
        backfilledThisSession = true;
        await backfillThumbs(db, eager);
      }
    })();
    store.setLastSyncedAt(Date.now());
    store.bump();
    // More pending ops than one chunk holds: go straight round again. This can't spin —
    // what we just pushed is now marked synced, so every round strictly drains the
    // backlog — so it deliberately doesn't consume the backfill follow-up budget.
    if (backlog) {
      followUpDepth = 0;
      setTimeout(() => void syncNow(), 200);
      return true;
    }
    // Newly-granted roots are queued; sync again shortly to pull their subtrees in.
    if (followUp && followUpDepth < MAX_FOLLOWUP_ROUNDS) {
      followUpDepth++;
      setTimeout(() => void syncNow(), 500);
    } else {
      if (followUp) console.warn('[carbon] backfill follow-up cap reached; will retry next sync');
      followUpDepth = 0;
    }
    return true;
  } catch (err) {
    // Surface the cause — a bare swallow here makes "Sync Error" undiagnosable.
    console.error('[carbon] sync failed:', err);
    useStore.getState().setSyncError(err instanceof Error ? err.message : String(err));
    useStore.getState().setSyncStatus(navigator.onLine ? 'error' : 'offline');
    return false;
  } finally {
    inFlight = false;
    // The first sync attempt has resolved (pulled synced settings, or determined we
    // can't) — let the first-load complexity picker proceed.
    useStore.getState().setSettingsHydrated(true);
  }
}

/** Wire up periodic + connectivity-driven sync. Call once at startup. */
export function startSyncLoop(): void {
  window.addEventListener('online', () => void syncNow());
  setInterval(() => {
    const cfg = getServerConfig();
    if (cfg.url && cfg.autoSync && navigator.onLine) void syncNow();
  }, 30_000);
}
