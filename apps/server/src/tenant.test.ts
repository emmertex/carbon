/**
 * Tests for tenant.ts's LRU registry: in-flight refcounting must not close a tenant's
 * DB handle out from under a concurrently-executing request, and a hot tenant should
 * be resolvable by subdomain without re-hitting the "control DB" resolve callback.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import {
  createTenantRegistry,
  initTenantDb,
  type TenantLocation,
  type FetchApp,
} from './tenant';

function makeLocation(id: string): TenantLocation {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-tenant-test-'));
  return { id, subdomain: id, dbPath: join(dir, 'db.sqlite'), blobsDir: join(dir, 'blobs') };
}

function makeRegistry(opts?: { cap?: number }) {
  const defaultLoc = makeLocation('default');
  const defaultCtx = initTenantDb(defaultLoc);
  const defaultApp: FetchApp = { fetch: () => new Response('default') };

  const locations = new Map<string, TenantLocation>();
  let resolveCalls = 0;

  const registry = createTenantRegistry({
    defaultCtx,
    defaultApp,
    resolve: (subdomain) => {
      resolveCalls++;
      return locations.get(subdomain) ?? null;
    },
    listActive: () => [...locations.values()],
    buildApp: (ctx) => ({
      // A "slow" app: fetch doesn't resolve until the test releases it.
      fetch: () => (ctx as unknown as { __pending: Promise<Response> }).__pending,
    }),
    cap: opts?.cap ?? 200,
  });

  function addTenant(id: string): TenantLocation {
    const loc = makeLocation(id);
    locations.set(id, loc);
    return loc;
  }

  return { registry, addTenant, getResolveCalls: () => resolveCalls };
}

describe('TenantRegistry: in-flight refcounting', () => {
  test('evict() does not close the DB handle while a request is still in flight', async () => {
    const { registry, addTenant } = makeRegistry();
    addTenant('t1');

    // Build the app manually so we control when the in-flight "request" finishes.
    const ctx = registry.getCtx('t1')!;
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((res) => (release = res));
    (ctx as unknown as { __pending: Promise<Response> }).__pending = pending;

    const app = registry.getApp('t1')!;
    const fetchPromise = app.fetch(new Request('http://test/x'));

    // Admin evicts the tenant (e.g. suspend) while the request above is still pending.
    registry.evict('t1');

    // The handle must still be usable — closing it would throw on any further access.
    assert.doesNotThrow(() => ctx.db.raw.prepare('SELECT 1').get());

    release(new Response('ok'));
    await fetchPromise;

    // Now that the in-flight request has finished, the deferred close should have run.
    assert.throws(() => ctx.db.raw.prepare('SELECT 1').get());
  });

  test('LRU cap eviction defers closing an in-flight tenant instead of closing it out from under the request', async () => {
    const { registry, addTenant } = makeRegistry({ cap: 1 });
    addTenant('busy');
    addTenant('other');

    const busyCtx = registry.getCtx('busy')!;
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((res) => (release = res));
    (busyCtx as unknown as { __pending: Promise<Response> }).__pending = pending;
    const busyApp = registry.getApp('busy')!;
    const fetchPromise = busyApp.fetch(new Request('http://test/x'));

    // Loading a second tenant pushes the cache over its cap of 1, evicting "busy" (the
    // only other cached entry) — but it's still in flight.
    const otherCtx = registry.getCtx('other')!;
    (otherCtx as unknown as { __pending: Promise<Response> }).__pending = Promise.resolve(
      new Response('ok'),
    );

    assert.doesNotThrow(() => busyCtx.db.raw.prepare('SELECT 1').get());

    release(new Response('ok'));
    await fetchPromise;

    assert.throws(() => busyCtx.db.raw.prepare('SELECT 1').get());
  });
});

describe('TenantRegistry: subdomain cache lookup', () => {
  test('a hot tenant resolves by subdomain without re-hitting resolve()', () => {
    const { registry, addTenant, getResolveCalls } = makeRegistry();
    addTenant('hot');

    registry.getCtx('hot'); // first access: cache miss, calls resolve()
    const callsAfterFirst = getResolveCalls();
    assert.equal(callsAfterFirst, 1);

    registry.getCtx('hot'); // second access: should hit the LRU cache directly
    registry.getApp('hot');
    assert.equal(getResolveCalls(), callsAfterFirst);
  });
});
