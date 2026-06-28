import { useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { type ServerConfig } from '@/lib/config';
import {
  testConnection,
  syncNow,
  signIn as doSignIn,
  signOut as doSignOut,
  type ConnectionResult,
} from '@/lib/sync';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/cn';
import { avatarInitial } from '../Avatar';
import { SettingsSection } from './SettingsSection';
import { Field, SettingsToggle, inputCls, btnPrimary, btnSecondary } from './controls';

/**
 * Sync server card: the connection form / sign-in when signed out, and the
 * sync-now / sign-out controls plus auth state when signed in. Owns only its
 * transient UI state; persistent server config is lifted to SettingsView.
 */
export function SyncSection({
  cfg,
  update,
}: {
  cfg: ServerConfig;
  update: (patch: Partial<ServerConfig>) => void;
}) {
  const currentUser = useStore((s) => s.currentUser);
  const signedIn = !!currentUser && !currentUser.open;
  // Password is held only in memory until exchanged for a session token; it is
  // never written to the persisted server config.
  const [password, setPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [result, setResult] = useState<ConnectionResult | null>(null);

  function change(patch: Partial<ServerConfig>) {
    update(patch);
    setResult(null);
  }

  async function test() {
    setTesting(true);
    setResult(null);
    const r = await testConnection({ ...cfg, password });
    setResult(r);
    setTesting(false);
  }

  async function signIn() {
    setSigningIn(true);
    setResult(null);
    const r = await doSignIn(password);
    setSigningIn(false);
    if (r === 'ok') {
      setPassword('');
      setResult({ ok: true, message: 'Signed in' });
      void syncNow();
    } else if (r === 'open') {
      setResult({ ok: false, message: 'Server has no accounts (open mode)' });
    } else if (r === 'error') {
      setResult({ ok: false, message: 'Could not reach server' });
    } else {
      setResult({ ok: false, message: 'Sign-in failed — check username/password' });
    }
  }

  function signOut() {
    setPassword('');
    void doSignOut();
  }

  return (
    <SettingsSection
      id="sync"
      title="Sync server"
      description="Carbon works fully offline. Point it at a self-hosted Carbon server to sync across devices. Leave blank to stay local-only."
    >
      <div className="space-y-3">
        {/* Signed out: connection form */}
        {!signedIn && (
          <>
            <Field label="Server URL">
              <input
                className={cn(inputCls, 'w-full')}
                placeholder="https://carbon.example.com"
                value={cfg.url}
                onChange={(e) => change({ url: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username">
                <input
                  className={cn(inputCls, 'w-full')}
                  value={cfg.username}
                  onChange={(e) => change({ username: e.target.value })}
                  autoComplete="username"
                />
              </Field>
              <Field label="Password">
                <input
                  className={cn(inputCls, 'w-full')}
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setResult(null);
                  }}
                  autoComplete="current-password"
                />
              </Field>
            </div>
          </>
        )}

        {/* Signed in: background-sync toggle */}
        {signedIn && (
          <SettingsToggle
            label="Sync automatically in the background"
            checked={cfg.autoSync}
            onChange={(v) => change({ autoSync: v })}
          />
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {!signedIn && (
            <button onClick={test} disabled={testing || !cfg.url} className={btnSecondary}>
              {testing && <Loader2 size={15} className="animate-spin" />}
              Test connection
            </button>
          )}
          {!signedIn && (
            <button
              onClick={signIn}
              disabled={signingIn || !cfg.url || !cfg.username || !password}
              className={btnPrimary}
            >
              {signingIn && <Loader2 size={15} className="animate-spin" />}
              Sign in
            </button>
          )}
          {signedIn && (
            <button onClick={() => void syncNow()} className={btnSecondary}>
              Sync now
            </button>
          )}
          {signedIn && (
            <button onClick={signOut} className={btnSecondary}>
              Sign out
            </button>
          )}
          {result && (
            <span
              className={cn(
                'flex items-center gap-1 text-sm',
                result.ok ? 'text-success' : 'text-danger',
              )}
            >
              {result.ok ? <Check size={15} /> : <X size={15} />}
              {result.message}
            </span>
          )}
        </div>

        {/* Auth state */}
        {signedIn && currentUser && (
          <div className="flex items-center gap-2 pt-2 text-sm text-text-muted">
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
      </div>
    </SettingsSection>
  );
}
