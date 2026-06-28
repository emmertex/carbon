// Subscription billing. The checkout itself is a dummy in index.ts (no real payment
// provider yet), but the plan catalog + expiry extension live here so a real provider
// (e.g. Square) only has to swap the checkout/confirm glue and reuse extendExpiry().
import type { Db } from '@carbon/core';
import { setTenantExpiry } from './control';

export interface BillingPlan {
  id: string;
  label: string;
  /** Days of access this plan grants. */
  days: number;
  /** Price in cents (display only for the dummy flow). */
  priceCents: number;
}

export const BILLING_PLANS: BillingPlan[] = [
  { id: 'q3m', label: '3 months', days: 90, priceCents: 1500 },
  { id: 'y1', label: '1 year', days: 365, priceCents: 5000 },
];

export function listPlans(): BillingPlan[] {
  return BILLING_PLANS;
}

export function getPlan(planId: string): BillingPlan | undefined {
  return BILLING_PLANS.find((p) => p.id === planId);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Extend a tenant's access by a plan's duration and record the subscription. Stacks
 * from max(now, current expiry) so renewing early adds time rather than truncating.
 * Returns the new expiry (ISO) for the receipt/response. Does NOT clear an operator
 * lock (locked_at) — only the expiry-based lock lifts as the date moves forward.
 */
export function extendExpiry(
  controlDb: Db,
  tenantId: string,
  plan: BillingPlan,
  meta: { provider: string; externalId: string },
): string {
  const current = controlDb.get<{ expires_at: string | null }>(
    'SELECT expires_at FROM tenants WHERE id = ?',
    [tenantId],
  )?.expires_at;
  const now = Date.now();
  const base = current ? Math.max(now, Date.parse(current)) : now;
  const newExpiry = new Date(base + plan.days * DAY_MS).toISOString();

  controlDb.transaction(() => {
    setTenantExpiry(controlDb, tenantId, newExpiry);
    controlDb.run(
      `INSERT INTO subscriptions (tenant_id, provider, external_id, status, current_period_end)
       VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         provider = excluded.provider,
         external_id = excluded.external_id,
         status = 'active',
         current_period_end = excluded.current_period_end`,
      [tenantId, meta.provider, meta.externalId, newExpiry],
    );
  });
  return newExpiry;
}

export interface SubscriptionRow {
  tenant_id: string;
  provider: string | null;
  external_id: string | null;
  status: string | null;
  current_period_end: string | null;
}

export function getSubscription(controlDb: Db, tenantId: string): SubscriptionRow | null {
  return (
    controlDb.get<SubscriptionRow>('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenantId]) ??
    null
  );
}
