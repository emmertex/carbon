import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  getServerConfig,
  saveServerConfig,
  splitServerUrl,
  workspaceUrl,
} from '@/lib/config';
import { isNative } from '@/lib/platform';
import { useStore } from '@/lib/store';
import { signIn, syncNow, resetLocalDataAndReload } from '@/lib/sync';
import { localItemCount } from '@/lib/db';

/**
 * Full-screen sign-in. Reached when the configured server requires a login
 * (store.authRequired) or when the user opens it on demand (store.loginOpen — the
 * Settings "Login" button). Two steps:
 *
 *  1. Workspace + server — the user types just their workspace name and the base
 *     domain (pre-filled with the hosted domain, editable for self-hosters), so they
 *     never have to hand-assemble a full URL. Leaving the workspace blank targets the
 *     bare domain (single-tenant self-host). Skipped when a server is already
 *     configured, but always reachable via "Change server".
 *  2. Username + password — exchanged for a session token; the password is never
 *     persisted.
 *
 * There is always a way back out: a back arrow on the URL step closes the flow and
 * drops to the local app, and "Change server" returns from the credentials step.
 */
export function SignInGate() {
  const closeLogin = useStore((s) => s.closeLogin);
  // Seed the split fields from an existing config, or (browser only) the serving
  // origin. Native builds start blank so we never default to app.<domain>.
  const initial = splitServerUrl(
    getServerConfig().url || (isNative ? '' : window.location.origin),
  );
  // Start on credentials when a server is already wired up (the common tenant /
  // self-host case); otherwise ask for the workspace + domain first.
  const [step, setStep] = useState<'url' | 'creds' | 'merge'>(
    getServerConfig().url ? 'creds' : 'url',
  );
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [domain, setDomain] = useState(initial.domain);
  const [username, setUsername] = useState(getServerConfig().username);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How many local (pre-sign-in) items are at stake, so the merge/replace step can
  // tell the user what "replace" would discard.
  const [localCount, setLocalCount] = useState(0);

  const inputCls =
    'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent';

  const resolvedUrl = workspaceUrl(workspace, domain);

  function continueToCreds(e: React.FormEvent) {
    e.preventDefault();
    if (!resolvedUrl) return;
    saveServerConfig({ ...getServerConfig(), url: resolvedUrl });
    setError(null);
    setStep('creds');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Persist the URL + username (never the password — signIn exchanges it for a
    // session token held only after a successful login).
    const current = getServerConfig();
    saveServerConfig({
      ...current,
      url: current.url || resolvedUrl,
      username: username.trim(),
    });
    const result = await signIn(password);
    setBusy(false); // never leave the spinner stuck (W5)
    if (result === 'ok') {
      // If there's local data on this device, let the user choose whether to keep
      // it (merge — the default claim-and-sync) or discard it and pull the account
      // fresh (replace). A clean install (nothing local) just signs in and syncs.
      const n = localItemCount();
      if (n > 0) {
        setLocalCount(n);
        setStep('merge');
        return;
      }
      closeLogin(); // dismiss the gate now that we're signed in
      void syncNow();
    } else if (result === 'error') {
      setError('Could not reach the server. Check the address and try again.');
    } else {
      setError('Sign-in failed — check your username and password.');
    }
  }

  /** Keep local items: claim the unowned ones into this account (handled by the
   *  first sync's identity step) and merge with whatever the server has. */
  function mergeLocal() {
    closeLogin();
    void syncNow();
  }

  /** Discard the local database and re-pull everything from the server. Reloads. */
  function replaceLocal() {
    setBusy(true);
    void resetLocalDataAndReload();
  }

  return (
    <div
      className="flex h-full items-center justify-center bg-bg px-6 text-text"
      data-testid="sign-in"
    >
      <div className="w-full max-w-sm">
        {step === 'url' ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Connect to Carbon</h1>
            <p className="mb-6 text-sm text-text-muted">
              Enter your workspace name. Self-hosting? Change the server below.
            </p>
            <form onSubmit={continueToCreds} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Workspace</span>
                <div className="flex items-stretch overflow-hidden rounded-lg border border-border bg-surface focus-within:border-accent">
                  <input
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
                    value={workspace}
                    onChange={(e) =>
                      setWorkspace(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    }
                    placeholder="smiths"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoFocus
                  />
                  <span className="flex select-none items-center whitespace-nowrap border-l border-border bg-bg px-3 text-sm text-text-muted">
                    .{domain}
                  </span>
                </div>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Server</span>
                <input
                  className={inputCls}
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="carbon.etx.sx"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                />
                <span className="mt-1 block text-xs text-text-muted">
                  {resolvedUrl ? (
                    <>
                      Connects to <span className="font-mono">{resolvedUrl}</span>
                    </>
                  ) : (
                    'The domain your Carbon server runs on.'
                  )}
                </span>
              </label>
              <button
                type="submit"
                disabled={!resolvedUrl}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Continue
              </button>
            </form>
            <button
              onClick={closeLogin}
              className="mt-6 flex w-full items-center justify-center gap-1 text-sm text-text-muted hover:text-text"
            >
              <ArrowLeft size={15} /> Back to Carbon
            </button>
          </>
        ) : step === 'creds' ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Sign in to Carbon</h1>
            <p className="mb-6 text-sm text-text-muted">
              {getServerConfig().url || resolvedUrl || 'your Carbon server'}
            </p>
            <form onSubmit={submit} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Username</span>
                <input
                  className={inputCls}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoCapitalize="none"
                  autoFocus
                  required
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Password</span>
                <input
                  className={inputCls}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={busy || !username.trim() || !password}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy && <Loader2 className="animate-spin" size={16} />}
                Sign in
              </button>
            </form>
            <div className="mt-6 flex items-center justify-between text-sm">
              <button
                onClick={() => {
                  setError(null);
                  setStep('url');
                }}
                className="flex items-center gap-1 text-text-muted hover:text-text"
              >
                <ArrowLeft size={15} /> Change server
              </button>
              <Link to="/signup" className="text-accent">
                Create one
              </Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-xl font-semibold">You have local tasks on this device</h1>
            <p className="mb-6 text-sm text-text-muted">
              Signed in as <span className="font-medium text-text">{username.trim()}</span>. This
              device already has {localCount} local {localCount === 1 ? 'item' : 'items'}. What
              should happen to {localCount === 1 ? 'it' : 'them'}?
            </p>
            <div className="space-y-3">
              <button
                onClick={mergeLocal}
                disabled={busy}
                className="w-full rounded-lg border border-border bg-surface p-3 text-left hover:border-accent disabled:opacity-50"
              >
                <span className="block text-sm font-medium text-text">Merge with my account</span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  Keep the tasks on this device and combine them with everything in your account.
                  Recommended for normal sign-in.
                </span>
              </button>
              <button
                onClick={replaceLocal}
                disabled={busy}
                className="flex w-full flex-col items-start rounded-lg border border-red-500/40 p-3 text-left hover:bg-red-500/10 disabled:opacity-50"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-red-500">
                  {busy && <Loader2 className="animate-spin" size={14} />}
                  Replace with my account's data
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  Erase this device's {localCount} local {localCount === 1 ? 'item' : 'items'} and
                  re-download everything from the server. Use this if the local copy is wrong or out
                  of date.
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
