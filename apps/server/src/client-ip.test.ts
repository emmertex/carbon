import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Hono } from 'hono';
import { stampedClientIp, CARBON_REAL_IP_HEADER } from './client-ip';

describe('stampedClientIp', () => {
  test('reads the host-stamped real-IP header', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(stampedClientIp(c)));
    const res = await app.fetch(
      new Request('http://t/', { headers: { [CARBON_REAL_IP_HEADER]: '203.0.113.10' } }),
    );
    assert.equal(await res.text(), '203.0.113.10');
  });

  test('falls back to unknown when unset', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(stampedClientIp(c)));
    const res = await app.fetch(new Request('http://t/'));
    assert.equal(await res.text(), 'unknown');
  });
});
