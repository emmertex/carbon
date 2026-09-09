import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { mkdirSync } from 'node:fs';
import { createUser, createItem } from '@carbon/core';
import { initTenantDb } from './tenant';
import { createSession } from './auth';
import type { DeliverToPeer } from './federation';

/**
 * REST list pagination (A4 — resolves A2 open question #2): `GET /api/tasks` used to
 * return every matching item in one response, so a large workspace could exceed the
 * response cap and 413. It is now paged by item count (limit + offset) with paging
 * metadata (total / has_more / next_offset). The sync hot path is already paged by
 * count AND byte (A2); this covers the full-list REST surface.
 */

const TMP = `/tmp/carbon-a4-rest-${process.pid}`;
process.env.DATABASE_PATH = `${TMP}/carbon.db`;
process.env.CONTROL_DB_PATH = `${TMP}/control.db`;
process.env.BLOBS_DIR = `${TMP}/blobs`;
process.env.CARBON_NO_AUTOSTART = '1';

const NO_DELIVERY: DeliverToPeer = async () =>
  new Response(JSON.stringify({ error: 'no delivery in test' }), { status: 501 });

let _build: typeof import('./index').buildTenantApp | null = null;
async function build(): Promise<typeof import('./index').buildTenantApp> {
  if (!_build) _build = (await import('./index')).buildTenantApp;
  return _build;
}

interface TaskPage {
  tasks: { id: string; title: string }[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
}

describe('GET /api/tasks — paged by count (A4)', () => {
  test('a 150-task workspace is paged, not 413; pages walk the full set exactly once', async () => {
    mkdirSync(`${TMP}/t`, { recursive: true });
    const ctx = initTenantDb({
      id: 'default',
      subdomain: '',
      dbPath: `${TMP}/t/carbon.db`,
      blobsDir: `${TMP}/blobs`,
    });
    const db = ctx.db;
    const bob = createUser(db, { username: 'bob', displayName: 'Bob' });
    const N = 150;
    for (let i = 0; i < N; i++) createItem(db, 'd', { title: `task-${i}`, ownerId: bob.id });

    const token = createSession(db, bob.id);
    const app = (await build())(ctx, NO_DELIVERY);
    const { appFetch } = await import('./test-app');

    // 1. Default (no params): first page of REST_PAGE_DEFAULT (100) + metadata, NOT a 413.
    const first = await appFetch(app, '/api/tasks', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(first.status, 200, 'a large list is paged, not 413');
    const p0 = (await first.json()) as TaskPage;
    assert.equal(p0.total, N, 'total reflects the whole filtered set');
    assert.equal(p0.tasks.length, 100, 'default page is REST_PAGE_DEFAULT (100)');
    assert.equal(p0.limit, 100);
    assert.equal(p0.offset, 0);
    assert.equal(p0.has_more, true);
    assert.equal(p0.next_offset, 100);

    // 2. Explicit small limit.
    const small = await appFetch(app, '/api/tasks?limit=5', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ps = (await small.json()) as TaskPage;
    assert.equal(ps.tasks.length, 5);
    assert.equal(ps.limit, 5);
    assert.equal(ps.has_more, true);

    // 3. Walk the whole set page by page (limit 100): every id exactly once, no 413.
    const seen = new Set<string>();
    let offset = 0;
    let pages = 0;
    for (;;) {
      const r = await appFetch(app, `/api/tasks?limit=100&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(r.status, 200, `page at offset ${offset} is 200, not 413`);
      const page = (await r.json()) as TaskPage;
      for (const t of page.tasks) {
        assert.ok(!seen.has(t.id), `no duplicate id ${t.id} across pages`);
        seen.add(t.id);
      }
      offset = page.next_offset ?? -1;
      pages++;
      if (!page.has_more) break;
      assert.ok(pages < 10, 'sanity: bounded number of pages');
    }
    assert.equal(seen.size, N, 'walking pages returns the full set exactly once');
    assert.equal(pages, 2, '150 items at limit 100 = exactly 2 pages');
  });

  test('limit is hard-capped at REST_PAGE_MAX so one page can never blow the response budget', async () => {
    mkdirSync(`${TMP}/t2`, { recursive: true });
    const ctx = initTenantDb({
      id: 'default',
      subdomain: '',
      dbPath: `${TMP}/t2/carbon.db`,
      blobsDir: `${TMP}/blobs2`,
    });
    const db = ctx.db;
    const bob = createUser(db, { username: 'bob', displayName: 'Bob' });
    for (let i = 0; i < 5; i++) createItem(db, 'd', { title: `t-${i}`, ownerId: bob.id });
    const token = createSession(db, bob.id);
    const app = (await build())(ctx, NO_DELIVERY);
    const { appFetch } = await import('./test-app');

    // Ask for far more than the max; the server clamps to REST_PAGE_MAX (and to the
    // available items here). The point: `limit` is bounded, never unbounded.
    const r = await appFetch(app, '/api/tasks?limit=999999999', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const p = (await r.json()) as TaskPage;
    assert.equal(r.status, 200);
    assert.ok(p.limit <= 1000, `limit is clamped (got ${p.limit})`);
    assert.ok(p.tasks.length <= p.limit);
  });

  test('perspective/project filters still apply before paging', async () => {
    mkdirSync(`${TMP}/t3`, { recursive: true });
    const ctx = initTenantDb({
      id: 'default',
      subdomain: '',
      dbPath: `${TMP}/t3/carbon.db`,
      blobsDir: `${TMP}/blobs3`,
    });
    const db = ctx.db;
    const bob = createUser(db, { username: 'bob', displayName: 'Bob' });
    // 3 tasks, 2 flagged.
    for (let i = 0; i < 3; i++)
      createItem(db, 'd', { title: `t-${i}`, ownerId: bob.id, flagged: i < 2 });
    const token = createSession(db, bob.id);
    const app = (await build())(ctx, NO_DELIVERY);
    const { appFetch } = await import('./test-app');

    const r = await appFetch(app, '/api/tasks?perspective=flagged', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const p = (await r.json()) as TaskPage;
    assert.equal(p.total, 2, 'perspective filter narrows the set before paging');
    assert.equal(p.tasks.length, 2);
    assert.ok(p.tasks.every((t) => t.title.startsWith('t-')));
  });
});
