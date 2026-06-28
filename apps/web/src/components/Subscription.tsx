import { useEffect, useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import { getBillingInfo, checkout, formatPrice, type BillingInfo } from '@/lib/billing';
import { fetchHostInfo } from '@/lib/sync';
import { SettingsSection } from './settings/SettingsSection';
import { ErrorText } from './settings/controls';

/** Workspace admin: view subscription status and renew/extend ahead of expiry. */
export function Subscription() {
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  async function load() {
    try {
      setInfo(await getBillingInfo());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function subscribe(planId: string) {
    setBusy(planId);
    setError(null);
    try {
      await checkout(planId);
      await fetchHostInfo(); // clear any lock flag
      await load();
      setFlash(true);
      setTimeout(() => setFlash(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const expiry = info?.expiresAt ? new Date(info.expiresAt) : null;
  const expired = expiry ? expiry < new Date() : false;

  return (
    <SettingsSection id="subscription" title="Subscription">
      {info === null && !error ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          <p className="mb-3 text-sm">
            {expiry ? (
              <>
                Access{' '}
                <span className={expired ? 'font-medium text-red-500' : 'font-medium'}>
                  {expired ? 'expired' : 'active'}
                </span>{' '}
                {expired ? 'on' : 'through'}{' '}
                <span className="font-medium">{expiry.toLocaleDateString()}</span>.
              </>
            ) : (
              <span className="text-text-muted">This workspace has no expiry set.</span>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            {info?.plans.map((p) => (
              <button
                key={p.id}
                onClick={() => subscribe(p.id)}
                disabled={!!busy}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
              >
                {busy === p.id && <Loader2 className="animate-spin" size={14} />}
                {flash && busy === null ? <Check size={14} className="text-green-500" /> : null}
                <span className="font-medium">{p.label}</span>
                <span className="text-text-muted">{formatPrice(p.priceCents)}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-faint">
            Demo checkout — no real payment is taken. Renewing extends access from the later of today
            or the current expiry.
          </p>
          <ErrorText>{error}</ErrorText>
        </>
      )}
    </SettingsSection>
  );
}
