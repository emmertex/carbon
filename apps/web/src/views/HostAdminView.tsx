import { useState, useEffect } from 'react';
import { Loader2, Plus, Pause, Play, Trash2, Lock, Unlock } from 'lucide-react';
import {
  hostListTenants,
  hostCreateTenant,
  hostPatchTenant,
  hostDeleteTenant,
  hostTenantUsage,
  type HostCreds,
  type TenantRecord,
  type TenantUsage,
} from '@/lib/host';

/** Bytes → "12 MB" / "1.2 GB", for the host-admin storage display. */
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Mirror of the server's tenantLockState: locked when active and either manually
 *  locked or past expiry. Drives the host-admin lock indicator. */
function isLocked(t: TenantRecord): boolean {
  if (t.status !== 'active') return false;
  if (t.locked_at) return true;
  return !!t.expires_at && Date.now() > Date.parse(t.expires_at);
}

const inputCls =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent';

/**
 * Cross-tenant operator console (host admin). Lives at /host-admin, ideally on the
 * admin.<domain> origin. Host credentials are held in memory only — never synced
 * into a tenant DB or persisted to localStorage.
 */
export function HostAdminView() {
  const [creds, setCreds] = useState<HostCreds | null>(null);
  if (!creds) return <HostLogin onAuthed={setCreds} />;
  return <Console creds={creds} onSignOut={() => setCreds(null)} />;
}

