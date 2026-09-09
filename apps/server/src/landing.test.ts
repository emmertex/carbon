import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { landingRoutes } from './landing';

test('production landing middleware serves static apex and keeps app roots and routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carbon-landing-'));
  try {
    writeFileSync(
      join(root, 'landing.html'),
      '<html><head><link rel="canonical" href="https://carbon.etx.sx/" /></head><body data-workspace-domain=""><h1>Marketing</h1><a href="/local">Try locally</a><a href="/signup">Signup</a></body></html>',
    );
    writeFileSync(join(root, 'index.html'), '<h1>App shell</h1>');
    const app = new Hono();
    app.route(
      '/',
      landingRoutes({
        root,
        baseDomain: 'custom.test',
        appHost: 'offline',
        isApex: (h) => ['custom.test', 'www.custom.test'].includes(h.split(':')[0]),
      }),
    );
    app.get('*', (c) => c.text('app fallback'));
    const request = (path: string, host: string) =>
      app.request(`http://${host}${path}`, { headers: { host } });
    const apex = await request('/', 'custom.test:3042');
    const html = await apex.text();
    assert.equal(apex.status, 200);
    assert.match(apex.headers.get('content-type')!, /text\/html/);
    assert.match(html, /href="\/\/offline.custom.test:3042\/local"/);
    assert.match(html, /href="https:\/\/custom.test\/"/);
    assert.match(html, /href="\/signup"/);
    assert.match(html, /data-workspace-domain="custom.test"/);
    for (const host of ['offline.custom.test', 'work.custom.test', 'missing.custom.test']) {
      assert.equal(await (await request('/', host)).text(), 'app fallback');
    }
    for (const path of ['/today', '/signup', '/privacy', '/host-admin', '/delete-account']) {
      assert.equal(await (await request(path, 'custom.test')).text(), 'app fallback');
    }
    const tenantLocal = await request('/local', 'work.custom.test:3042');
    assert.equal(tenantLocal.headers.get('location'), '//offline.custom.test:3042/local');
    assert.match(
      await (await request('/landing', 'work.custom.test:3042')).text(),
      /href="\/\/offline.custom.test:3042\/local"/,
    );
    const local = await request('/local', 'custom.test:3042');
    assert.equal(local.status, 302);
    assert.equal(local.headers.get('location'), '//offline.custom.test:3042/local');
    assert.match(await (await request('/local', 'offline.custom.test')).text(), /App shell/);
    assert.match(await (await request('/', 'www.custom.test')).text(), /Marketing/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('single-tenant root remains the app and explicit landing keeps same-origin local use', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carbon-landing-'));
  try {
    writeFileSync(join(root, 'landing.html'), '<a href="/local">Try locally</a>');
    writeFileSync(join(root, 'index.html'), 'app shell');
    const app = new Hono();
    app.route(
      '/',
      landingRoutes({
        root,
        baseDomain: '',
        appHost: 'app',
        isApex: () => false,
      }),
    );
    app.get('*', (c) => c.text('app fallback'));
    assert.equal(await (await app.request('/')).text(), 'app fallback');
    assert.equal(await (await app.request('/landing')).text(), '<a href="/local">Try locally</a>');
    assert.equal(await (await app.request('/local')).text(), 'app shell');
  } finally {
    rmSync(root, { recursive: true });
  }
});
