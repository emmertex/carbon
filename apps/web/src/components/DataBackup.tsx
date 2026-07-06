import { useRef, useState } from 'react';
import { Download, Upload, Loader2, Trash2, FileArchive } from 'lucide-react';
import { completedBefore, purgeCompleted, COMPLETED_PURGE_AGE_DAYS } from '@carbon/core';
import { exportBackup, inspectBackup, applyImport, type ParsedBackup, type UserMapping } from '@/lib/backup';
import { exportNotesZip } from '@/lib/notesZip';
import { getDb } from '@/lib/db';
import { ImportModal } from './ImportModal';
import { SettingsSection } from './settings/SettingsSection';
import { btnSecondary } from './settings/controls';
import { useQuery } from '@/hooks/useQuery';
import { getCurrentUserId } from '@/lib/store';
import { mutate } from '@/lib/mutate';

const purgeCutoff = () =>
  new Date(Date.now() - COMPLETED_PURGE_AGE_DAYS * 86_400_000).toISOString();

export function DataBackup() {
  const [busy, setBusy] = useState<'export' | 'notes' | 'import' | 'purge' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const userId = getCurrentUserId();
  const completedCount = useQuery(
    (db) => completedBefore(db, userId, purgeCutoff()).length,
    [userId],
  );

  async function doPurge() {
    if (!completedCount) return;
    if (
      !window.confirm(
        `Purge ${completedCount} completed item${completedCount === 1 ? '' : 's'}? ` +
          `The purge syncs to your other devices and can't be undone from here.`,
      )
    ) {
      return;
    }
    setBusy('purge');
    setMsg(null);
    // Yield a tick so the spinner paints before the synchronous purge work.
    await new Promise((r) => setTimeout(r, 0));
    try {
      const n = mutate((db, dev) => purgeCompleted(db, dev, userId, purgeCutoff()), 'purge');
      setMsg({ ok: true, text: `Purged ${n} completed item${n === 1 ? '' : 's'}.` });
    } catch {
      setMsg({ ok: false, text: 'Purge failed.' });
    } finally {
      setBusy(null);
    }
  }

  async function doExport() {
    setBusy('export');
    setMsg(null);
    try {
      await exportBackup();
      setMsg({ ok: true, text: 'Backup downloaded.' });
    } catch {
      setMsg({ ok: false, text: 'Export failed.' });
    } finally {
      setBusy(null);
    }
  }

  async function doExportNotes() {
    setBusy('notes');
    setMsg(null);
    try {
      const { missingAssetCount } = await exportNotesZip(getDb());
      setMsg(
        missingAssetCount > 0
          ? {
              ok: true,
              text: `Notes exported (${missingAssetCount} image${missingAssetCount === 1 ? '' : 's'} unavailable and skipped).`,
            }
          : { ok: true, text: 'Notes exported.' },
      );
    } catch {
      setMsg({ ok: false, text: 'Notes export failed.' });
    } finally {
      setBusy(null);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('import');
    setMsg(null);
    try {
      const p = await inspectBackup(file);
      if (p.users.length === 0) {
        // Nothing to map — merge straight in.
        await applyImport(p, {});
        window.location.reload();
        return;
      }
      setParsed(p); // open the user-mapping modal
      setBusy(null);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Import failed.' });
      setBusy(null);
    }
  }

  async function runImport(mapping: UserMapping) {
    if (!parsed) return;
    setBusy('import');
    try {
      await applyImport(parsed, mapping);
      // Reload so the merged database re-materializes and a fresh sync pushes it.
      window.location.reload();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Import failed.' });
      setBusy(null);
      setParsed(null);
    }
  }

  return (
    <SettingsSection
      id="data"
      testId="settings-backup"
      title="Data"
      description="Export everything (tasks, projects, tags, comments, attachments) to a single file, or restore from one. Works fully offline — no server required."
    >
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={doExport} disabled={busy !== null} className={btnSecondary}>
          {busy === 'export' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Export backup
        </button>
        <button onClick={doExportNotes} disabled={busy !== null} className={btnSecondary}>
          {busy === 'notes' ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <FileArchive size={15} />
          )}
          Export notes (zip)
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className={btnSecondary}
        >
          {busy === 'import' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          Import backup
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={onFile}
        />
        {msg && (
          <span className={msg.ok ? 'text-sm text-success' : 'text-sm text-danger'}>{msg.text}</span>
        )}
      </div>
      <p className="mt-2 text-xs text-text-faint">
        Import merges a backup into this workspace, letting you map each person in it to an
        account here. A backup is a full snapshot of this device.
      </p>
      {parsed && (
        <ImportModal
          parsed={parsed}
          busy={busy === 'import'}
          onCancel={() => setParsed(null)}
          onConfirm={runImport}
        />
      )}

      {!!completedCount && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs text-text-faint">
            There {completedCount === 1 ? 'is' : 'are'} <strong>{completedCount}</strong> completed
            item{completedCount === 1 ? '' : 's'} older than {COMPLETED_PURGE_AGE_DAYS} days.
            Consider exporting a backup above before purging.
          </p>
          <button
            onClick={doPurge}
            disabled={busy !== null}
            className={`mt-2 ${btnSecondary}`}
          >
            {busy === 'purge' ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            Purge items completed more than {COMPLETED_PURGE_AGE_DAYS} days ago
          </button>
        </div>
      )}
    </SettingsSection>
  );
}
