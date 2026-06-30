import { useEffect, useState } from 'react';
import { Trash2, KeyRound, Copy, Check } from 'lucide-react';
import {
  adminListTokens,
  adminCreateToken,
  adminRevokeToken,
  type ApiToken,
} from '@/lib/admin';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import { ErrorText, Card, btnPrimary, btnIcon, inputCls } from './settings/controls';
import { useSavedFlash } from './settings/useSavedFlash';

const ALL_SCOPES = ['tasks:read', 'tasks:write', 'inbox:write'];

export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([...ALL_SCOPES]);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, flashCopied] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setTokens(await adminListTokens());
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
      const token = await adminCreateToken({ name, scopes });
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
      title="API tokens"
      description={
        <>
          For integrations (Home Assistant, scripts) to read/create tasks. Send as
          <code className="mx-1 rounded bg-surface-2 px-1 text-xs">
            Authorization: Bearer &lt;token&gt;
          </code>
          .
        </>
      }
    >
      {created && (
        <div className="mb-3 rounded-lg border border-accent bg-accent-soft p-3 text-sm">
          <p className="mb-1 font-medium text-accent">Copy this token now — it won't be shown again:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-surface px-2 py-1 text-xs">{created}</code>
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
          <div key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <KeyRound size={15} className="text-text-muted" />
            <span className="font-medium">{t.name}</span>
            <span className="text-xs text-text-faint">{t.scopes.join(', ')}</span>
            <div className="flex-1" />
            <span className="text-xs text-text-faint">
              {t.last_used_at ? `used ${new Date(t.last_used_at).toLocaleDateString()}` : 'never used'}
            </span>
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
              className={cn(btnIcon, 'hover:text-danger')}
              title="Revoke"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </Card>

      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name (e.g. home-assistant)"
          className={inputCls}
        />
        {ALL_SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggleScope(s)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs',
              scopes.includes(s)
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border text-text-muted',
            )}
          >
            {s}
          </button>
        ))}
        <button type="submit" disabled={!name || scopes.length === 0} className={btnPrimary}>
          Create token
        </button>
      </form>

      <ErrorText className="mt-2">{error}</ErrorText>
    </SettingsSection>
  );
}
