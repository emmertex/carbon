import { Lock } from 'lucide-react';
import { useStore } from '@/lib/store';
import { BillingPanel } from './BillingPanel';

/**
 * Soft lock gate shown when a workspace's subscription has lapsed (expired or
 * operator-locked). Reads stay available behind it; an admin can renew here to lift the
 * gate. Non-admins are told to ask their admin.
 */
export function RenewGate() {
  const currentUser = useStore((s) => s.currentUser);
  const expiresAt = useStore((s) => s.workspaceExpiresAt);
  const isAdmin = currentUser?.role === 'admin';
  const lapsed = expiresAt ? new Date(expiresAt) < new Date() : true;

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-xl border border-border bg-surface p-6">
        <Lock className="mb-3 text-accent" size={26} />
        <h1 className="mb-1 text-xl font-semibold">
          {lapsed ? 'Subscription expired' : 'Workspace locked'}
        </h1>
        <p className="mb-6 text-sm text-text-muted">
          {lapsed
            ? 'Your workspace access has lapsed. Your data is safe and still readable — renew to start syncing and editing again.'
            : 'This workspace has been locked. Renew to restore full access.'}
        </p>

        {isAdmin ? (
          <BillingPanel />
        ) : (
          <div className="rounded-lg border border-border bg-surface-2 p-4 text-sm text-text-muted">
            Ask a workspace admin to renew the subscription. You can still view your existing tasks in
            the meantime.
          </div>
        )}
      </div>
    </div>
  );
}
