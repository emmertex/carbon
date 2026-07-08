/**
 * Billing webhook route tests — HTTP-layer coverage for host.post('/billing/webhook')
 * in index.ts.
 *
 * Mounting the real index.ts app is impractical: importing that module runs
 * `serve({ fetch: app.fetch, port: PORT })` at module scope (an unconditional side
 * effect — it opens a real listening socket, has no NODE_ENV/test guard, and would
 * collide across parallel test files). So instead we mount a minimal Hono app whose
 * single route is a byte-for-byte copy of the current webhook handler (see
 * apps/server/src/index.ts around line 2055), wired to the *real* production
 * functions it calls: verifyWebhookSignature + retrieveSubscription + planForVariation
 * from square.ts, and billingEventSeen / markBillingEvent / recordPaidPeriod /
 * setSubscriptionStatus / getPlan / getSubscription from billing.ts. Only
 * `tenantBySquareSub` and `applySquareInvoicePaid` are private closures inside
 * index.ts (not exported) — those are reproduced here verbatim (minus the
 * fire-and-forget billing-receipt email, which is not part of the webhook's
 * observable contract). Everything else in the route body below is copy-identical
 * to the real handler, so this exercises the real signature verification, real
 * idempotency/dedup logic, and real DB side effects — just not through the giant
 * process-level index.ts app.
 *
 * square.ts reads SQUARE_WEBHOOK_SIGNATURE_KEY / SQUARE_WEBHOOK_URL into module-scope
 * constants at import time, so those env vars must be set *before* the module is
 * first imported. We do that with a dynamic import() inside `before()`.
 */
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { Db } from '@carbon/core';
import { openControlDb } from './control';
import {
  billingEventSeen,
  markBillingEvent,
  recordPaidPeriod,
  setSubscriptionStatus,
  getSubscription,
  getPlan,
} from './billing';

const WEBHOOK_KEY = 'test-webhook-signature-key';
const WEBHOOK_URL = 'https://carbon.test/billing/webhook';

let verifyWebhookSignature: (raw: string, sig: string | undefined) => boolean;
let retrieveSubscription: (id: string) => Promise<{
  id: string;
  status: string;
  chargedThrough: string | null;
  planVariationId: string | null;
}>;
let planForVariation: (variationId: string) => string | undefined;

let savedFetch: typeof globalThis.fetch;

before(async () => {
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = WEBHOOK_KEY;
  process.env.SQUARE_WEBHOOK_URL = WEBHOOK_URL;
  const square = await import('./square');
  verifyWebhookSignature = square.verifyWebhookSignature;
  retrieveSubscription = square.retrieveSubscription;
  planForVariation = square.planForVariation;
  savedFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = savedFetch;
  delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete process.env.SQUARE_WEBHOOK_URL;
});

function sign(raw: string): string {
  return createHmac('sha256', WEBHOOK_KEY).update(WEBHOOK_URL + raw).digest('base64');
}

/** Stub the Square subscription-retrieval API call so tests don't hit the network.
 *  retrieveSubscription() calls global fetch internally; override it for the
 *  duration of a test and restore afterward. */
function stubSquareSubscription(sub: {
  id: string;
  status?: string;
  charged_through_date?: string;
  plan_variation_id?: string;
}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ subscription: sub }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
}

function tenantBySquareSub(controlDb: Db, subscriptionId: string): string | null {
  return (
    controlDb.get<{ tenant_id: string }>(
      'SELECT tenant_id FROM subscriptions WHERE square_subscription_id = ?',
      [subscriptionId],
    )?.tenant_id ?? null
  );
}

/** Reproduction of index.ts's applySquareInvoicePaid (see comment at top of file):
 *  identical control flow, minus the fire-and-forget receipt email side effect. */
async function applySquareInvoicePaid(controlDb: Db, subscriptionId: string): Promise<boolean> {
  const tenantId = tenantBySquareSub(controlDb, subscriptionId);
  if (!tenantId) return false;
  const sub = await retrieveSubscription(subscriptionId);
  const planId =
    (sub.planVariationId && planForVariation(sub.planVariationId)) ||
    getSubscription(controlDb, tenantId)?.plan_id ||
    '';
  const plan = getPlan(planId);
  if (!plan) return true;
  recordPaidPeriod(controlDb, tenantId, plan, {
    provider: 'square',
    externalId: subscriptionId,
    chargedThrough: sub.chargedThrough,
    squareSubscriptionId: subscriptionId,
  });
  return true;
}

