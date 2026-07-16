import { useEffect, useState } from 'react';
import { Loader2, Check, CreditCard } from 'lucide-react';
import {
  getBillingInfo,
  subscribe,
  simulatePayment,
  cancelSubscription,
  formatPrice,
  type BillingInfo,
  type BillingPlan,
} from '@/lib/billing';
import { fetchHostInfo } from '@/lib/sync';
import { SquareCardForm } from './SquareCardForm';
import { cn } from '@/lib/cn';
import { btnPrimary, btnDanger, inputCls, Field, ErrorText } from './ui/controls';

/**
 * Subscription lifecycle UI, shared by the Settings section and the RenewGate. Drives
 * the provider-aware flow: pick a plan → pay (Square card form, or simulate confirm) →
 * active with an expiry → cancel. After a successful payment it re-reads /api/health so
 * a lifted lock clears immediately.
 */
export function BillingPanel({ onChange }: { onChange?: () => void }) {
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string | null>(null); // plan chosen to start (Square card step)
  const [flash, setFlash] = useState(false);

  async function reload() {
    try {
      setInfo(await getBillingInfo());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  async function afterPayment() {
    await fetchHostInfo(); // clear any lock flag
    await reload();
    setSel(null);
    setFlash(true);
    setTimeout(() => setFlash(false), 2500);
    onChange?.();
  }

  async function startSimulate(planId: string) {
    setBusy(true);
    setError(null);
    try {
      await subscribe(planId); // creates a pending subscription
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function completeSimulate() {
    setBusy(true);
    setError(null);
    try {
      await simulatePayment();
      await afterPayment();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startSquare(planId: string, cardToken: string, email: string) {
    setBusy(true);
    setError(null);
    try {
      await subscribe(planId, cardToken, email);
      await afterPayment();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm('Cancel auto-renewal? Access continues until the current period ends.')) return;
    setBusy(true);
    setError(null);
    try {
      await cancelSubscription();
      await reload();
      onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (info === null) {
    return error ? (
      <ErrorText>{error}</ErrorText>
    ) : (
      <p className="text-sm text-text-muted">Loading…</p>
    );
  }

  const sub = info.subscription;
  const status = sub?.status ?? 'none';
  const expiry = info.expiresAt ? new Date(info.expiresAt) : null;
  const isSquare = info.provider === 'square';
  // An existing live subscription (offer cancel, hide the plan picker).
  const live = (status === 'active' || status === 'past_due') && !sub?.canceled_at;
  const currentPlan = sub?.plan_id ? info.plans.find((p) => p.id === sub.plan_id) : undefined;
  const price = currentPlan ? formatPrice(currentPlan.priceCents) : null;
  const dateStr = expiry?.toLocaleDateString();

  return (
    <div className="space-y-3">
      {/* Status */}
      <div className="space-y-0.5 text-sm">
        {status === 'none' ? (
          <span className="text-text-muted">No subscription yet.</span>
        ) : status === 'pending' ? (
          <span className="text-warning">Payment pending — complete it to activate.</span>
        ) : (
          <>
            <div>
              <span className="font-medium">{currentPlan?.label ?? 'Subscription'}</span>
              {price && (
                <span className="text-text-muted">
                  {' · '}
                  {price}
                  {isSquare ? '/cycle' : ''}
                </span>
              )}
              {flash && <Check size={14} className="ml-1 inline text-success" />}
            </div>
            {status === 'past_due' ? (
              <div className="text-danger">Last payment failed — please update payment.</div>
            ) : status === 'canceled' ? (
              <div className="text-text-muted">
                Canceled{dateStr && <> — access through <span className="font-medium">{dateStr}</span> (won't renew)</>}.
              </div>
            ) : dateStr ? (
              <div className="text-text-muted">
                {isSquare ? 'Next bill' : 'Access through'}{' '}
                <span className="font-medium">{dateStr}</span>
                {isSquare && price ? <> · {price}</> : null}.
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Pending (simulate): complete the test payment */}
      {status === 'pending' && info.provider === 'simulate' && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={completeSimulate}
            disabled={busy}
            className={cn(btnPrimary, 'px-3 py-1.5')}
          >
            {busy && <Loader2 className="animate-spin" size={14} />}
            <CreditCard size={14} /> Complete test payment
          </button>
          <button onClick={cancel} disabled={busy} className="text-sm text-text-muted hover:text-text">
            Cancel
          </button>
        </div>
      )}

      {/* Pending (square): waiting on the payment webhook */}
      {status === 'pending' && isSquare && (
        <p className="text-xs text-text-faint">
          Processing payment… this updates automatically once Square confirms.
        </p>
      )}

      {/* Live subscription: offer cancel */}
      {live && (
        <button
          onClick={cancel}
          disabled={busy}
          className={cn(btnDanger, 'px-3 py-1.5')}
        >
          {busy ? 'Working…' : 'Cancel auto-renewal'}
        </button>
      )}

      {/* Plan picker: shown when there's no live subscription and nothing pending */}
      {!live && status !== 'pending' && (
        <PlanPicker
          plans={info.plans}
          isSquare={isSquare}
          square={info.square}
          billingEmail={info.billingEmail}
          sel={sel}
          setSel={setSel}
          busy={busy}
          onSimulate={startSimulate}
          onSquareToken={startSquare}
        />
      )}

      <p className="text-xs text-text-faint">
        {isSquare
          ? 'Auto-renewing subscription billed via Square. Cancel anytime — access lasts through the paid period.'
          : 'Demo billing (no real charge). Renewing extends access from the later of today or the current expiry.'}
      </p>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function PlanPicker({
  plans,
  isSquare,
  square,
  billingEmail,
  sel,
  setSel,
  busy,
  onSimulate,
  onSquareToken,
}: {
  plans: BillingPlan[];
  isSquare: boolean;
  square: BillingInfo['square'];
  billingEmail: string | null;
  sel: string | null;
  setSel: (id: string | null) => void;
  busy: boolean;
  onSimulate: (planId: string) => void;
  onSquareToken: (planId: string, token: string, email: string) => void;
}) {
  const selectedPlan = plans.find((p) => p.id === sel);
  // Square requires a customer email. Use the one on file, else collect it here.
  const [email, setEmail] = useState(billingEmail ?? '');
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {plans.map((p) => {
          const active = sel === p.id;
          return (
            <button
              key={p.id}
              onClick={() => (isSquare ? setSel(active ? null : p.id) : onSimulate(p.id))}
              disabled={busy}
              className={
                'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 ' +
                (active ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent')
              }
            >
              <span className="font-medium">{p.label}</span>
              <span className="text-text-muted">
                {formatPrice(p.priceCents)}
                {isSquare ? '/cycle' : ''}
              </span>
            </button>
          );
        })}
      </div>

      {/* Square: once a plan is picked, collect a billing email (if none on file) and
          the card, then subscribe. */}
      {isSquare && selectedPlan && square && (
        <div className="space-y-3">
          {!billingEmail && (
            <Field
              label="Billing email"
              hint="Square emails your receipts and renewal invoices here."
            >
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoCapitalize="none"
                className={cn(inputCls, 'w-full')}
              />
            </Field>
          )}
          {emailOk ? (
            <SquareCardForm
              config={square}
              busy={busy}
              submitLabel={`Subscribe — ${selectedPlan.label} ${formatPrice(selectedPlan.priceCents)}`}
              onToken={(token) => onSquareToken(selectedPlan.id, token, email.trim())}
            />
          ) : (
            <p className="text-xs text-text-faint">Enter a billing email to continue.</p>
          )}
        </div>
      )}
    </div>
  );
}
