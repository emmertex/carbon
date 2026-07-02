import { Link } from 'react-router-dom';
import { syncNow, signOut as doSignOut } from '@/lib/sync';
import { type ServerConfig } from '@/lib/config';
import { LINKS } from '@/lib/links';
import { useStore } from '@/lib/store';
import { avatarInitial } from '../Avatar';
import { SettingsSection } from './SettingsSection';
import { SettingsToggle, DocLink, btnPrimary, btnSecondary } from './controls';

/**
 * Sync server card. Signing in lives in the dedicated full-screen flow (the
 * "Login" button opens it) so credentials are never typed here — a background
 * 401 can no longer yank a half-typed form out from under the user. When signed
 * in this shows the sync controls, the auto-sync toggle, and the auth state.
 */
export function SyncSection({
  cfg,
  update,
}: {
  cfg: ServerConfig;
  update: (patch: Partial<ServerConfig>) => void;
}) {
  const currentUser = useStore((s) => s.currentUser);
  const openLogin = useStore((s) => s.openLogin);
  const baseDomain = useStore((s) => s.baseDomain);
  const signedIn = !!currentUser && !currentUser.open;

  function signOut() {
    void doSignOut();
  }

  return (
    <SettingsSection
      id="sync"
      testId="settings-sync"
      title="Sync server"
      description="Carbon works fully offline. Log in to a Carbon server to sync across devices. Stay logged out to keep everything local-only."
    >
      <div className="space-y-3">
        {/* Auth state sits above the controls so you can see who you're signed in
            as before toggling background sync. */}
        {signedIn && currentUser && (
          <div className="flex items-center gap-2 text-sm text-text-muted">
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

        {/* Signed in: background-sync toggle */}
        {signedIn && (
          <SettingsToggle
            label="Sync automatically in the background"
            checked={cfg.autoSync}
            onChange={(v) => update({ autoSync: v })}
          />
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {!signedIn && (
            <button onClick={openLogin} className={btnPrimary}>
              Login
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
          {/* Workspace deletion is a hosted (multi-tenant) concept and runs its own
              email-OTC flow, so it's reachable here regardless of sign-in state. */}
          {baseDomain && (
            <Link
              to="/delete-account"
              className="flex items-center gap-2 rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-500 hover:bg-red-500/10"
            >
              Delete account
            </Link>
          )}
        </div>

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

        <div className="pt-1">
          <DocLink href={LINKS.dataSecurity}>How your data is secured</DocLink>
        </div>
      </div>
    </SettingsSection>
  );
}
