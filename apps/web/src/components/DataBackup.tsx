import { useRef, useState } from 'react';
import { Download, Upload, Loader2 } from 'lucide-react';
import { exportBackup, inspectBackup, applyImport, type ParsedBackup, type UserMapping } from '@/lib/backup';
import { ImportModal } from './ImportModal';
import { SettingsSection } from './settings/SettingsSection';
import { btnSecondary } from './settings/controls';

export function DataBackup() {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
      title="Data"
      description="Export everything (tasks, projects, tags, comments, attachments) to a single file, or restore from one. Works fully offline — no server required."
    >
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={doExport} disabled={busy !== null} className={btnSecondary}>
          {busy === 'export' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Export backup
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
    </SettingsSection>
  );
}
