import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getServerConfig, saveServerConfig, defaultServerUrl } from '@/lib/config';
import { useStore } from '@/lib/store';
import { signIn, syncNow } from '@/lib/sync';

/**
 * Full-screen sign-in. Reached when the configured server requires a login
 * (store.authRequired) or when the user opens it on demand (store.loginOpen — the
 * Settings "Login" button). Two steps:
 *
 *  1. Server URL — pre-filled with a sensible default (the hosted SaaS for native
 *     builds, the serving origin for a tenant subdomain / self-host). Skipped when a
 *     server is already configured, but always reachable via "Change server".
 *  2. Username + password — exchanged for a session token; the password is never
 *     persisted.
 *
 * There is always a way back out: a back arrow on the URL step closes the flow and
 * drops to the local app, and "Change server" returns from the credentials step.
 */
export function SignInGate() {
  const closeLogin = useStore((s) => s.closeLogin);
  const initialUrl = getServerConfig().url || defaultServerUrl();
  // Start on credentials when a server is already wired up (the common tenant /
  // self-host case); otherwise ask for the URL first.
  const [step, setStep] = useState<'url' | 'creds'>(getServerConfig().url ? 'creds' : 'url');
  const [url, setUrl] = useState(initialUrl);
  const [username, setUsername] = useState(getServerConfig().username);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls =
    'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent';

  function continueToCreds(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) return;
    saveServerConfig({ ...getServerConfig(), url: trimmed });
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
      url: current.url || url.trim().replace(/\/+$/, ''),
      username: username.trim(),
    });
    const result = await signIn(password);
    setBusy(false); // never leave the spinner stuck (W5)
    if (result === 'ok') {
      closeLogin(); // dismiss the gate now that we're signed in
      void syncNow();
    } else if (result === 'error') {
      setError('Could not reach the server. Check the address and try again.');
    } else {
      setError('Sign-in failed — check your username and password.');
    }
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
              Enter the address of your Carbon server.
            </p>
            <form onSubmit={continueToCreds} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Server URL</span>
                <input
                  className={inputCls}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://carbon.example.com"
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoFocus
                  required
                />
              </label>
              <button
                type="submit"
                disabled={!url.trim()}
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
        ) : (
          <>
            <h1 className="mb-1 text-xl font-semibold">Sign in to Carbon</h1>
            <p className="mb-6 text-sm text-text-muted">
              {getServerConfig().url || url || 'your Carbon server'}
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
        )}
      </div>
    </div>
  );
}
