import { useState } from 'react';
import { History, Download, RefreshCw, WifiOff, Loader2 } from 'lucide-react';
import { useStore } from '@/lib/store';
import {
  resetLocalDataAndReload,
  signOut,
  getLocalSyncEpoch,
} from '@/lib/sync';
import { exportBackup } from '@/lib/backup';
import { getServerConfig, saveServerConfig } from '@/lib/config';
import { btnPrimary, btnSecondary, btnDanger } from './settings/controls';

/**
 * Full-page gate when the sync server's op-log epoch no longer matches this
 * device's bound epoch (operator rebuilt the server changelog). Incremental sync
 * cannot continue; the user must download a salvage backup, wipe+re-pull, or
 * detach and stay offline on the old local DB.
 */
export function SyncEpochGate() {
  const serverEpoch = useStore((s) => s.serverSyncEpoch);
  const localEpoch = getLocalSyncEpoch();
  const [busy, setBusy] = useState<'download' | 'wipe' | 'offline' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);

  async function downloadBackup() {
    setBusy('download');
    setMsg(null);
    try {
      await exportBackup();
      setMsg('Backup downloaded. You can clear the cache safely once the file is saved.');
    } catch {
      setMsg('Download failed — try again before wiping local data.');
    } finally {
      setBusy(null);
    }
  }

  async function wipeAndRedownload() {
    setBusy('wipe');
    setMsg(null);
    try {
      await resetLocalDataAndReload();
    } catch {
      setBusy(null);
      setMsg('Could not clear local cache.');
    }
  }

  async function goOffline() {
    setBusy('offline');
    setMsg(null);
    try {
      await signOut(false);
      // Detach from the sync server so auto-sync stops; keep the local DB as-is.
      saveServerConfig({
        ...getServerConfig(),
        url: '',
        username: '',
        password: '',
        token: '',
        autoSync: false,
      });
      useStore.getState().setLocalOnly(true);
      useStore.getState().setSyncEpochMismatch(false);
      useStore.getState().setAuthRequired(false);
      useStore.getState().setSyncStatus('disabled');
      useStore.getState().setSyncError(null);
    } catch {
      setMsg('Could not switch to offline mode.');
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-xl border border-border bg-surface p-6">
        <History className="mb-3 text-accent" size={26} />
        <h1 className="mb-1 text-xl font-semibold">Sync history was rebuilt</h1>
        <p className="mb-4 text-sm text-text-muted">
          The sync server compacted its change log
          {serverEpoch != null && localEpoch != null
            ? ` (epoch ${localEpoch} → ${serverEpoch})`
            : ''}
          . Incremental sync cannot continue on this device. Unpushed local edits are only
          safe if you download a backup first.
        </p>

        {msg && (
          <p className="mb-4 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text">
            {msg}
          </p>
        )}

        <div className="space-y-2">
          <button
            type="button"
            className={`${btnSecondary} flex w-full items-center justify-center gap-2`}
            disabled={!!busy}
            onClick={() => void downloadBackup()}
          >
            {busy === 'download' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            Download local DB
          </button>

          {!confirmWipe ? (
            <button
              type="button"
              className={`${btnPrimary} flex w-full items-center justify-center gap-2`}
              disabled={!!busy}
              onClick={() => setConfirmWipe(true)}
            >
              <RefreshCw size={16} />
              Clear cache and re-download
            </button>
          ) : (
            <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
              <p className="mb-3 font-medium text-text">
                Erase this device&apos;s database and pull fresh from the server? Any local
                changes not already synced will be lost unless you downloaded a backup.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btnDanger}
                  disabled={!!busy}
                  onClick={() => void wipeAndRedownload()}
                >
                  {busy === 'wipe' ? (
                    <Loader2 size={14} className="inline animate-spin" />
                  ) : null}{' '}
                  Erase &amp; re-download
                </button>
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={!!busy}
                  onClick={() => setConfirmWipe(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            className={`${btnSecondary} flex w-full items-center justify-center gap-2`}
            disabled={!!busy}
            onClick={() => void goOffline()}
          >
            {busy === 'offline' ? <Loader2 size={16} className="animate-spin" /> : <WifiOff size={16} />}
            Log out and operate offline
          </button>
        </div>
      </div>
    </div>
  );
}
