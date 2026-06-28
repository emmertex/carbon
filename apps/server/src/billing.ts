// Subscription billing — provider-neutral persistence + expiry math. The actual
// charging is done by a provider: Square (real, auto-renewing) when configured, or a
// local "simulate" provider otherwise. Both funnel paid periods through
// recordPaidPeriod() so the tenant-expiry + subscriptions-row bookkeeping is identical.
import type { Db } from '@carbon/core';
import { setTenantExpiry } from './control';

/** Square billing cadence for a plan (used to create the catalog variation / cycle). */
export type Cadence = 'QUARTERLY' | 'ANNUAL';

export interface BillingPlan {
  id: string;
  label: string;
  cadence: Cadence;
  /** Nominal days per cycle — used by the simulate provider and as a webhook fallback. */
  days: number;
  /** Price in cents (display + the simulate provider; Square uses its own catalog price). */
  priceCents: number;
}

// Prices are AUD (display only — Square charges its own catalog price; keep them in sync).
export const BILLING_PLANS: BillingPlan[] = [
  { id: 'q3m', label: '3 months', cadence: 'QUARTERLY', days: 91, priceCents: 750 },
  { id: 'y1', label: '1 year', cadence: 'ANNUAL', days: 365, priceCents: 2000 },
];

export function listPlans(): BillingPlan[] {
  return BILLING_PLANS;
}

export function getPlan(planId: string): BillingPlan | undefined {
  return BILLING_PLANS.find((p) => p.id === planId);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionRow {
  tenant_id: string;
  provider: string | null;
  external_id: string | null;
  status: string | null; // 'pending' | 'active' | 'canceled' | 'past_due'
  current_period_end: string | null;
  square_customer_id: string | null;
  square_subscription_id: string | null;
  plan_id: string | null;
  canceled_at: string | null;
}

export function getSubscription(controlDb: Db, tenantId: string): SubscriptionRow | null {
  return (
    controlDb.get<SubscriptionRow>('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenantId]) ??
    null
  );
}

/** Upsert the subscription row for a tenant, patching only the provided fields. */
export function upsertSubscription(
  controlDb: Db,
  tenantId: string,
  fields: Partial<Omit<SubscriptionRow, 'tenant_id'>>,
): void {
  const existing = getSubscription(controlDb, tenantId);
  const merged: SubscriptionRow = {
    tenant_id: tenantId,
    provider: fields.provider ?? existing?.provider ?? null,
    external_id: fields.external_id ?? existing?.external_id ?? null,
    status: fields.status ?? existing?.status ?? null,
    current_period_end: fields.current_period_end ?? existing?.current_period_end ?? null,
    square_customer_id: fields.square_customer_id ?? existing?.square_customer_id ?? null,
    square_subscription_id: fields.square_subscription_id ?? existing?.square_subscription_id ?? null,
    plan_id: fields.plan_id ?? existing?.plan_id ?? null,
    canceled_at: 'canceled_at' in fields ? (fields.canceled_at ?? null) : (existing?.canceled_at ?? null),
  };
  controlDb.run(
    `INSERT INTO subscriptions
       (tenant_id, provider, external_id, status, current_period_end,
        square_customer_id, square_subscription_id, plan_id, canceled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       provider = excluded.provider,
       external_id = excluded.external_id,
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       square_customer_id = excluded.square_customer_id,
       square_subscription_id = excluded.square_subscription_id,
       plan_id = excluded.plan_id,
       canceled_at = excluded.canceled_at`,
    [
      merged.tenant_id,
      merged.provider,
      merged.external_id,
      merged.status,
      merged.current_period_end,
      merged.square_customer_id,
      merged.square_subscription_id,
      merged.plan_id,
      merged.canceled_at,
    ],
  );
}

/** Mark a subscription's status (e.g. 'canceled', 'past_due'), optionally stamping
 *  canceled_at. Does NOT touch tenant expiry — access stays until current_period_end. */
export function setSubscriptionStatus(
  controlDb: Db,
  tenantId: string,
  status: string,
  opts: { canceledAt?: string | null } = {},
): void {
  upsertSubscription(controlDb, tenantId, {
    status,
    ...('canceledAt' in opts ? { canceled_at: opts.canceledAt ?? null } : {}),
  });
}

/**
 * Record a paid billing period: extend tenant access and update the subscription row.
 * Expiry = chargedThrough (Square's source of truth) when given, else stacked from
 * max(now, current expiry) + the plan's cadence in days. Returns the new expiry (ISO).
 * Does NOT clear an operator lock (locked_at) — only the expiry-based lock lifts.
 */
export function recordPaidPeriod(
  controlDb: Db,
  tenantId: string,
  plan: BillingPlan,
  meta: {
    provider: string;
    externalId: string;
    chargedThrough?: string | null; // ISO; Square charged_through_date
    squareCustomerId?: string | null;
    squareSubscriptionId?: string | null;
  },
): string {
  const current = controlDb.get<{ expires_at: string | null }>(
    'SELECT expires_at FROM tenants WHERE id = ?',
    [tenantId],
  )?.expires_at;
  const now = Date.now();
  const base = current ? Math.max(now, Date.parse(current)) : now;
  const newExpiry = meta.chargedThrough
    ? new Date(meta.chargedThrough).toISOString()
    : new Date(base + plan.days * DAY_MS).toISOString();

  controlDb.transaction(() => {
    setTenantExpiry(controlDb, tenantId, newExpiry);
    upsertSubscription(controlDb, tenantId, {
      provider: meta.provider,
      external_id: meta.externalId,
      status: 'active',
      current_period_end: newExpiry,
      plan_id: plan.id,
      canceled_at: null, // a fresh paid period clears any prior cancellation
      ...(meta.squareCustomerId ? { square_customer_id: meta.squareCustomerId } : {}),
      ...(meta.squareSubscriptionId ? { square_subscription_id: meta.squareSubscriptionId } : {}),
    });
  });
  return newExpiry;
}

/** Apply a provider event at most once. Returns true if this is the first time we've
 *  seen eventId (caller should process), false if it's a duplicate (skip). */
export function markBillingEvent(controlDb: Db, eventId: string, type: string): boolean {
  try {
    controlDb.run('INSERT INTO billing_events (event_id, type, received_at) VALUES (?, ?, ?)', [
      eventId,
      type,
      new Date().toISOString(),
    ]);
    return true;
  } catch {
    return false; // PRIMARY KEY conflict → already processed
  }
}
