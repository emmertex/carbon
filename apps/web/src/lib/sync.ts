import { assertSyncResponse } from "./sync-response";
import {
  getUnsyncedOps,
  pendingSyncPage,
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
} from "@carbon/core";
import {
  getDb,
  getBoundIdentity,
  getMeta,
  setMeta,
  persist,
  flushPersist,
  wipeLocalDb,
  rebindIdentity,
} from "./db";
import {
  getServerConfig,
  saveServerConfig,
  authHeaders,
  saveCurrentUser,
  defaultServerUrl,
  onServerConfigSaved,
  getCurrentUser,
  workspaceHostOf,
  getWorkspaceAuthState,
  setWorkspaceAuthState,
  clearWorkspaceSnapshotToken,
  type CurrentUser,
} from "./config";
import { identityKey, currentWorkspace, saveOfflineUser } from "./identity";
import { mutate } from "./mutate";
import { isNative } from "./platform";
import { useStore } from "./store";
import {
  uploadPendingBlobs,
  syncBlobCache,
  pendingBlobCount,
  cancelBlobRequests,
} from "./blobs";
import { backfillThumbs } from "./thumbs";
import { getNlConfig } from "./admin";
import { applyInboundSettings } from "./settings-sync";

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, "") + path;
}

// A server-URL save that switches workspaces re-binds the app so every store
// follows the new identity. Saves that don't change the workspace (a 401 that
// only clears the token, an autoSync toggle, …) must NOT rebind: the user's
// data stays visible under the sign-in gate until an explicit sign-in/out.
onServerConfigSaved((prevWs, newWs) => {
  if (prevWs !== newWs) {
    // A workspace switch re-binds every store to the new identity; once that
    // settles, decide whether to auto-restore a saved session or present the
    // sign-in gate (honouring a per-workspace sign-out-by-choice).
    void rebindIdentity().then(() => restoreSessionOrGate());
  }
});

const SYNC_EPOCH_META = "sync_epoch";

