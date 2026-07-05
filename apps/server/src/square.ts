// Square provider for auto-renewing subscriptions. Talks to the Square Connect REST
// API directly (no SDK dependency). Active only when SQUARE_* env is configured;
// otherwise billing falls back to the local "simulate" provider (see index.ts).
//
// Flow: collect a card token client-side (Web Payments SDK) → CreateCustomer →
// CreateCard (card on file) → CreateSubscription. Square then auto-charges each cycle
// and fires invoice.payment_made webhooks, which extend the workspace expiry.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { BILLING_PLANS } from './billing';

const ENV = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN?.trim() || '';
const LOCATION_ID = process.env.SQUARE_LOCATION_ID?.trim() || '';
const APP_ID = process.env.SQUARE_APP_ID?.trim() || '';
const WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim() || '';
// The exact public URL Square is configured to POST webhooks to (part of the HMAC).
const WEBHOOK_URL = process.env.SQUARE_WEBHOOK_URL?.trim() || '';
const SQUARE_VERSION = '2024-10-17';

// plan id -> Square catalog subscription-plan-variation id (set one up per plan in the
// Square dashboard and put the ids here).
const PLAN_VARIATIONS: Record<string, string> = {
  q3m: process.env.SQUARE_PLAN_Q3M?.trim() || '',
  y1: process.env.SQUARE_PLAN_Y1?.trim() || '',
};

export function isSquareConfigured(): boolean {
  return !!(ACCESS_TOKEN && LOCATION_ID && APP_ID && PLAN_VARIATIONS.q3m && PLAN_VARIATIONS.y1);
}

/** Public config the web client needs to mount the Web Payments SDK card form. */
export function squareClientConfig(): { appId: string; locationId: string; environment: string } {
  return { appId: APP_ID, locationId: LOCATION_ID, environment: ENV };
}

export function planVariationId(planId: string): string | undefined {
  return PLAN_VARIATIONS[planId] || undefined;
}

/** Reverse map a Square plan-variation id back to our plan id (for webhook handling). */
export function planForVariation(variationId: string): string | undefined {
  return Object.keys(PLAN_VARIATIONS).find((id) => PLAN_VARIATIONS[id] === variationId);
}

function apiBase(): string {
  return ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

interface SquareError {
  errors?: { category?: string; code?: string; detail?: string }[];
}

async function squareFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parseFailed = false;
  const json = (await res.json().catch(() => {
    parseFailed = true;
    return {};
  })) as T & SquareError;
  if (!res.ok) {
    const msg = json.errors?.map((e) => e.detail || e.code).join('; ') || `Square ${res.status}`;
    throw new Error(`Square API: ${msg}`);
  }
  if (parseFailed) {
    // The request succeeded (2xx) but the body wasn't valid JSON — surface this distinctly
    // from a genuinely-missing field so it's not mistaken for a normal API response shape.
    console.error(`[carbon] Square ${method} ${path}: response body was not valid JSON (status ${res.status})`);
  }
  return json;
}

/** Create a Square customer for a workspace (reference_id = tenant id). */
export async function createCustomer(input: {
  tenantId: string;
  email?: string | null;
  name?: string | null;
}): Promise<string> {
  const json = await squareFetch<{ customer?: { id?: string } }>('/v2/customers', 'POST', {
    idempotency_key: randomUUID(),
    reference_id: input.tenantId,
    given_name: input.name || undefined,
    email_address: input.email || undefined,
  });
  const id = json.customer?.id;
  if (!id) throw new Error('Square: customer creation returned no id');
  return id;
}

/** Ensure an existing customer carries an email (Square requires one to subscribe). */
export async function updateCustomer(
  customerId: string,
  fields: { email?: string | null; name?: string | null },
): Promise<void> {
  await squareFetch(`/v2/customers/${customerId}`, 'PUT', {
    email_address: fields.email || undefined,
    given_name: fields.name || undefined,
  });
}

/** Store a card on file for a customer from a Web Payments SDK token. Returns card id. */
export async function createCard(customerId: string, cardToken: string): Promise<string> {
  const json = await squareFetch<{ card?: { id?: string } }>('/v2/cards', 'POST', {
    idempotency_key: randomUUID(),
    source_id: cardToken,
    card: { customer_id: customerId },
  });
  const id = json.card?.id;
  if (!id) throw new Error('Square: card creation returned no id');
  return id;
}

export interface SquareSubscription {
  id: string;
  status: string; // PENDING | ACTIVE | CANCELED | DEACTIVATED | PAUSED
  chargedThrough: string | null; // charged_through_date (YYYY-MM-DD), once billed
  planVariationId: string | null;
}

function toSub(s: {
  id?: string;
  status?: string;
  charged_through_date?: string;
  plan_variation_id?: string;
}): SquareSubscription {
  return {
    id: s.id ?? '',
    status: s.status ?? 'UNKNOWN',
    chargedThrough: s.charged_through_date ?? null,
    planVariationId: s.plan_variation_id ?? null,
  };
}

/** Create an auto-renewing subscription billed to a card on file. */
export async function createSubscription(input: {
  customerId: string;
  cardId: string;
  planId: string;
}): Promise<SquareSubscription> {
  const variationId = planVariationId(input.planId);
  if (!variationId) throw new Error(`no Square plan variation configured for plan "${input.planId}"`);
  const json = await squareFetch<{ subscription?: Record<string, string> }>(
    '/v2/subscriptions',
    'POST',
    {
      idempotency_key: randomUUID(),
      location_id: LOCATION_ID,
      plan_variation_id: variationId,
      customer_id: input.customerId,
      card_id: input.cardId,
    },
  );
  if (!json.subscription?.id) throw new Error('Square: subscription creation returned no id');
  return toSub(json.subscription);
}

export async function retrieveSubscription(subscriptionId: string): Promise<SquareSubscription> {
  const json = await squareFetch<{ subscription?: Record<string, string> }>(
    `/v2/subscriptions/${subscriptionId}`,
    'GET',
  );
  if (!json.subscription) throw new Error('Square: subscription not found');
  return toSub(json.subscription);
}

/** Cancel at the end of the current paid period (access remains until charged_through). */
export async function cancelSubscription(subscriptionId: string): Promise<SquareSubscription> {
  const json = await squareFetch<{ subscription?: Record<string, string> }>(
    `/v2/subscriptions/${subscriptionId}/cancel`,
    'POST',
  );
  if (!json.subscription) throw new Error('Square: cancel returned no subscription');
  return toSub(json.subscription);
}

/**
 * Verify a Square webhook signature: HMAC-SHA256 over (notificationUrl + rawBody) keyed
 * by the webhook signature key, base64-encoded, compared to x-square-hmacsha256-signature.
 * Requires SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_URL to be set.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  if (!WEBHOOK_SIGNATURE_KEY || !WEBHOOK_URL || !signature) return false;
  const expected = createHmac('sha256', WEBHOOK_SIGNATURE_KEY)
    .update(WEBHOOK_URL + rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export { BILLING_PLANS };
