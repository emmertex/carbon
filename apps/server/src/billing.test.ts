/**
 * Billing function tests — direct tests against the control DB (no HTTP server).
 * The billing HTTP routes are tightly coupled to the tenant context + Square SDK,
 * so we test the underlying persistence layer here. A separate simulate-flow section
 * exercises the pending→paid lifecycle end-to-end via the billing functions.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '@carbon/core';
import { openControlDb } from './control';
import {
  listPlans,
  getPlan,
  getSubscription,
  upsertSubscription,
  recordPaidPeriod,
  setSubscriptionStatus,
  markBillingEvent,
  BILLING_PLANS,
} from './billing';

function openTestControlDb(): Db {
  // Control DB uses its own schema, not the tenant schema. Use a real :memory: path.
  // openControlDb calls openDb internally; pass the :memory: path directly.
  return openControlDb(':memory:');
}

// ─── plan catalogue ───────────────────────────────────────────────────────────

describe('listPlans / getPlan', () => {
  test('listPlans returns the full billing plan catalogue', () => {
    const plans = listPlans();
    assert.ok(plans.length >= 2, 'at least two plans defined');
    for (const p of plans) {
      assert.ok(p.id, 'plan has an id');
      assert.ok(p.label, 'plan has a label');
      assert.ok(p.days > 0, 'plan has positive days');
      assert.ok(p.priceCents > 0, 'plan has a price');
    }
  });

  test('getPlan finds a plan by id', () => {
    const plan = getPlan('q3m');
    assert.ok(plan, 'quarterly plan found');
    assert.equal(plan!.id, 'q3m');
    assert.equal(plan!.cadence, 'QUARTERLY');
  });

  test('getPlan returns undefined for unknown id', () => {
    assert.equal(getPlan('bogus'), undefined);
  });

  test('BILLING_PLANS and listPlans are consistent', () => {
    assert.deepEqual(listPlans(), BILLING_PLANS);
  });
});

// ─── subscription CRUD ────────────────────────────────────────────────────────

describe('subscription persistence', () => {
  test('getSubscription returns null when no subscription exists', () => {
    const db = openTestControlDb();
    assert.equal(getSubscription(db, 'tenant-1'), null);
  });

  test('upsertSubscription creates a subscription row', () => {
    const db = openTestControlDb();
    // Need a tenant row first (foreign key is OFF in test, but insert to be safe)
    db.run(
      `INSERT INTO tenants (id, subdomain, status, created_at, db_path, blobs_dir)
       VALUES ('t1', 'test', 'active', ?, '/tmp/t1.db', '/tmp/t1-blobs')`,
      [new Date().toISOString()],
    );
    upsertSubscription(db, 't1', {
      provider: 'simulate',
      status: 'pending',
      plan_id: 'q3m',
      external_id: 'sim_abc',
    });
    const sub = getSubscription(db, 't1');
    assert.ok(sub, 'subscription created');
    assert.equal(sub!.provider, 'simulate');
    assert.equal(sub!.status, 'pending');
    assert.equal(sub!.plan_id, 'q3m');
  });

  test('upsertSubscription is idempotent — later call wins', () => {
    const db = openTestControlDb();
    db.run(
      `INSERT INTO tenants (id, subdomain, status, created_at, db_path, blobs_dir)
       VALUES ('t2', 'test2', 'active', ?, '/tmp/t2.db', '/tmp/t2-blobs')`,
      [new Date().toISOString()],
    );
    upsertSubscription(db, 't2', { provider: 'simulate', status: 'pending', plan_id: 'q3m' });
    upsertSubscription(db, 't2', { status: 'active' });
    const sub = getSubscription(db, 't2');
    assert.equal(sub!.status, 'active');
    assert.equal(sub!.provider, 'simulate', 'earlier fields preserved');
  });
});

// ─── paid period recording ────────────────────────────────────────────────────

describe('recordPaidPeriod', () => {
  test('extends tenant expiry by plan days from now', () => {
    const db = openTestControlDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO tenants (id, subdomain, status, created_at, db_path, blobs_dir, expires_at)
       VALUES ('t3', 'test3', 'active', ?, '/tmp/t3.db', '/tmp/t3-blobs', NULL)`,
      [now],
    );
    const plan = getPlan('q3m')!;
    const newExpiry = recordPaidPeriod(db, 't3', plan, {
      provider: 'simulate',
      externalId: 'sim_x',
    });
    assert.ok(newExpiry, 'returns new expiry');
    const expiryDate = new Date(newExpiry);
    const expectedMin = Date.now() + (plan.days - 1) * 24 * 3600 * 1000;
    assert.ok(expiryDate.getTime() > expectedMin, 'expiry is in the future');

    // Subscription row should now be 'active'
    const sub = getSubscription(db, 't3');
    assert.equal(sub!.status, 'active');
    assert.equal(sub!.plan_id, 'q3m');
  });

  test('chargedThrough overrides the day-based calculation', () => {
    const db = openTestControlDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO tenants (id, subdomain, status, created_at, db_path, blobs_dir)
       VALUES ('t4', 'test4', 'active', ?, '/tmp/t4.db', '/tmp/t4-blobs')`,
      [now],
    );
    const plan = getPlan('y1')!;
    const chargedThrough = '2027-06-28T00:00:00.000Z';
    const newExpiry = recordPaidPeriod(db, 't4', plan, {
      provider: 'simulate',
      externalId: 'sim_y',
      chargedThrough,
    });
    assert.equal(newExpiry, chargedThrough, 'expiry matches chargedThrough exactly');
  });

  test('stacks from current expiry when renewing an existing subscription', () => {
    const db = openTestControlDb();
    const soon = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(); // expires in 10 days
    db.run(
      `INSERT INTO tenants (id, subdomain, status, created_at, db_path, blobs_dir, expires_at)
       VALUES ('t5', 'test5', 'active', ?, '/tmp/t5.db', '/tmp/t5-blobs', ?)`,
      [new Date().toISOString(), soon],
    );
    const plan = getPlan('q3m')!; // 91 days
    const newExpiry = recordPaidPeriod(db, 't5', plan, {
      provider: 'simulate',
      externalId: 'sim_z',
    });
    const delta = new Date(newExpiry).getTime() - new Date(soon).getTime();
    const approxDays = delta / (24 * 3600 * 1000);
    assert.ok(approxDays > 80, 'renewal stacks from current expiry');
  });
});

// ─── subscription status update ──────────────────────────────────────────────

describe('setSubscriptionStatus', () => {
  test('marks subscription as canceled with a timestamp', () => {
    const db = openTestControlDb();
    db.run(
      `INSERT INTO tenants (id, subdomain, status, created_at, db_path, blobs_dir)
       VALUES ('t6', 'test6', 'active', ?, '/tmp/t6.db', '/tmp/t6-blobs')`,
      [new Date().toISOString()],
    );
    upsertSubscription(db, 't6', { provider: 'simulate', status: 'active', plan_id: 'q3m' });
    const canceledAt = new Date().toISOString();
    setSubscriptionStatus(db, 't6', 'canceled', { canceledAt });
    const sub = getSubscription(db, 't6');
    assert.equal(sub!.status, 'canceled');
    assert.equal(sub!.canceled_at, canceledAt);
  });
});

// ─── billing event idempotency ────────────────────────────────────────────────

describe('markBillingEvent', () => {
  test('first event returns true', () => {
    const db = openTestControlDb();
    assert.equal(markBillingEvent(db, 'evt-001', 'invoice.payment_made'), true);
  });

  test('duplicate event returns false (already seen)', () => {
    const db = openTestControlDb();
    markBillingEvent(db, 'evt-002', 'invoice.payment_made');
    assert.equal(markBillingEvent(db, 'evt-002', 'invoice.payment_made'), false);
  });

  test('different event IDs are independent', () => {
    const db = openTestControlDb();
    assert.equal(markBillingEvent(db, 'evt-A', 'invoice.payment_made'), true);
    assert.equal(markBillingEvent(db, 'evt-B', 'invoice.payment_made'), true);
    assert.equal(markBillingEvent(db, 'evt-A', 'invoice.payment_made'), false);
    assert.equal(markBillingEvent(db, 'evt-B', 'invoice.payment_made'), false);
  });
});

// ─── simulate provider full flow ─────────────────────────────────────────────

describe('simulate provider flow: pending → paid → cancel', () => {
  test('subscribe → simulate → cancel lifecycle', () => {
    const db = openTestControlDb();
    const tenantId = 'sim-tenant';
    const created_at = new Date().toISOString();
    db.run(
      `INSERT INTO tenants (id, subdomain, status, created_at, db_path, blobs_dir)
       VALUES (?, 'simtenant', 'active', ?, '/tmp/st.db', '/tmp/st-blobs')`,
      [tenantId, created_at],
    );

    // Step 1: subscribe → pending
    const plan = getPlan('q3m')!;
    const externalId = `sim_${Date.now()}`;
    upsertSubscription(db, tenantId, {
      provider: 'simulate',
      status: 'pending',
      plan_id: plan.id,
      external_id: externalId,
      canceled_at: null,
    });
    assert.equal(getSubscription(db, tenantId)!.status, 'pending');

    // Step 2: simulate payment → active, expiry extended
    const newExpiry = recordPaidPeriod(db, tenantId, plan, {
      provider: 'simulate',
      externalId,
    });
    assert.ok(newExpiry, 'expiry set after payment');
    assert.equal(getSubscription(db, tenantId)!.status, 'active');
    assert.equal(getSubscription(db, tenantId)!.canceled_at, null);

    // Step 3: cancel → canceled, access until period end
    const canceledAt = new Date().toISOString();
    setSubscriptionStatus(db, tenantId, 'canceled', { canceledAt });
    const sub = getSubscription(db, tenantId);
    assert.equal(sub!.status, 'canceled');
    assert.ok(sub!.canceled_at, 'canceled_at stamped');
    // expiry row in tenants is still in future (access doesn't drop immediately)
    const row = db.get<{ expires_at: string | null }>('SELECT expires_at FROM tenants WHERE id = ?', [
      tenantId,
    ]);
    assert.ok(row?.expires_at, 'tenant expiry still set after cancel');
    assert.ok(
      new Date(row!.expires_at!).getTime() > Date.now(),
      'access remains until period end',
    );
  });
});