/** Byte-for-byte copy of host.post('/billing/webhook') from index.ts. */
function buildWebhookApp(controlDb: Db) {
  const app = new Hono();
  app.post('/billing/webhook', async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header('x-square-hmacsha256-signature');
    if (!verifyWebhookSignature(raw, sig)) return c.json({ error: 'bad signature' }, 401);
    let event: {
      event_id?: string;
      type?: string;
      data?: {
        object?: {
          invoice?: { subscription_id?: string };
          subscription?: { id?: string; status?: string };
        };
      };
    };
    try {
      event = JSON.parse(raw);
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }
    const eventId = event.event_id;
    const type = event.type ?? '';
    if (!eventId) return c.json({ error: 'no event id' }, 400);
    if (billingEventSeen(controlDb, eventId)) return c.json({ ok: true });
    const obj = event.data?.object ?? {};
    try {
      if (type === 'invoice.payment_made') {
        const subId = obj.invoice?.subscription_id;
        if (subId && !(await applySquareInvoicePaid(controlDb, subId))) {
          return c.json({ error: 'unknown subscription' }, 503);
        }
      } else if (type === 'invoice.payment_failed') {
        const tId = obj.invoice?.subscription_id
          ? tenantBySquareSub(controlDb, obj.invoice.subscription_id)
          : null;
        if (tId) setSubscriptionStatus(controlDb, tId, 'past_due');
      } else if (type === 'subscription.updated') {
        const s = obj.subscription;
        if (s?.id && (s.status === 'CANCELED' || s.status === 'DEACTIVATED')) {
          const tId = tenantBySquareSub(controlDb, s.id);
          if (tId) setSubscriptionStatus(controlDb, tId, 'canceled', { canceledAt: new Date().toISOString() });
        }
      }
      markBillingEvent(controlDb, eventId, type);
    } catch (e) {
      return c.json({ error: 'handling failed' }, 500);
    }
    return c.json({ ok: true });
  });
  return app;
}

function openTestControlDb(): Db {
  return openControlDb(':memory:');
}

