import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getServerConfig, saveServerConfig } from '@/lib/config';
import { signIn, syncNow } from '@/lib/sync';

/**
 * Full-screen sign-in shown when the configured server requires a login and we
 * have no valid session (store.authRequired). Local-only and open-mode setups
 * never reach this. On a tenant subdomain the server URL defaults to the current
 * origin, so the family just types their username + password.
 */
export function SignInGate() {
  const cfg = getServerConfig();
  const [username, setUsername] = useState(cfg.username);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A tenant subdomain serves both the app and its API from the same origin —
  // default the sync URL to it so sign-in needs no server config.
  useEffect(() => {
    if (!getServerConfig().url) saveServerConfig({ ...getServerConfig(), url: window.location.origin });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Persist the URL + username (never the password — signIn exchanges it for a
    // session token held only after a successful login).
    const current = getServerConfig();
    saveServerConfig({
      ...current,
      url: current.url || window.location.origin,
      username: username.trim(),
    });
    const result = await signIn(password);
    setBusy(false); // never leave the spinner stuck (W5)
    if (result === 'ok') {
      void syncNow();
    } else if (result === 'error') {
      setError('Could not reach the server. Check the connection and try again.');
    } else {
      setError('Sign-in failed — check your username and password.');
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg px-6 text-text">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold">Sign in to Carbon</h1>
        <p className="mb-6 text-sm text-text-muted">
          Welcome back. Sign in to your family workspace.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Username</span>
            <input
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
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
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
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
        <p className="mt-6 text-center text-sm text-text-muted">
          No workspace yet? <Link to="/signup" className="text-accent">Create one</Link>
        </p>
      </div>
    </div>
  );
}
