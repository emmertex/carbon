import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CloudOff, Cloud, RefreshCw, Loader2 } from 'lucide-react';
import { blobRefIndex } from '@carbon/core';
import { syncNow, signOut as doSignOut, resetLocalDataAndReload } from '@/lib/sync';
import { type BlobFetchMode, type ServerConfig } from '@/lib/config';
import { blobCacheBytes, flushBlobCache, syncBlobCache } from '@/lib/blobs';
import { getDb } from '@/lib/db';
import { LINKS } from '@/lib/links';
import { useStore } from '@/lib/store';
import { avatarInitial } from '../Avatar';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SettingsSection } from './SettingsSection';
import {
  SettingsToggle,
  DocLink,
  inputCls,
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / 1024 / 1024;
  return mb < 1 ? `${Math.round(n / 1024)} KB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * How much of the workspace's binary content this device pulls down ahead of time.
 *
 * Notes with images and file attachments dwarf the item graph, so the three modes
 * trade data and disk against how much is ready before you ask for it. The default
 * (thumbnails) is the useful middle: note lists render complete and offline for
 * kilobytes, while the full-size photos behind them wait until opened. Whatever
 * isn't prefetched still downloads on first display — the choice is about timing,
 * not availability.
 */
function BlobCacheControls({
  cfg,
  update,
}: {
  cfg: ServerConfig;
  update: (patch: Partial<ServerConfig>) => void;
}) {
  const [used, setUsed] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | 'flush' | 'download'>(null);
  const [flushMsg, setFlushMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void blobCacheBytes().then(setUsed);
  }, []);
  useEffect(refresh, [refresh]);

  async function flush() {
    setBusy('flush');
    setFlushMsg(null);
    try {
      // Holds back pending uploads always, and thumbnails outside On Load — see
      // flushBlobCache. Say which, so a flush that frees nothing doesn't read as a
      // dead button.
      const r = await flushBlobCache(blobRefIndex(getDb()).thumbs);
      if (r.freed > 0) {
        setFlushMsg(`Freed ${formatBytes(r.freed)} from ${r.dropped} file${r.dropped === 1 ? '' : 's'}.`);
      } else if (r.keptPending > 0) {
        setFlushMsg(
          `Nothing to clear — ${r.keptPending} file${r.keptPending === 1 ? " hasn't" : "s haven't"} uploaded to the server yet, so this device holds the only copy.`,
        );
      } else if (r.keptThumbs > 0) {
        setFlushMsg(
          'Nothing to clear — only thumbnails are cached, and they stay so note lists keep their pictures. Switch to On Load to drop those too.',
        );
      } else {
        setFlushMsg('Cache is already empty.');
      }
      refresh();
    } finally {
      setBusy(null);
    }
  }

  /** Run the prefetch pass this mode would normally do on the next sync. */
  async function prefetchNow() {
    setBusy('download');
    try {
      await syncBlobCache(getDb());
      refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-border p-3">
      <p className="text-sm font-medium text-text">Images &amp; attachments</p>
      {/* The segment labels are deliberately one or two words, so what each one
          actually does is spelled out here rather than in a tooltip nobody on a
          touch screen can reach. */}
      <p className="mt-0.5 text-sm text-text-muted">
        Note images and attachments can be large. Choose what this device downloads ahead of
        time: <strong className="font-medium text-text">On Load</strong> nothing,{' '}
        <strong className="font-medium text-text">Thumbnails</strong> just the small previews
        note lists show, <strong className="font-medium text-text">All</strong> every image and
        attachment. Whatever isn&apos;t downloaded in advance still arrives the first time you
        open it.
      </p>
      <SegmentedControl<BlobFetchMode>
        className="mt-2"
        value={cfg.blobFetch}
        onChange={(v) => update({ blobFetch: v })}
        options={[
          {
            value: 'on-demand',
            label: 'On Load',
            title: 'Download nothing in advance — images and thumbnails arrive as you view them',
          },
          {
            value: 'thumbnails',
            label: 'Thumbnails',
            title:
              'Always download note thumbnails so lists render offline; full-size images arrive when opened',
          },
          {
            value: 'all',
            label: 'All',
            title: 'Keep a full offline copy of every image and attachment',
          },
        ]}
      />

      {cfg.blobFetch !== 'all' && (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-text-muted">
          Keep up to
          <input
            type="number"
            min={0}
            step={50}
            className={`${inputCls} w-24`}
            value={cfg.blobCacheMb}
            onChange={(e) =>
              update({ blobCacheMb: Math.max(0, Math.round(Number(e.target.value) || 0)) })
            }
          />
          MB — least-recently-opened files are dropped first
          {cfg.blobCacheMb === 0 && (
            <span className="text-xs text-text-faint">(0 = never drop anything)</span>
          )}
        </label>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-sm text-text-muted">
          Cached now: <span className="font-medium text-text">{used === null ? '…' : formatBytes(used)}</span>
        </span>
        <button onClick={() => void flush()} disabled={busy !== null} className={btnSecondary}>
          {busy === 'flush' && <Loader2 className="animate-spin" size={16} />}
          Clear cached files
        </button>
        {cfg.blobFetch !== 'on-demand' && (
          <button
            onClick={() => void prefetchNow()}
            disabled={busy !== null}
            className={btnSecondary}
          >
            {busy === 'download' && <Loader2 className="animate-spin" size={16} />}
            Download now
          </button>
        )}
      </div>

      {flushMsg && <p className="mt-1.5 text-xs text-text-muted">{flushMsg}</p>}
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

  // Inline confirm state for destructive actions, so none fire on a single tap.
  // `confirmReset` covers both signed-in "Reset local data" and unsigned-in
  // "Delete local data". `resetting` drives a spinner while the wipe + reload runs.
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

        {/* Blob (image/attachment) caching policy. Gated on a configured server
            rather than on being signed in: local-only devices already hold every
            byte they have, so there's nothing to fetch or re-fetch. */}
        {!!cfg.url && <BlobCacheControls cfg={cfg} update={update} />}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {!signedIn && (
            <button onClick={openLogin} className={btnPrimary}>
              Login
            </button>
          )}
          {/* Hosted signup — same multi-tenant path as landing / SignInGate. */}
          {!signedIn && baseDomain && (
            <Link to="/signup" className={btnSecondary}>
              Create Account
            </Link>
          )}
          {!signedIn && !confirmReset && (
            <button
              onClick={() => setConfirmReset(true)}
              disabled={resetting}
              className={btnDanger}
            >
              Delete local data
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
              email-OTC flow. Only offered while signed in — unsigned-in users get
              Create Account / Delete local data above instead. */}
          {signedIn && baseDomain && (
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

        {/* Unsigned-in wipe: erase local data with no server to re-download from. */}
        {!signedIn && confirmReset && (
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
            <p className="font-medium text-text">Delete all local data?</p>
            <p className="mt-0.5 text-text-muted">
              Erases this device&apos;s local database and attachments. This cannot be undone.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void resetLocal()}
                disabled={resetting}
                className={btnDangerSolid}
              >
                {resetting && <Loader2 className="animate-spin" size={16} />}
                Delete local data
              </button>
              <button
                onClick={() => setConfirmReset(false)}
                disabled={resetting}
                className="px-2 py-2 text-sm text-text-muted hover:text-text disabled:opacity-50"
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