function insertTenant(db: Db, id: string, subdomain: string, expiresAt: string | null = null) {
  db.run(
    `INSERT INTO tenants (id, subdomain, status, created_at, db_path, blobs_dir, expires_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    [id, subdomain, new Date().toISOString(), `/tmp/${id}.db`, `/tmp/${id}-blobs`, expiresAt],
  );
}

function postWebhook(app: Hono, body: unknown, opts: { sign?: boolean; badSig?: boolean; rawOverride?: string } = {}) {
  const raw = opts.rawOverride ?? JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.badSig) {
    headers['x-square-hmacsha256-signature'] = 'not-a-real-signature==';
  } else if (opts.sign !== false) {
    headers['x-square-hmacsha256-signature'] = sign(raw);
  }
  return app.request('/billing/webhook', { method: 'POST', headers, body: raw });
}

// ─── signature verification ───────────────────────────────────────────────────

describe('webhook: signature verification', () => {
  test('missing signature header is rejected with 401, no event recorded', async () => {
    const db = openTestControlDb();
    const app = buildWebhookApp(db);
    const body = { event_id: 'evt-nosig', type: 'invoice.payment_made', data: { object: {} } };
    const res = await postWebhook(app, body, { sign: false });
    assert.equal(res.status, 401);
    assert.equal(billingEventSeen(db, 'evt-nosig'), false);
  });

  test('invalid signature is rejected with 401, no event recorded', async () => {
    const db = openTestControlDb();
    const app = buildWebhookApp(db);
    const body = { event_id: 'evt-badsig', type: 'invoice.payment_made', data: { object: {} } };
    const res = await postWebhook(app, body, { badSig: true });
    assert.equal(res.status, 401);
    const json = (await res.json()) as { error?: string };
    assert.equal(json.error, 'bad signature');
    assert.equal(billingEventSeen(db, 'evt-badsig'), false);
  });

  test('valid signature over the exact raw body is accepted', async () => {
    const db = openTestControlDb();
    const app = buildWebhookApp(db);
    const body = { event_id: 'evt-goodsig', type: 'subscription.updated', data: { object: {} } };
    const res = await postWebhook(app, body);
    assert.equal(res.status, 200);
    assert.equal(billingEventSeen(db, 'evt-goodsig'), true);
  });
});

// ─── malformed body ───────────────────────────────────────────────────────────

describe('webhook: malformed body', () => {
  test('valid signature but non-JSON body is rejected gracefully (400), not a crash', async () => {
    const db = openTestControlDb();
    const app = buildWebhookApp(db);
    const raw = 'not { valid json';
    const res = await postWebhook(app, null, { rawOverride: raw });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error?: string };
    assert.equal(json.error, 'bad json');
  });

  test('valid JSON but missing event_id is rejected with 400', async () => {
    const db = openTestControlDb();
    const app = buildWebhookApp(db);
    const res = await postWebhook(app, { type: 'invoice.payment_made', data: { object: {} } });
    assert.equal(res.status, 400);
  });
});

// ─── invoice.payment_made: unknown subscription ──────────────────────────────

describe('webhook: invoice.payment_made for an unknown subscription', () => {
  test('returns 503 and does NOT mark the event processed (Square should retry)', async () => {
    const db = openTestControlDb();
    const app = buildWebhookApp(db);
    const body = {
      event_id: 'evt-unknown-sub',
      type: 'invoice.payment_made',
      data: { object: { invoice: { subscription_id: 'sq-sub-does-not-exist' } } },
    };
    const res = await postWebhook(app, body);
    assert.equal(res.status, 503);
    assert.equal(billingEventSeen(db, 'evt-unknown-sub'), false, 'unknown-sub event must stay unmarked so Square retries');
  });
});

// ─── invoice.payment_made: known subscription, idempotent duplicate delivery ─

describe('webhook: invoice.payment_made for a known subscription', () => {
  test('applies the paid period, marks the event, and returns 200', async () => {
    const db = openTestControlDb();
    insertTenant(db, 'tenant-known', 'known');
    // Seed a subscription row already linked to a Square subscription id (as if
    // /billing/subscribe had already run).
    db.run(
      `INSERT INTO subscriptions (tenant_id, provider, status, plan_id, square_subscription_id)
       VALUES ('tenant-known', 'square', 'pending', 'q3m', 'sq-sub-known-1')`,
    );
    stubSquareSubscription({
      id: 'sq-sub-known-1',
      status: 'ACTIVE',
      charged_through_date: '2027-01-01T00:00:00.000Z',
      plan_variation_id: '', // unmapped — falls back to the existing subscription's plan_id
    });
    const app = buildWebhookApp(db);
    const body = {
      event_id: 'evt-known-1',
      type: 'invoice.payment_made',
      data: { object: { invoice: { subscription_id: 'sq-sub-known-1' } } },
    };
    const res = await postWebhook(app, body);
    assert.equal(res.status, 200);
    assert.equal(billingEventSeen(db, 'evt-known-1'), true);
    const sub = getSubscription(db, 'tenant-known');
    assert.equal(sub!.status, 'active');
    assert.equal(sub!.current_period_end, '2027-01-01T00:00:00.000Z');
  });

  test('redelivering the same event_id short-circuits 200 without double-extending the period', async () => {
    const db = openTestControlDb();
    insertTenant(db, 'tenant-dup', 'dupsub');
    db.run(
      `INSERT INTO subscriptions (tenant_id, provider, status, plan_id, square_subscription_id)
       VALUES ('tenant-dup', 'square', 'pending', 'q3m', 'sq-sub-dup-1')`,
    );
    stubSquareSubscription({
      id: 'sq-sub-dup-1',
      status: 'ACTIVE',
      charged_through_date: '2027-03-01T00:00:00.000Z',
      plan_variation_id: '',
    });
    const app = buildWebhookApp(db);
    const body = {
      event_id: 'evt-dup-1',
      type: 'invoice.payment_made',
      data: { object: { invoice: { subscription_id: 'sq-sub-dup-1' } } },
    };

    const first = await postWebhook(app, body);
    assert.equal(first.status, 200);
    const afterFirst = getSubscription(db, 'tenant-dup');
    assert.equal(afterFirst!.current_period_end, '2027-03-01T00:00:00.000Z');

    // Second delivery of the identical event_id: even though the (still-stubbed)
    // Square API would return the same charged_through_date, the handler must
    // short-circuit BEFORE calling applySquareInvoicePaid at all — verify that by
    // making the stub return a *different* charged_through_date and confirming the
    // period is NOT re-applied / bumped.
    stubSquareSubscription({
      id: 'sq-sub-dup-1',
      status: 'ACTIVE',
      charged_through_date: '2099-01-01T00:00:00.000Z',
      plan_variation_id: '',
    });
    const second = await postWebhook(app, body);
    assert.equal(second.status, 200);
    const afterSecond = getSubscription(db, 'tenant-dup');
    assert.equal(
      afterSecond!.current_period_end,
      '2027-03-01T00:00:00.000Z',
      'duplicate delivery must not re-run recordPaidPeriod (period must not change to the new stub value)',
    );
  });
});

// ─── status transitions ───────────────────────────────────────────────────────

describe('webhook: status transition events', () => {
  test('invoice.payment_failed marks the subscription past_due', async () => {
    const db = openTestControlDb();
    insertTenant(db, 'tenant-pd', 'pastdue');
    db.run(
      `INSERT INTO subscriptions (tenant_id, provider, status, plan_id, square_subscription_id)
       VALUES ('tenant-pd', 'square', 'active', 'q3m', 'sq-sub-pd-1')`,
    );
    const app = buildWebhookApp(db);
    const body = {
      event_id: 'evt-pastdue-1',
      type: 'invoice.payment_failed',
      data: { object: { invoice: { subscription_id: 'sq-sub-pd-1' } } },
    };
    const res = await postWebhook(app, body);
    assert.equal(res.status, 200);
    const sub = getSubscription(db, 'tenant-pd');
    assert.equal(sub!.status, 'past_due');
  });

  test('subscription.updated with CANCELED status marks the subscription canceled', async () => {
    const db = openTestControlDb();
    insertTenant(db, 'tenant-cancel', 'cancelme');
    db.run(
      `INSERT INTO subscriptions (tenant_id, provider, status, plan_id, square_subscription_id)
       VALUES ('tenant-cancel', 'square', 'active', 'q3m', 'sq-sub-cancel-1')`,
    );
    const app = buildWebhookApp(db);
    const body = {
      event_id: 'evt-cancel-1',
      type: 'subscription.updated',
      data: { object: { subscription: { id: 'sq-sub-cancel-1', status: 'CANCELED' } } },
    };
    const res = await postWebhook(app, body);
    assert.equal(res.status, 200);
    const sub = getSubscription(db, 'tenant-cancel');
    assert.equal(sub!.status, 'canceled');
    assert.ok(sub!.canceled_at, 'canceled_at stamped');
  });

  test('subscription.updated with DEACTIVATED status also marks canceled', async () => {
    const db = openTestControlDb();
    insertTenant(db, 'tenant-deact', 'deactme');
    db.run(
      `INSERT INTO subscriptions (tenant_id, provider, status, plan_id, square_subscription_id)
       VALUES ('tenant-deact', 'square', 'active', 'y1', 'sq-sub-deact-1')`,
    );
    const app = buildWebhookApp(db);
    const body = {
      event_id: 'evt-deact-1',
      type: 'subscription.updated',
      data: { object: { subscription: { id: 'sq-sub-deact-1', status: 'DEACTIVATED' } } },
    };
    const res = await postWebhook(app, body);
    assert.equal(res.status, 200);
    assert.equal(getSubscription(db, 'tenant-deact')!.status, 'canceled');
  });

  test('subscription.updated with an unrelated status (e.g. ACTIVE) is a no-op, still 200', async () => {
    const db = openTestControlDb();
    insertTenant(db, 'tenant-noop', 'noopme');
    db.run(
      `INSERT INTO subscriptions (tenant_id, provider, status, plan_id, square_subscription_id)
       VALUES ('tenant-noop', 'square', 'active', 'q3m', 'sq-sub-noop-1')`,
    );
    const app = buildWebhookApp(db);
    const body = {
      event_id: 'evt-noop-1',
      type: 'subscription.updated',
      data: { object: { subscription: { id: 'sq-sub-noop-1', status: 'ACTIVE' } } },
    };
    const res = await postWebhook(app, body);
    assert.equal(res.status, 200);
    assert.equal(getSubscription(db, 'tenant-noop')!.status, 'active', 'status untouched');
  });
});
