import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { billingProvider } from './billing-provider';

test('simulation requires explicit non-production configuration', () => {
  for (const env of [{}, { NODE_ENV: 'production', CARBON_BILLING_SIMULATION: '1' },
    { NODE_ENV: 'test', ENV: 'production', CARBON_BILLING_SIMULATION: '1' }, { NODE_ENV: 'test' }]) {
    assert.equal(billingProvider(false, env), 'unavailable');
  }
  assert.equal(billingProvider(false, { NODE_ENV: 'test', CARBON_BILLING_SIMULATION: '1' }), 'simulate');
  assert.equal(billingProvider(true, { NODE_ENV: 'production' }), 'square');
});

test('real production routes cannot grant a paid period without a provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-billing-closed-'));
  Object.assign(process.env, { CARBON_NO_AUTOSTART: '1', NODE_ENV: 'production', CARBON_BILLING_SIMULATION: '1',
    DATABASE_PATH: join(dir, 'default/carbon.db'), CONTROL_DB_PATH: join(dir, 'control.db'), BLOBS_DIR: join(dir, 'default/blobs') });
  for (const key of Object.keys(process.env)) if (key.startsWith('SQUARE_')) delete process.env[key];
  const { buildTenantApp } = await import('./index');
  const { openControlDb, provisionTenant, getTenantById } = await import('./control');
  const { initTenantDb } = await import('./tenant');
  const { createSession } = await import('./auth');
  const control = openControlDb(process.env.CONTROL_DB_PATH!);
  const rec = provisionTenant(control, join(dir, 'tenants'), { subdomain: 'review', adminUsername: 'admin', adminPassword: 'test-password' });
  const ctx = initTenantDb({ id: rec.id, subdomain: rec.subdomain, dbPath: rec.db_path, blobsDir: rec.blobs_dir });
  const user = ctx.db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', ['admin'])!;
  const token = createSession(ctx.db, user.id);
  const app = buildTenantApp(ctx, async () => new Response('', { status: 501 }));
  const expiry = getTenantById(control, rec.id)?.expires_at;
  for (const [path, status] of [['subscribe', 503], ['simulate', 400]] as const) {
    const res = await app.fetch(new Request(`http://test/api/billing/${path}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: 'y1' }) }));
    assert.equal(res.status, status);
  }
  assert.equal(getTenantById(control, rec.id)?.expires_at, expiry);
  assert.equal(control.get<{ n: number }>('SELECT count(*) AS n FROM subscriptions')?.n, 0);
  ctx.db.raw.close();
});
