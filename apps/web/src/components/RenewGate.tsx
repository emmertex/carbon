import { useEffect, useState } from 'react';
import { Loader2, Lock, Check } from 'lucide-react';
import { useStore } from '@/lib/store';
import { getBillingInfo, checkout, formatPrice, type BillingPlan } from '@/lib/billing';
import { fetchHostInfo } from '@/lib/sync';

/**
 * Soft lock gate shown when a workspace's subscription has lapsed (expired or
 * operator-locked). Reads stay available behind it; the admin can renew here to lift
 * the gate. Non-admins are told to ask their admin.
 */
export function RenewGate() {
  const currentUser = useStore((s) => s.currentUser);
  const expiresAt = useStore((s) => s.workspaceExpiresAt);
  const isAdmin = currentUser?.role === 'admin';

  const [plans, setPlans] = useState<BillingPlan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBillingInfo()
      .then((info) => setPlans(info.plans))
      .catch((e) => setError((e as Error).message));
  }, []);

  async function subscribe(planId: string) {
    setBusy(planId);
    setError(null);
    try {
      await checkout(planId);
      // Re-read health so the lock flag clears and the app renders normally.
      await fetchHostInfo();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

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

        {!isAdmin ? (
          <div className="rounded-lg border border-border bg-surface-2 p-4 text-sm text-text-muted">
            Ask a workspace admin to renew the subscription. You can still view your existing tasks
            in the meantime.
          </div>
        ) : (
          <>
            {plans === null && !error ? (
              <p className="text-sm text-text-muted">Loading plans…</p>
            ) : (
              <div className="space-y-3">
                {plans?.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => subscribe(p.id)}
                    disabled={!!busy}
                    className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 text-sm hover:border-accent disabled:opacity-50"
                  >
                    <span className="font-medium">{p.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-text-muted">{formatPrice(p.priceCents)}</span>
                      {busy === p.id && <Loader2 className="animate-spin" size={15} />}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p className="mt-4 flex items-center gap-1.5 text-xs text-text-faint">
              <Check size={13} /> Demo checkout — no real payment is taken.
            </p>
          </>
        )}

        {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
      </div>
    </div>
  );
}