function HostLogin({ onAuthed }: { onAuthed: (c: HostCreds) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const c = { username: username.trim(), password };
    try {
      await hostListTenants(c); // validates the creds
      onAuthed(c);
    } catch {
      setError('Invalid host-admin credentials.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="mb-1 text-xl font-semibold">Host Admin</h1>
      <p className="mb-6 text-sm text-text-muted">Manage all family workspaces on this server.</p>
      <form onSubmit={submit} className="space-y-4">
        <input
          className={inputCls}
          placeholder="Host admin username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          required
        />
        <input
          className={inputCls}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="animate-spin" size={16} />}
          Sign in
        </button>
      </form>
    </div>
  );
}

function Console({ creds, onSignOut }: { creds: HostCreds; onSignOut: () => void }) {
  const [tenants, setTenants] = useState<TenantRecord[] | null>(null);
  const [usage, setUsage] = useState<Record<string, TenantUsage>>({});
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function refresh() {
    try {
      const list = await hostListTenants(creds);
      setTenants(list);
      setError(null);
      // Usage (storage/users) needs a per-tenant scan, so fetch it lazily in parallel
      // and fill it in as it arrives rather than blocking the list.
      const entries = await Promise.all(
        list.map(async (t) => [t.id, await hostTenantUsage(creds, t.id).catch(() => null)] as const),
      );
      setUsage(Object.fromEntries(entries.filter((e) => e[1]) as [string, TenantUsage][]));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // Load on mount (not during render — that double-fires under StrictMode) (W9).
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setStatus(t: TenantRecord, status: 'active' | 'suspended') {
    await hostPatchTenant(creds, t.id, { status }).catch((e) => setError((e as Error).message));
    void refresh();
  }
  async function setLocked(t: TenantRecord, locked: boolean) {
    await hostPatchTenant(creds, t.id, { locked }).catch((e) => setError((e as Error).message));
    void refresh();
  }
  async function setExpiry(t: TenantRecord, expiresAt: string | null) {
    await hostPatchTenant(creds, t.id, { expiresAt }).catch((e) => setError((e as Error).message));
    void refresh();
  }
  async function setQuota(t: TenantRecord, blobQuotaMb: number | null) {
    await hostPatchTenant(creds, t.id, { blobQuotaMb }).catch((e) => setError((e as Error).message));
    void refresh();
  }
  async function setAllowPrivate(t: TenantRecord, allowPrivateEndpoints: boolean) {
    await hostPatchTenant(creds, t.id, { allowPrivateEndpoints }).catch((e) =>
      setError((e as Error).message),
    );
    void refresh();
  }
  async function remove(t: TenantRecord) {
    if (!confirm(`Delete workspace "${t.subdomain}"? This erases all its data.`)) return;
    await hostDeleteTenant(creds, t.id).catch((e) => setError((e as Error).message));
    void refresh();
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workspaces</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowNew((v) => !v)}
            className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white"
          >
            <Plus size={16} /> New
          </button>
          <button onClick={onSignOut} className="rounded-lg border border-border px-3 py-1.5 text-sm">
            Sign out
          </button>
        </div>
      </div>

      {showNew && (
        <NewTenantForm
          creds={creds}
          onCreated={() => {
            setShowNew(false);
            void refresh();
          }}
        />
      )}

      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}
      {tenants === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : tenants.length === 0 ? (
        <p className="text-sm text-text-muted">No workspaces yet.</p>
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border">
          {tenants.map((t) => (
            <TenantRow
              key={t.id}
              t={t}
              usage={usage[t.id]}
              onStatus={setStatus}
              onLocked={setLocked}
              onExpiry={setExpiry}
              onQuota={setQuota}
              onAllowPrivate={setAllowPrivate}
              onRemove={remove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TenantRow({
  t,
  usage,
  onStatus,
  onLocked,
  onExpiry,
  onQuota,
  onAllowPrivate,
  onRemove,
}: {
  t: TenantRecord;
  usage?: TenantUsage;
  onStatus: (t: TenantRecord, s: 'active' | 'suspended') => void;
  onLocked: (t: TenantRecord, locked: boolean) => void;
  onExpiry: (t: TenantRecord, expiresAt: string | null) => void;
  onQuota: (t: TenantRecord, blobQuotaMb: number | null) => void;
  onAllowPrivate: (t: TenantRecord, allow: boolean) => void;
  onRemove: (t: TenantRecord) => void;
}) {
  const locked = isLocked(t);
  const expiryDate = t.expires_at ? new Date(t.expires_at).toISOString().slice(0, 10) : '';

  // Effective quota in MB (0 = unlimited). Used as the input's value and to skip
  // no-op writes (so tabbing past an untouched field doesn't convert default→explicit).
  const quotaMb = usage ? Math.round(usage.blobQuota / 1024 / 1024) : null;
  const used = usage ? fmtBytes(usage.blobBytes) : '…';
  const cap = usage ? (usage.blobQuota === 0 ? '∞' : fmtBytes(usage.blobQuota)) : '…';
  const near = usage && usage.blobQuota > 0 && usage.blobBytes / usage.blobQuota >= 0.9;

  function commitQuota(e: React.FocusEvent<HTMLInputElement> | React.KeyboardEvent<HTMLInputElement>) {
    const raw = (e.currentTarget.value ?? '').trim();
    if (raw !== '' && Number.isNaN(Number(raw))) return;
    const next = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
    if ((next ?? -1) === (quotaMb ?? -1)) return; // unchanged → no write
    onQuota(t, next);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t.display_name || t.subdomain}</span>
          <span
            className={
              'rounded px-1.5 py-0.5 text-xs ' +
              (t.status === 'active'
                ? 'bg-green-500/15 text-green-600'
                : t.status === 'suspended'
                  ? 'bg-amber-500/15 text-amber-600'
                  : 'bg-surface-2 text-text-muted')
            }
          >
            {t.status}
          </span>
          {locked && (
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs text-red-600">locked</span>
          )}
        </div>
        <a href={t.url} className="block truncate font-mono text-xs text-text-muted">
          {t.url}
        </a>
        {t.admin_email && (
          <span className="block truncate text-xs text-text-faint">{t.admin_email}</span>
        )}
        <span className={'block text-xs ' + (near ? 'text-amber-600' : 'text-text-faint')}>
          Storage {used} / {cap}
        </span>
      </div>

      {/* Storage cap (MB): blank = server default, 0 = unlimited. */}
      <label
        className="flex items-center gap-1 text-xs text-text-muted"
        title="Blob storage cap in MB (blank = server default, 0 = unlimited)"
      >
        <input
          type="number"
          min={0}
          key={quotaMb ?? 'na'}
          defaultValue={quotaMb ?? ''}
          onBlur={commitQuota}
          onKeyDown={(e) => e.key === 'Enter' && commitQuota(e)}
          className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
        />
        MB
      </label>

      {/* Allow this workspace's agents to reach private/loopback/LAN endpoints. */}
      <label
        className="flex items-center gap-1 text-xs text-text-muted"
        title="Allow this workspace's agents to reach private/loopback/LAN endpoints (e.g. a self-hosted LLM). Off by default to prevent SSRF."
      >
        <input
          type="checkbox"
          checked={!!t.allow_private_endpoints}
          onChange={(e) => onAllowPrivate(t, e.target.checked)}
          className="accent-accent"
        />
        Private LLM
      </label>

      {/* Expiry: set the date the workspace locks, or clear for "never". */}
      <label className="flex items-center gap-1 text-xs text-text-muted" title="Workspace locks on">
        <input
          type="date"
          value={expiryDate}
          onChange={(e) =>
            onExpiry(t, e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : null)
          }
          className="rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
        />
        {t.expires_at && (
          <button
            onClick={() => onExpiry(t, null)}
            title="Clear expiry (never locks)"
            className="rounded px-1 text-text-faint hover:text-text"
          >
            ✕
          </button>
        )}
      </label>

      <button
        onClick={() => onLocked(t, !t.locked_at)}
        title={t.locked_at ? 'Unlock workspace' : 'Lock workspace'}
        className="rounded-lg p-2 hover:bg-surface-2"
      >
        {t.locked_at ? <Unlock size={16} /> : <Lock size={16} />}
      </button>

      {t.status === 'suspended' ? (
        <button
          onClick={() => onStatus(t, 'active')}
          title="Resume"
          className="rounded-lg p-2 hover:bg-surface-2"
        >
          <Play size={16} />
        </button>
      ) : (
        <button
          onClick={() => onStatus(t, 'suspended')}
          title="Suspend"
          className="rounded-lg p-2 hover:bg-surface-2"
        >
          <Pause size={16} />
        </button>
      )}
      <button
        onClick={() => onRemove(t)}
        title="Delete"
        className="rounded-lg p-2 text-red-500 hover:bg-surface-2"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

function NewTenantForm({ creds, onCreated }: { creds: HostCreds; onCreated: () => void }) {
  const [subdomain, setSubdomain] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await hostCreateTenant(creds, {
        subdomain: subdomain.trim() || undefined,
        displayName: displayName.trim() || undefined,
        adminUsername: username.trim(),
        adminPassword: password,
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-6 space-y-3 rounded-xl border border-border bg-surface p-4">
      <div className="grid grid-cols-2 gap-3">
        <input
          className={inputCls}
          placeholder="Address (blank = random)"
          value={subdomain}
          onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
          autoCapitalize="none"
        />
        <input
          className={inputCls}
          placeholder="Workspace name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder="Admin username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          required
        />
        <input
          className={inputCls}
          type="password"
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <button
        type="submit"
        disabled={busy || !username.trim() || !password}
        className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy && <Loader2 className="animate-spin" size={16} />}
        Create workspace
      </button>
    </form>
  );
}