/** Locally bound sync epoch, or null if this device has never bound to a server epoch. */
export function getLocalSyncEpoch(): number | null {
  const raw = getMeta(SYNC_EPOCH_META);
  if (raw == null || raw === "") return null;
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
export function handleServerSyncEpoch(
  serverEpoch: number | null | undefined,
): boolean {
  if (serverEpoch == null || !Number.isFinite(serverEpoch) || serverEpoch < 1)
    return true;
  const epoch = Math.floor(serverEpoch);
  let local = getLocalSyncEpoch();
  if (local == null) {
    const since = Number(getMeta("last_sync_seq") ?? 0);
    const rsince = Number(getMeta("last_sync_rseq") ?? 0);
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
let authRevision = 0;
let signingOut = false;
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
    return JSON.parse(getMeta("pending_backfill") ?? "[]") as string[];
  } catch {
    return [];
  }
}
function setPendingBackfill(ids: string[]): void {
  setMeta("pending_backfill", JSON.stringify([...new Set(ids)]));
}
/** Item ids for which this sync response (re)granted us access — their subtrees
 *  should be backfilled next round. */
function grantedRoots(recordOps: RecordOp[], myUserId: string): string[] {
  const out: string[] = [];
  for (const r of recordOps) {
    if (r.entity !== "share" && r.entity !== "assignee") continue;
    const d = r.data as {
      user_id?: string;
      item_id?: string;
      deleted?: boolean;
    };
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
    const origin = isNative
      ? getServerConfig().url || defaultServerUrl()
      : window.location.origin;
    if (!origin) return;
    const res = await fetch(`${origin}/api/health`);
    if (!res.ok) return;
    const h = (await res.json()) as {
      role?: "single" | "apex" | "app" | "tenant" | "unknown";
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
      useStore
        .getState()
        .setWorkspaceLock(!!h.locked, h.locked ? (h.expiresAt ?? null) : null);
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
      if (h.role === "app") {
        saveServerConfig({
          ...getServerConfig(),
          url: "",
          username: "",
          password: "",
          token: "",
        });
        saveCurrentUser(null);
        useStore.getState().setCurrentUser(null);
        useStore.getState().setAuthRequired(false);
        useStore.getState().setLocalOnly(true);
      } else if (
        (h.role === "tenant" ||
          (h.role === "single" && !useStore.getState().localOnly)) &&
        !getServerConfig().url
      ) {
        // A workspace subdomain or single-tenant self-host syncs to (and requires
        // sign-in against) its own origin — wire it up so a fresh visit lands on the
        // sign-in gate, not an empty local app. An explicit local-only choice
        // on a single-tenant host stays detached across reloads.
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
  | "ok"
  | "open"
  | "badCredentials"
  | "error"
  | { status: "error"; message?: string }
  | { status: "needs_enrollment"; challenge: string }
  | {
      status: "needs_2fa";
      challenge: string;
      factors: { email: boolean; totp: boolean };
    };

/**
 * Exchange a password for a session token (POST /api/login, Basic auth), or return
 * an MFA challenge when the device is new / 2FA is not yet enrolled. On a full
 * success the token is persisted and the password is discarded.
 */
export async function signIn(password: string): Promise<SignInResult> {
  const cfg = getServerConfig();
  const start = JSON.stringify(cfg);
  if (!cfg.url || !cfg.username) return "badCredentials";
  const { loginWithPassword } = await import("./mfa");
  const result = await loginWithPassword(cfg.username, password);
  if (JSON.stringify(getServerConfig()) !== start) return "error";
  if (result.status === "badCredentials") return result.status;
  if (result.status === "error") return result;
  if (result.status === "open") return "open";
  if (result.status === "ok") {
    saveServerConfig({
      ...getServerConfig(),
      token: result.token,
      password: "",
    });
    setWorkspaceAuthState(workspaceHostOf(cfg.url), "in"); // sign-in re-establishes the session
    return "ok";
  }
  if (result.status === "needs_enrollment") {
    return { status: "needs_enrollment", challenge: result.challenge };
  }
  return {
    status: "needs_2fa",
    challenge: result.challenge,
    factors: result.factors,
  };
}

/** Persist a session token minted after MFA enroll/verify. */
export function saveSessionToken(token: string): void {
  saveServerConfig({ ...getServerConfig(), token, password: "" });
  setWorkspaceAuthState(workspaceHostOf(getServerConfig().url), "in"); // sign-in complete
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
 *  prompt in Settings. Erasing wipes the signed-out identity's store while the
 *  app is still bound to it; the credential clear then re-binds the app to the
 *  post-sign-out identity (device-local, or the kept offline identity — see
 *  `signOut` callers + docs/internal/a3/design.md). */
export async function signOut(eraseLocal = false): Promise<void> {
  if (signingOut) return;
  cancelBlobRequests();
  authRevision++; // invalidate sync before logout awaits, including keep-offline

  signingOut = true;
  const cfg = getServerConfig();
  const startIdentity = identityKey();
  const revision = authRevision;
  const startConfig = JSON.stringify(cfg);
  const stale = () =>
    identityKey() !== startIdentity ||
    getBoundIdentity() !== startIdentity ||
    revision !== authRevision ||
    JSON.stringify(getServerConfig()) !== startConfig;
  try {
    await rebindIdentity();
    if (stale())
      throw new Error(
        "Sign-out requires the current identity database to be ready",
      );
    const user = getCurrentUser(); // captured before the credential clear below
    const ws = currentWorkspace();
    // An explicit sign-out (erase / keep / push-&-sign-out all funnel here) records
    // this workspace as signed-out ('out') AND clears the snapshot's saved token, so
    // a later return presents the sign-in gate rather than auto-restoring any
    // surviving credential (see the safe-default auth-state record in config.ts).
    setWorkspaceAuthState(ws, "out");
    clearWorkspaceSnapshotToken(ws);
    if (cfg.url && cfg.token) {
      try {
        await fetch(joinUrl(cfg.url, "/api/logout"), {
          method: "POST",
          headers: authHeaders(cfg),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        /* best-effort; the token still expires server-side */
      }
    }
    if (stale()) return;
    // Erase under the OLD binding first — after the credential clear below, the
    // rebind would have moved this tab to the post-sign-out identity, and a wipe
    // there would hit the wrong store.
    if (eraseLocal) {
      await wipeLocalDb();
      if (stale()) return;
      saveOfflineUser(null); // nothing kept — clear any stale retained identity
    } else if (user && !user.open) {
      // Keep offline: bind the retained data to the signed-out user's identity so
      // it stays addressable while the device is detached (see identityKey). The
      // record carries the workspace, so a later URL clear doesn't orphan it.
      saveOfflineUser({ ws, id: user.id });
      // Persist any pending (debounced) work to the identity's store for offline
      // use — the rebind below is a no-op here (identity unchanged via the record),
      // so it wouldn't flush on its own.
      await flushPersist();
      if (stale()) return;
    }
    saveServerConfig({ ...getServerConfig(), token: "", password: "" });
    saveCurrentUser(null);
    useStore.getState().setCurrentUser(null);
    // Rebind: erase → local|local with flushOld=false (the store was deliberately
    // wiped — flushing the still-live in-memory DB would resurrect it). keep →
    // no-op (identity unchanged via the offline record).
    await rebindIdentity(!eraseLocal);
  } finally {
    signingOut = false;
  }
}

/**
 * Count of local work that has not reached the server yet: unsynced item ops +
 * unsynced record-ops + blobs still queued for upload (their local copy is the
 * only copy until the server has them). Used to detect unsynced work before a
 * sign-out that erases local data, so it can be warned about / pushed first.
 */
export async function countUnsyncedWork(): Promise<number> {
  let n = 0;
  try {
    const db = getDb();
    n += getUnsyncedOps(db).length;
    n += getUnsyncedRecordOps(db).length;
    n += await pendingBlobCount();
  } catch {
    /* DB not ready — treat as no unsynced work */
  }
  return n;
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
 * Decide session state on boot or workspace return (see docs/internal/a3/design.md,
 * "Per-workspace credential restore"). AUTO-RESTORE REQUIRES A POSITIVE 'in'
 * auth-state record (written on explicit sign-in) AND a saved session token for the
 * current workspace. An 'out' record OR an ABSENT record — the safe default, since
 * a storage clear removes the record — both present the sign-in gate instead, so a
 * clear can only ever gate, never produce a false signed-in. fetchIdentity then
 * 401-gates a stale/revoked token. A local-only device (no server) never gates.
 */
export async function restoreSessionOrGate(): Promise<void> {
  const cfg = getServerConfig();
  const ws = currentWorkspace();
  const state = getWorkspaceAuthState(ws);
  if (cfg.url && state === "in" && cfg.token) {
    await fetchIdentity(); // valid session → signed in; a 401 drops it and gates.
    return;
  }
  if (cfg.url) {
    // A server is configured but we can't safely auto-restore: no 'in' record
    // (absent or 'out') or no saved token — so present the sign-in gate.
    useStore.getState().setAuthRequired(true);
  } else {
    // Local-only: no sign-in situation (matches fetchIdentity's !cfg.url branch).
    useStore.getState().setAuthRequired(false);
  }
}

/**
 * Fetch the authenticated identity (/api/me) into the store. On the first login
 * (a new user id), claim all locally-captured unowned items for that user so they
 * sync with correct ownership.
 */
export async function fetchIdentity(): Promise<void> {
  if (signingOut) return;
  const revision = authRevision;
  const cancelled = () => signingOut || revision !== authRevision;
  let cfg = getServerConfig();
  if (!cfg.url) {
    // Local-only (no server): not a login situation.
    saveCurrentUser(null);
    useStore.getState().setCurrentUser(null);
    useStore.getState().setAuthRequired(false);
    return;
  }
  // Trade any legacy stored password for a session token before authenticating.
  const originalWs = currentWorkspace();
  await ensureSession();
  if (cancelled() || originalWs !== currentWorkspace()) return;
  cfg = getServerConfig();
  const start = JSON.stringify(cfg);
  try {
    const res = await fetch(joinUrl(cfg.url, "/api/me"), {
      headers: authHeaders(cfg),
    });
    if (cancelled() || JSON.stringify(getServerConfig()) !== start) return;
    if (res.status === 401) {
      // Auth missing/wrong or the session expired/was revoked — drop the dead token
      // and surface the sign-in gate.
      saveServerConfig({ ...getServerConfig(), token: "", password: "" });
      saveCurrentUser(null);
      useStore.getState().setCurrentUser(null);
      useStore.getState().setAuthRequired(true);
      return;
    }
    if (!res.ok) return; // transient; keep cached
    const user = (await res.json()) as CurrentUser;
    if (cancelled() || JSON.stringify(getServerConfig()) !== start) return;
    const prev = useStore.getState().currentUser;
    saveCurrentUser(user);
    useStore.getState().setCurrentUser(user);
    useStore.getState().setAuthRequired(false); // signed in (or open mode)
    void loadNlConfig(); // refresh the Add box's keyword/enable state

    // A real user is now signed in and the user part of the identity changed:
    // rebind first (the old identity's pending work flushes to its own store),
    // then claim any unowned (device-local capture) items for this user.
    // Via `mutate` so the claim is recorded in the mutation log like any
    // other write — a later resync can never silently drop it.
    if (!user.open && (!prev || prev.id !== user.id)) {
      await rebindIdentity();
      if (cancelled() || JSON.stringify(getServerConfig()) !== start) return;
      mutate((db, dev) => claimUnowned(db, dev, user.id), "claim");
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
  const res = await fetch(joinUrl(cfg.url, "/api/me"), {
    method: "PATCH",
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
  const res = await fetch(joinUrl(cfg.url, "/api/me"), {
    method: "PATCH",
    headers: authHeaders(cfg),
    body: JSON.stringify({ ha_person: person }),
  });
  if (!res.ok) throw new Error(`Couldn't save (${res.status})`);
  await fetchIdentity();
}

export async function syncNow(): Promise<boolean> {
  let cfg = getServerConfig();
  const store = useStore.getState();
  if (!cfg.url) {
    store.setSyncStatus("disabled");
    store.setSettingsHydrated(true); // local-only: no synced settings to wait for
    return false;
  }
  // Don't push/pull across an epoch mismatch — the server log was rebuilt.
  if (store.syncEpochMismatch) {
    store.setSyncStatus("error");
    store.setSyncError(
      "Sync server history was rebuilt — clear local cache to continue",
    );
    store.setSettingsHydrated(true);
    return false;
  }
  if (inFlight || signingOut) return false;
  inFlight = true;
  store.setSyncStatus("syncing");
  // Identity at the start of this round — if it changes before the response is
  // ingested (sign-in/out, workspace switch), the response belongs to a
  // different store and is discarded rather than ingested into the new one.
  const idAtStart = identityKey();
  const revisionAtStart = authRevision;
  const startCfg = JSON.stringify(cfg);
  const stale = (requireBinding = true) =>
    signingOut ||
    revisionAtStart !== authRevision ||
    idAtStart !== identityKey() ||
    (requireBinding && getBoundIdentity() !== idAtStart) ||
    JSON.stringify(getServerConfig()) !== startCfg;

  try {
    // Always refresh identity so credential changes take effect immediately.
    await fetchIdentity();
    if (stale(false)) return false;
    cfg = getServerConfig();
    if (!useStore.getState().currentUser) {
      // Server requires sign-in and we're not authenticated — don't push/pull. Use
      // 'disabled' (not 'idle') so a real auth failure isn't shown as healthy and
      // doesn't clear a genuine sync error (W3).
      store.setSyncStatus("disabled");
      return false;
    }
    await rebindIdentity();
    if (stale()) return false;
    let db = getDb();
    // Negotiate without writes on first bind; the server rejects stale/missing
    // generations before mutation even if a restore raced the last health check.
    const epoch = getLocalSyncEpoch();
    const pendingAfter = JSON.parse(
      getMeta("sync_pending_cursor") ?? '{"ops":0,"recordOps":0}',
    );
    const page =
      epoch == null
        ? {
            ops: [],
            recordOps: [],
            hasMore: true,
            next: pendingAfter,
            oversized: [] as string[],
          }
        : pendingSyncPage(db, SYNC_PUSH_CHUNK, undefined, pendingAfter);
    const unsynced = page.ops;
    const unsyncedRecords = page.recordOps;
    const backlog = page.hasMore;
    const since = Number(getMeta("last_sync_seq") ?? 0);
    const rsince = Number(getMeta("last_sync_rseq") ?? 0);
    // Shared items we have a grant for but no local content (access granted after we
    // synced past their ops), plus roots whose access was just (re)granted (children
    // may have been added while we couldn't see them). Server backfills the subtree.
    const me = useStore.getState().currentUser;
    const need =
      me && !me.open
        ? [
            ...new Set([
              ...missingSharedItemIds(db, me.id),
              ...getPendingBackfill(),
            ]),
          ]
        : [];

    const backfill = JSON.parse(getMeta("sync_backfill_cursor") ?? "null");
    const res = await fetch(joinUrl(cfg.url, "/api/sync"), {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify({
        since,
        rsince,
        syncEpoch: epoch ?? undefined,
        ops: unsynced,
        recordOps: unsyncedRecords,
        need,
        rosterCursor: Number(getMeta("sync_roster_cursor") ?? 0),
        backfill: backfill ?? undefined,
      }),
    });
    if (stale()) return false;
    if (!res.ok) {
      // A2: make the failure actionable. Read the server's error body (it names what
      // happened — 429 rate_limited / 413 too large / 507 quota — and how long to wait),
      // and surface it. Crucially the ops are NOT marked synced on this path (the throw
      // skips the ingest/mark below), so no client work is lost — we retry with what we
      // still have. A 429 carries retry_after_ms; the catch block re-syncs on that delay
      // instead of waiting for the next 30s poll.
      let msg = `sync failed: ${res.status}`;
      let retryAfterMs: number | undefined;
      try {
        const e = (await res.json()) as {
          error?: string;
          detail?: string;
          retry_after_ms?: number;
          syncEpoch?: number;
        };
        if (stale()) return false;
        if (
          res.status === 409 &&
          e.syncEpoch != null &&
          idAtStart === identityKey()
        )
          handleServerSyncEpoch(e.syncEpoch);
        if (e.error)
          msg = `sync failed: ${e.error}${e.detail ? ` — ${e.detail}` : ""}`;
        if (typeof e.retry_after_ms === "number" && e.retry_after_ms > 0) {
          retryAfterMs = Math.min(e.retry_after_ms, 30_000); // clamp to one poll interval
        }
      } catch {
        /* non-JSON error body — keep the status-code message */
      }
      const err = new Error(msg) as Error & { retryAfterMs?: number };
      if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    // Identity changed while the request was in flight — discard the response.
    // (The round that starts AFTER the rebind carries the new identity end to
    // end and does the real pull.)
    if (stale()) return false;
    const data = (await res.json()) as {
      ops: Op[];
      cursor: number;
      recordOps: RecordOp[];
      rcursor: number;
      users: User[];
      syncEpoch?: number;
      /** A2: the server capped this response; the cursor advanced only past what was
       *  sent, so the next sync resumes where this one stopped. */
      truncated?: boolean;
      rosterCursor?: number;
      rosterMore?: boolean;
      backfill?: {
        root: string;
        cursor: number;
        rcursor: number;
        done: boolean;
      };
      /** A2: entries rejected by server-side validation (authorization/shape) —
       *  counted here so the UI can surface them. A4: `ops_ids`/`record_ops_ids` carry
       *  the exact ids the server did NOT ingest, so the client marks only the accepted
       *  entries synced — a rejected entry stays unsynced (re-pushed next round) and is
       *  never a silent loss. */
      acknowledged?: { ops: string[]; recordOps: string[] };
      rejected?: {
        ops: number;
        recordOps: number;
        ops_ids?: string[];
        record_ops_ids?: string[];
      };
    };

    if (stale()) return false;

    assertSyncResponse(data, since, rsince);

    // Authoritative epoch check — refuse to ingest/advance cursors on mismatch.
    // First bind negotiates with an empty push. The server gates every subsequent
    // write against the negotiated generation before applying it.
    if (!handleServerSyncEpoch(data.syncEpoch ?? null)) {
      store.setSyncStatus("error");
      store.setSyncError(
        "Sync server history was rebuilt — clear local cache to continue",
      );
      return false;
    }

    // Peer catch-up may replace/close a same-identity DB while fetch awaits.
    db = getDb();
    // Each ingest owns its transaction and uses SQLite savepoints per entry.
    if (data.users?.length) for (const u of data.users) upsertUser(db, u);
    // Keep only the genuinely-new ops/records — re-sent ones (e.g. shares echoed by a
    // subtree backfill) must not re-trigger another backfill, or it loops forever.
    const pulledOps = ingestOps(db, data.ops ?? [], true);
    const pulledRecords = ingestRecordOps(db, data.recordOps ?? [], true);
    if (pulledOps.skipped.length || pulledRecords.skipped.length) {
      throw new Error(
        `Sync could not apply ${pulledOps.skipped.length + pulledRecords.skipped.length} received operations; cursors retained for retry`,
      );
    }
    const freshOps = pulledOps.fresh;
    const freshRecords = pulledRecords.fresh;
    // Apply any synced UI prefs / view filters / perspectives into localStorage + store.
    if (freshRecords.length) applyInboundSettings(freshRecords);
    // A4: mark ONLY the ops the server actually ingested as synced. A rejected entry
    // (reported by id in `rejected`) stays unsynced, so it is re-pushed on the next
    // round and its rejection is surfaced (via the count) instead of silently lost —
    // the pre-A4 code marked the whole pushed slice synced and dropped rejections.
    if (
      !data.acknowledged ||
      !Array.isArray(data.acknowledged.ops) ||
      !Array.isArray(data.acknowledged.recordOps) ||
      !data.acknowledged.ops.every((id) => typeof id === "string") ||
      !data.acknowledged.recordOps.every((id) => typeof id === "string")
    ) {
      throw new Error(
        "Sync response has no valid acknowledgements; pending work retained",
      );
    }
    const ackOps = new Set(data.acknowledged.ops);
    const ackRecords = new Set(data.acknowledged.recordOps);
    const acceptedOps = unsynced.filter((o) => ackOps.has(o.id));
    const acceptedRecs = unsyncedRecords.filter((o) => ackRecords.has(o.id));
    if (acceptedOps.length)
      markOpsSynced(
        db,
        acceptedOps.map((o) => o.id),
      );
    if (acceptedRecs.length)
      markRecordOpsSynced(
        db,
        acceptedRecs.map((o) => o.id),
      );
    // Reclaim local op-log space: prune superseded note-only ops we've already pushed
    // (synced=1). syncedOnly is mandatory here — an unsynced op hasn't reached the
    // server, so deleting it would lose it entirely. The server holds the retained
    // winner, so a pruned loser can never change our (or any peer's) converged state.
    // Gated on having just pushed a note op (the only source of new supersession), so
    // idle syncs don't scan the whole op-log.
    const pushedNoteItemIds = [
      ...new Set(
        unsynced
          .filter((o) => o.fields && "note" in o.fields)
          .map((o) => o.item_id),
      ),
    ];
    if (pushedNoteItemIds.length) {
      compactNoteOps(db, { syncedOnly: true, itemIds: pushedNoteItemIds });
    }
    if (unsyncedRecords.some((o) => o.entity === "setting")) {
      compactSettingRecordOps(db, { syncedOnly: true });
    }
    setMeta("sync_roster_cursor", String(data.rosterCursor ?? 0));
    setMeta("last_sync_seq", String(data.cursor));
    setMeta("last_sync_rseq", String(data.rcursor));

    // The `need` we sent has now been served, so reset it — then queue any roots whose
    // access was (re)granted in this response for a subtree backfill next round.
    let followUp = false;
    if (me && !me.open) {
      // Roots whose access was just (re)granted, plus items we received a *new* op for
      // but are missing their creation (e.g. moved into a subtree we can now see).
      const fresh = [
        ...grantedRoots(freshRecords, me.id),
        ...itemsMissingCreate(
          db,
          freshOps.map((o) => o.item_id),
        ),
      ];
      const remaining = data.backfill?.done
        ? need.filter((id) => id !== data.backfill!.root)
        : need;
      setMeta(
        "sync_backfill_cursor",
        JSON.stringify(data.backfill?.done ? null : (data.backfill ?? null)),
      );
      setPendingBackfill([...remaining, ...fresh]);
      followUp = getPendingBackfill().length > 0;
    }

    setMeta(
      "sync_pending_cursor",
      JSON.stringify(backlog ? page.next : { ops: 0, recordOps: 0 }),
    );
    await persist();
    if (stale()) return false;
    await uploadPendingBlobs();
    if (stale()) return false;
    db = getDb();
    store.setSyncStatus("idle");
    // Blob housekeeping runs detached: fetching thumbnails / pruning the cache can
    // take a while on a big workspace and must not hold the sync status at
    // "syncing" or delay the UI bump below. Failures are logged, never fatal.
    const changed = freshOps.length > 0 || freshRecords.length > 0;
    void (async () => {
      const eager = getServerConfig().blobFetch === "all";
      if (stale()) return;
      await syncBlobCache(getDb());
      if (stale()) return;
      // Notes written before thumbnails existed (or imported) get one on the first
      // sync that can see their image — cache-only unless we're fetching everything.
      // Only worth re-scanning when something actually arrived (or on the first
      // sync of the session); an idle 30s poll shouldn't re-walk every note whose
      // source image simply isn't cached on this device.
      if (changed || !backfilledThisSession) {
        backfilledThisSession = true;
        await backfillThumbs(getDb(), eager);
      }
    })().catch((error) => {
      if (!stale()) console.warn("[carbon] blob housekeeping failed:", error);
    });
    store.setLastSyncedAt(Date.now());
    store.bump();
    if (
      page.oversized.length ||
      (data.rejected && (data.rejected.ops > 0 || data.rejected.recordOps > 0))
    ) {
      store.setSyncError(
        `Server rejected ${(data.rejected?.ops ?? 0) + (data.rejected?.recordOps ?? 0) + page.oversized.length} pending operations; work remains local. Check access or correct the data before retrying.`,
      );
      store.setSyncStatus("error");
      if (backlog)
        setTimeout(() => {
          if (!stale()) void syncNow();
        }, 200); // next bounded SQL page, never this rejected prefix
      return false;
    }
    // More pending ops than one chunk holds: go straight round again. This can't spin —
    // what we just pushed is now marked synced, so every round strictly drains the
    // backlog — so it deliberately doesn't consume the backfill follow-up budget.
    if (backlog) {
      followUpDepth = 0;
      setTimeout(() => {
        if (!stale()) void syncNow();
      }, 200);
      return true;
    }
    // A2: the server capped this response (op/byte/scan budget). The cursor advanced
    // only past what was actually sent, so go straight round again to drain the rest.
    // This can't spin: each round strictly advances the cursor past the ops it sent.
    if (data.truncated || data.rosterMore) {
      followUpDepth = 0;
      setTimeout(() => {
        if (!stale()) void syncNow();
      }, 200);
      return true;
    }
    // A2: server-side validation rejected some pushed entries. They were NOT ingested,
    // so our local copies remain unsynced and will be re-pushed — surface the count so
    // the failure is visible rather than silently dropped.
    if (
      data.rejected &&
      (data.rejected.ops > 0 || data.rejected.recordOps > 0)
    ) {
      console.warn(
        "[carbon] sync rejected by server:",
        `${data.rejected.ops} ops, ${data.rejected.recordOps} recordOps`,
      );
    }
    // Newly-granted roots are queued; sync again shortly to pull their subtrees in.
    if (followUp && followUpDepth < MAX_FOLLOWUP_ROUNDS) {
      followUpDepth++;
      setTimeout(() => {
        if (!stale()) void syncNow();
      }, 500);
    } else {
      if (followUp)
        console.warn(
          "[carbon] backfill follow-up cap reached; will retry next sync",
        );
      followUpDepth = 0;
    }
    return true;
  } catch (err) {
    if (stale()) return false;
    // Surface the cause — a bare swallow here makes "Sync Error" undiagnosable.
    console.error("[carbon] sync failed:", err);
    useStore
      .getState()
      .setSyncError(err instanceof Error ? err.message : String(err));
    useStore.getState().setSyncStatus(navigator.onLine ? "error" : "offline");
    // A2: the server told us to back off (429). Re-sync on that delay (ops are still
    // unsynced) instead of waiting for the next 30s poll — the retry is what drains
    // once the rate window clears, without losing any pending work.
    const retryAfterMs = (err as { retryAfterMs?: number } | null)
      ?.retryAfterMs;
    if (retryAfterMs && navigator.onLine) {
      setTimeout(() => {
        if (!stale()) void syncNow();
      }, retryAfterMs);
    }
    return false;
  } finally {
    inFlight = false;
    // The first sync attempt has resolved (pulled synced settings, or determined we
    // can't) — let the first-load complexity picker proceed.
    if (!stale()) useStore.getState().setSettingsHydrated(true);
  }
}

/** Wire up periodic + connectivity-driven sync. Call once at startup. */
export function startSyncLoop(): void {
  window.addEventListener("online", () => void syncNow());
  setInterval(() => {
    const cfg = getServerConfig();
    if (cfg.url && cfg.autoSync && navigator.onLine) void syncNow();
  }, 30_000);
}
