// Client for the workspace's subscription endpoints (/api/billing*), authed as the
// signed-in tenant admin. The provider is 'square' (real auto-renewing subscriptions,
// card collected via the Web Payments SDK) or 'simulate' (local pending→pay→renew→cancel).
import { getServerConfig, authHeaders } from './config';

export interface BillingPlan {
  id: string;
  label: string;
  cadence?: string;
  days: number;
  priceCents: number;
}

export interface SubscriptionInfo {
  provider: string | null;
  status: string | null; // 'pending' | 'active' | 'canceled' | 'past_due'
  plan_id: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  square_subscription_id: string | null;
}

export interface SquareConfig {
  appId: string;
  locationId: string;
  environment: string;
}

export interface BillingInfo {
  provider: 'square' | 'simulate';
  plans: BillingPlan[];
  expiresAt: string | null;
  locked: boolean;
  subscription: SubscriptionInfo | null;
  /** Workspace billing email on file (Square needs one); null prompts the admin for it. */
  billingEmail: string | null;
  square: SquareConfig | null;
}

function billingBase(): string {
  return getServerConfig().url || window.location.origin;
}

async function parseError(res: Response): Promise<string> {
  const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
  return msg || `request failed: ${res.status}`;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${billingBase()}${path}`, {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as T;
}

export async function getBillingInfo(): Promise<BillingInfo> {
  const res = await fetch(`${billingBase()}/api/billing`, {
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as BillingInfo;
}

/** Start/renew a subscription. Square requires a Web Payments SDK card token, and a
 *  billing email (passed when none is on file for the workspace). */
export async function subscribe(
  planId: string,
  cardToken?: string,
  email?: string,
): Promise<{ provider: string; status: string; subscriptionId: string }> {
  return post('/api/billing/subscribe', { planId, cardToken, email });
}

/** Simulate provider only: stand in for the payment webhook to complete the period. */
export async function simulatePayment(): Promise<{ expiresAt: string }> {
  return post('/api/billing/simulate');
}

/** Cancel auto-renewal. Access continues until the current period end. */
export async function cancelSubscription(): Promise<void> {
  await post('/api/billing/cancel');
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)} AUD`;
}
