import { useEffect, useState } from 'react';
import { Trash2, KeyRound, Copy, Check } from 'lucide-react';
import {
  adminListTokens, memberKeyPolicy, setMemberKeyPolicy,
  adminCreateToken,
  adminRevokeToken,
  type ApiToken,
} from '@/lib/admin';
import { useStore } from '@/lib/store';
import { useQuery } from '@/hooks/useQuery';
import { getProjects } from '@carbon/core';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import { ErrorText, Card, btnPrimary, btnIcon, inputCls } from './settings/controls';
import { useSavedFlash } from './settings/useSavedFlash';

const ALL_SCOPES = ['tasks:read', 'tasks:write', 'inbox:write'];

export function ApiTokens() {
  const isAdmin = useStore((s) => s.currentUser?.role === 'admin');
  const [membersAllowed, setMembersAllowed] = useState(true);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([...ALL_SCOPES]);
  const [expiresAt, setExpiresAt] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const projects = useQuery((db) => getProjects(db)) ?? [];
  const [created, setCreated] = useState<string | null>(null);
  const [copied, flashCopied] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setTokens(await adminListTokens());
      setMembersAllowed(await memberKeyPolicy());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const token = await adminCreateToken({ name, scopes, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, projectIds: projectIds.length ? projectIds : null });
      setCreated(token);
      setName('');
      setScopes([...ALL_SCOPES]);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleScope(s: string) {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  return (
    <SettingsSection
      id="api-tokens"
      title="Personal API keys"
      description={
        <>
          For integrations (Home Assistant, scripts) to read/create tasks. Send as
          <code className="mt-1 block w-fit max-w-full break-all rounded bg-surface-2 px-1 text-xs">
            Authorization: Bearer &lt;token&gt;
          </code>
        </>
      }
    >
      {isAdmin && <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" className="shrink-0 accent-accent" checked={membersAllowed} onChange={async (e) => {
          try { await setMemberKeyPolicy(e.target.checked); await reload(); } catch (error) { setError(String(error)); }
        }} /> Allow members to create personal API keys
      </label>}
      {!isAdmin && !membersAllowed && <p>Key creation is disabled by your administrator. Existing keys can still be revoked.</p>}
      {created && (
        <div className="mb-3 rounded-lg border border-accent bg-accent-soft p-3 text-sm">
          <p className="mb-1 font-medium text-accent">Copy this token now — it won't be shown again:</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-xs">{created}</code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(created);
                flashCopied();
              }}
              className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs font-medium text-accent-fg"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <Card className="mb-3 divide-y divide-border">
        {tokens.length === 0 && (
          <p className="px-3 py-2 text-sm text-text-faint">No tokens yet.</p>
        )}
        {tokens.map((t) => (
          <div key={t.id} className="flex items-start gap-3 px-3 py-3 text-sm">
            <KeyRound size={15} className="mt-0.5 shrink-0 text-text-muted" />
            <div className="min-w-0 flex-1 space-y-1">
              <span className="block break-words font-medium">{t.name}</span>
              <span className="block break-words text-xs text-text-faint">{t.scopes.join(', ')}</span>
              <span className="block text-xs text-text-faint">{t.expires_at ? `expires ${new Date(t.expires_at).toLocaleDateString()}` : 'no expiry'} · {t.project_ids ? `${t.project_ids.length} project subtrees` : 'all accessible tasks'}</span>
              <span className="text-xs text-text-faint">
                {t.last_used_at ? `used ${new Date(t.last_used_at).toLocaleDateString()}` : 'never used'}
              </span>
            </div>
            <button
              onClick={async () => {
                if (window.confirm(`Revoke token "${t.name}"?`)) {
                  setError(null);
                  try {
                    await adminRevokeToken(t.id);
                  } catch (err) {
                    setError(String(err));
                  }
                  await reload();
                }
              }}
              className={cn(btnIcon, 'shrink-0 hover:text-danger')}
              title="Revoke"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </Card>

      <form onSubmit={add} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="min-w-0 space-y-1.5 text-sm">
            <span className="block text-text-muted">Key name</span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Home Assistant" className={cn(inputCls, 'w-full min-w-0')} />
          </label>
          <label className="min-w-0 space-y-1.5 text-sm">
            <span className="block text-text-muted">Expires <span className="text-xs text-text-faint">(optional)</span></span>
            <input aria-label="Key expiry" type="datetime-local" className={cn(inputCls, 'w-full min-w-0 max-w-full')}
              value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
        </div>
        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm text-text-muted">Permissions</legend>
          <div className="flex flex-wrap gap-2">
            {ALL_SCOPES.map((s) => (
              <button key={s} type="button" onClick={() => toggleScope(s)} aria-pressed={scopes.includes(s)}
                className={cn('rounded-full border px-2.5 py-1 text-xs', scopes.includes(s)
                  ? 'border-accent bg-accent-soft text-accent' : 'border-border text-text-muted')}>
                {s}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="min-w-0">
          <legend className="text-sm text-text-muted">Project access</legend>
          <p className="mb-2 mt-1 text-xs text-text-faint">All accessible tasks unless you select specific project subtrees.</p>
          {projects.length > 0 ? (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border p-2">
              {projects.map((p) => (
                <label key={p.id} className="flex items-start gap-2 rounded px-1 py-1.5 text-sm hover:bg-surface-2">
                  <input type="checkbox" className="mt-0.5 shrink-0 accent-accent" checked={projectIds.includes(p.id)}
                    onChange={(e) => setProjectIds((ids) => e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id))} />
                  <span className="min-w-0 break-words">{p.title || 'Untitled project'}</span>
                </label>
              ))}
            </div>
          ) : <p className="text-xs text-text-faint">No projects available.</p>}
        </fieldset>
        <button type="submit" disabled={!name || scopes.length === 0 || (!isAdmin && !membersAllowed)} className={btnPrimary}>
          Create key
        </button>
      </form>

      <ErrorText className="mt-2">{error}</ErrorText>
    </SettingsSection>
  );
}
