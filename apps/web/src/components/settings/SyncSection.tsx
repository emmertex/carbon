import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CloudOff, Cloud, RefreshCw, Loader2 } from 'lucide-react';
import { syncNow, signOut as doSignOut, resetLocalDataAndReload } from '@/lib/sync';
import { type ServerConfig } from '@/lib/config';
import { LINKS } from '@/lib/links';
import { useStore } from '@/lib/store';
import { avatarInitial } from '../Avatar';
import { SettingsSection } from './SettingsSection';
import {
  SettingsToggle,
  DocLink,
  btnPrimary,
  btnSecondary,
  btnDanger,
  btnDangerSolid,
} from './controls';

/** "3 minutes ago" style relative time for the last successful sync. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Visible sync state + diagnosis. The cloud icon in the header shows the same
 *  status, but its cause only appears in a hover tooltip — useless on touch — so
 *  the actual error message is spelled out here where it can be read and acted on. */
function SyncStatusPanel() {
  const status = useStore((s) => s.syncStatus);
  const syncError = useStore((s) => s.syncError);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);

  if (status === 'error') {
    return (
      <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">
        <p className="flex items-center gap-1.5 font-medium text-danger">
          <AlertCircle size={15} /> Sync failed
        </p>
        {syncError && (
          <p className="mt-1 break-words font-mono text-xs text-text-muted">{syncError}</p>
        )}
        <p className="mt-1.5 text-text-muted">
          {lastSyncedAt
            ? `Last successful sync ${relativeTime(lastSyncedAt)}.`
            : 'This device has not completed a sync yet.'}{' '}
          Tap <strong>Sync now</strong> to retry. If projects and tasks are missing but appear on
          another device, the local copy may be out of date — use <strong>Reset local data</strong>{' '}
          below to re-download from the server.
        </p>
      </div>
    );
  }

  if (status === 'offline') {
    return (
      <div className="flex items-center gap-1.5 text-sm text-warning">
        <CloudOff size={15} /> Offline — changes will sync when you reconnect.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-sm text-text-muted">
      {status === 'syncing' ? (
        <>
          <RefreshCw size={15} className="animate-spin" /> Syncing…
        </>
      ) : (
        <>
          <Cloud size={15} />
          {lastSyncedAt ? `Synced ${relativeTime(lastSyncedAt)}` : 'Synced'}
        </>
      )}
    </div>
  );
}

/**
 * Sync server card. Signing in lives in the dedicated full-screen flow (the
 * "Login" button opens it) so credentials are never typed here — a background
 * 401 can no longer yank a half-typed form out from under the user. When signed
 * in this shows the sync controls, the auto-sync toggle, and the auth state.
 */
export function SyncSection({
  cfg,
  update,
}: {
  cfg: ServerConfig;
  update: (patch: Partial<ServerConfig>) => void;
}) {
  const currentUser = useStore((s) => s.currentUser);
  const openLogin = useStore((s) => s.openLogin);
  const baseDomain = useStore((s) => s.baseDomain);
  const signedIn = !!currentUser && !currentUser.open;

  // Inline confirm state for the two destructive actions, so neither fires on a
  // single tap. `resetting` also drives a spinner while the wipe + reload runs.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  async function signOut(eraseLocal: boolean) {
    setConfirmSignOut(false);
    await doSignOut(eraseLocal);
    if (eraseLocal) window.location.reload();
  }

  async function resetLocal() {
    setResetting(true);
    await resetLocalDataAndReload(); // reloads the page on success
  }

  return (
    <SettingsSection
      id="sync"
      testId="settings-sync"
      title="Sync server"
      description="Carbon works fully offline. Log in to a Carbon server to sync across devices. Stay logged out to keep everything local-only."
    >
      <div className="space-y-3">
        {/* Auth state sits above the controls so you can see who you're signed in
            as before toggling background sync. */}
        {signedIn && currentUser && (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white"
              style={{ background: currentUser.avatar_color || 'var(--accent)' }}
            >
              {avatarInitial(currentUser)}
            </span>
            Signed in as <span className="font-medium text-text">{currentUser.username}</span>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{currentUser.role}</span>
          </div>
        )}

        {/* Live sync status + the cause of any failure (visible, not tooltip-only). */}
        {cfg.url && signedIn && <SyncStatusPanel />}

        {/* Signed in: background-sync toggle */}
        {signedIn && (
          <SettingsToggle
            label="Sync automatically in the background"
            checked={cfg.autoSync}
            onChange={(v) => update({ autoSync: v })}
          />
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {!signedIn && (
            <button onClick={openLogin} className={btnPrimary}>
              Login
            </button>
          )}
          {signedIn && (
            <button onClick={() => void syncNow()} className={btnSecondary}>
              Sync now
            </button>
          )}
          {signedIn && !confirmSignOut && (
            <button onClick={() => setConfirmSignOut(true)} className={btnSecondary}>
              Sign out
            </button>
          )}
          {/* Workspace deletion is a hosted (multi-tenant) concept and runs its own
              email-OTC flow, so it's reachable here regardless of sign-in state. */}
          {baseDomain && (
            <Link to="/delete-account" className={btnDanger}>
              Delete account
            </Link>
          )}
        </div>

        {/* Sign-out choice: keep the local copy for offline use, or erase it. */}
        {signedIn && confirmSignOut && (
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
            <p className="font-medium text-text">Sign out of {currentUser?.username}?</p>
            <p className="mt-0.5 text-text-muted">
              Keep your tasks on this device for offline use, or erase the local copy so nothing
              is left behind.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={() => void signOut(false)} className={btnSecondary}>
                Sign out, keep local data
              </button>
              <button onClick={() => void signOut(true)} className={btnDanger}>
                Sign out &amp; erase local data
              </button>
              <button
                onClick={() => setConfirmSignOut(false)}
                className="px-2 py-2 text-sm text-text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {cfg.url && currentUser?.open && (
          <div className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium text-warning">This server has no accounts — running open.</p>
            <p className="mt-0.5 text-text-muted">
              Anyone with the URL has full access and credentials are ignored. Add a user under
              <strong> Users</strong> below (then sign in), or set <code>AUTH_USERS</code> on the
              server, to require login.
            </p>
          </div>
        )}

        {/* Recovery: throw away the local DB and re-pull from the server. Fixes a
            corrupt / half-migrated local copy (e.g. tasks present on another device
            but missing here). Only offered while signed in — otherwise there's no
            server to re-download from. */}
        {signedIn && (
          <div className="mt-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-text">Reset local data</p>
            <p className="mt-0.5 text-sm text-text-muted">
              Erases this device's local database and re-downloads everything from the server. Use
              this if projects or tasks are missing or the local copy looks wrong. Any changes made
              here that haven't synced yet will be lost.
            </p>
            {!confirmReset ? (
              <button
                onClick={() => setConfirmReset(true)}
                disabled={resetting}
                className={`mt-2 ${btnDanger}`}
              >
                Reset local data
              </button>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void resetLocal()}
                  disabled={resetting}
                  className={btnDangerSolid}
                >
                  {resetting && <Loader2 className="animate-spin" size={16} />}
                  Erase &amp; re-download
                </button>
                <button
                  onClick={() => setConfirmReset(false)}
                  disabled={resetting}
                  className="px-2 py-2 text-sm text-text-muted hover:text-text disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        <div className="pt-1">
          <DocLink href={LINKS.dataSecurity}>How your data is secured</DocLink>
        </div>
      </div>
    </SettingsSection>
  );
}
