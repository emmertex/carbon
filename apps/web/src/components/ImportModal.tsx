import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { listUsers, type User } from '@carbon/core';
import { getDb } from '@/lib/db';
import type { ParsedBackup, UserMapping, UserChoice } from '@/lib/backup';
import { Modal } from './Modal';
import { btnPrimary, btnSecondary } from './ui/controls';

const selectCls =
  'rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent';

function userLabel(u: { display_name: string | null; username: string }): string {
  return u.display_name ? `${u.display_name} (@${u.username})` : `@${u.username}`;
}

function choiceValue(c: UserChoice): string {
  if (c.action === 'map') return `map:${c.targetId}`;
  if (c.action === 'drop') return 'drop';
  return 'federation';
}

/**
 * Per-user mapping for a backup import. Each person in the backup is folded into an
 * existing workspace user, dropped, or (placeholder) kept as a federated identity.
 */
export function ImportModal({
  parsed,
  busy,
  onCancel,
  onConfirm,
}: {
  parsed: ParsedBackup;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (mapping: UserMapping) => void;
}) {
  const available: User[] = listUsers(getDb());

  // Default each backup user to the same-username account user if one exists,
  // else the first available user (usually the signed-in admin).
  const [mapping, setMapping] = useState<UserMapping>(() => {
    const init: UserMapping = {};
    for (const u of parsed.users) {
      const match = available.find((a) => a.username === u.username) ?? available[0];
      init[u.id] = match ? { action: 'map', targetId: match.id } : { action: 'drop' };
    }
    return init;
  });

  function setChoice(oldId: string, value: string) {
    setMapping((m) => {
      if (value === 'drop') return { ...m, [oldId]: { action: 'drop' } };
      if (value === 'federation') return { ...m, [oldId]: { action: 'federation', address: '' } };
      return { ...m, [oldId]: { action: 'map', targetId: value.slice('map:'.length) } };
    });
  }
  function setFederationAddress(oldId: string, address: string) {
    setMapping((m) => ({ ...m, [oldId]: { action: 'federation', address } }));
  }

  return (
    <Modal
      labelledBy="import-modal-title"
      onClose={busy ? undefined : onCancel}
      panelClassName="max-h-[85vh] w-full max-w-lg overflow-y-auto p-6 shadow-xl"
    >
      <h2 id="import-modal-title" className="mb-1 text-lg font-semibold">
        Import backup
      </h2>
      <p className="mb-5 text-sm text-text-muted">
        Map each person in this backup to someone in this workspace. Their tasks, comments
        and assignments are re-owned accordingly. Choose <em>Drop</em> to leave a person's
        data out.
      </p>

      <div className="space-y-3">
        {parsed.users.map((u) => {
          const choice = mapping[u.id];
          return (
            <div key={u.id} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{userLabel(u)}</div>
                  <div className="text-xs text-text-faint">from backup</div>
                </div>
                <span className="text-text-faint">→</span>
                <select
                  className={selectCls}
                  value={choiceValue(choice)}
                  onChange={(e) => setChoice(u.id, e.target.value)}
                >
                  <optgroup label="Map to">
                    {available.map((a) => (
                      <option key={a.id} value={`map:${a.id}`}>
                        {userLabel(a)}
                      </option>
                    ))}
                  </optgroup>
                  <option value="drop">Drop this person's data</option>
                  <option value="federation">Federation address…</option>
                </select>
              </div>
              {choice.action === 'federation' && (
                <input
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
                  placeholder="user@workspace.carbon.etx.sx (federation — coming soon)"
                  value={choice.address}
                  onChange={(e) => setFederationAddress(u.id, e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onCancel} disabled={busy} className={btnSecondary}>
          Cancel
        </button>
        <button
          onClick={() => onConfirm(mapping)}
          disabled={busy}
          className={btnPrimary}
        >
          {busy && <Loader2 className="animate-spin" size={16} />}
          Import
        </button>
      </div>
    </Modal>
  );
}
