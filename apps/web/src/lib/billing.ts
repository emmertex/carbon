// Client for the workspace's own subscription endpoints (/api/billing*), authed as
// the signed-in tenant admin. Distinct from lib/host.ts, which manages the cross-tenant
// control plane with separate host-admin credentials.
import { getServerConfig, authHeaders } from './config';

export interface BillingPlan {
  id: string;
  label: string;
  days: number;
  priceCents: number;
}

export interface BillingInfo {
  plans: BillingPlan[];
  expiresAt: string | null;
  locked: boolean;
  subscription: {
    provider: string | null;
    status: string | null;
    current_period_end: string | null;
  } | null;
}

function billingBase(): string {
  // The workspace syncs to (and bills on) its own origin; fall back to the current one.
  return getServerConfig().url || window.location.origin;
}

async function parseError(res: Response): Promise<string> {
  const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
  return msg || `request failed: ${res.status}`;
}

export async function getBillingInfo(): Promise<BillingInfo> {
  const res = await fetch(`${billingBase()}/api/billing`, {
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as BillingInfo;
}

/** Dummy checkout: subscribe to a plan and extend the workspace expiry. Returns the
 *  new expiry date (ISO). A real provider would redirect to a hosted checkout first. */
export async function checkout(planId: string): Promise<{ expiresAt: string }> {
  const res = await fetch(`${billingBase()}/api/billing/checkout`, {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify({ planId }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { expiresAt: string };
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
