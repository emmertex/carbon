import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { Hono } from 'hono';
import {
  stampedClientIp,
  CARBON_REAL_IP_HEADER,
  xffClientIp,
  ipInAnyCidr,
  clientIp,
} from './client-ip';

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

describe('ipInAnyCidr', () => {
  test('matches IPv4 CIDRs, bare addresses, and rejects the rest', () => {
    const cidrs = ['10.0.0.0/8', '198.51.100.7', '172.16.5.0/24'];
    assert.ok(ipInAnyCidr('10.1.2.3', cidrs));
    assert.ok(ipInAnyCidr('198.51.100.7', cidrs));
    assert.ok(ipInAnyCidr('172.16.5.99', cidrs));
    assert.ok(!ipInAnyCidr('172.16.6.1', cidrs));
    assert.ok(!ipInAnyCidr('8.8.8.8', cidrs));
    assert.ok(!ipInAnyCidr('::1', cidrs));
    assert.ok(ipInAnyCidr('::1', ['::1'])); // non-IPv4 → exact match
  });

  test('rejects malformed CIDR entries', () => {
    assert.ok(!ipInAnyCidr('10.1.2.3', ['10.0.0.0/33']));
    assert.ok(!ipInAnyCidr('10.1.2.3', ['not-an-ip/8']));
  });
});

describe('xffClientIp (pure resolution)', () => {
  const CIDRS = ['10.0.0.0/8'];

  test('no XFF → the (unspoofable) TCP peer', () => {
    assert.equal(xffClientIp('10.0.0.2', undefined, CIDRS), '10.0.0.2');
    assert.equal(xffClientIp('10.0.0.2', '  , ', CIDRS), '10.0.0.2');
  });

  test('single proxy: rightmost entry is the real client the proxy appended', () => {
    // client can prepend junk on the left; the proxy appends the real client at the
    // right end — the walk returns it.
    assert.equal(
      xffClientIp('10.0.0.2', '1.1.1.1, 2.2.2.2, 203.0.113.9', CIDRS),
      '203.0.113.9',
    );
  });

  test('proxy chain: skips the innermost proxy hop, returns the client', () => {
    // XFF = [junk, client, P1], TCP peer = P2 (both proxies trusted). The naive
    // "last hop" would return P1 — the proxy — not the client.
    assert.equal(xffClientIp('10.0.0.3', '1.1.1.1, 203.0.113.9, 10.0.0.1', CIDRS), '203.0.113.9');
  });

  test('TCP peer not a trusted proxy → XFF is contaminated, return the peer', () => {
    assert.equal(
      xffClientIp('8.8.8.8', '1.1.1.1, 203.0.113.9, 10.0.0.1', CIDRS),
      '8.8.8.8',
    );
  });

  test('all entries trusted (pathological) → the TCP peer', () => {
    assert.equal(xffClientIp('10.0.0.3', '10.0.0.1, 10.0.0.2', CIDRS), '10.0.0.3');
  });

  test('empty cidrs → legacy last-hop (single-proxy assumption)', () => {
    assert.equal(xffClientIp('10.0.0.2', '1.1.1.1, 203.0.113.9', []), '203.0.113.9');
  });
});

describe('clientIp (env wiring, no Node server → no conninfo)', () => {
  const saved: [string, string | undefined] = [
    process.env.TRUST_PROXY ?? '',
    process.env.TRUST_PROXY_CIDRS,
  ];
  beforeEach(() => {
    delete process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY_CIDRS;
  });
  afterEach(() => {
    process.env.TRUST_PROXY = saved[0] || undefined;
    process.env.TRUST_PROXY_CIDRS = saved[1];
  });

  function probe(xff?: string): Promise<string> {
    const app = new Hono();
    app.get('/', (c) => c.text(clientIp(c)));
    return Promise.resolve(
      app.fetch(new Request('http://t/', xff ? { headers: { 'x-forwarded-for': xff } } : undefined)),
    ).then((r) => r.text());
  }

  test('default: XFF is never read (no conninfo → unknown)', async () => {
    assert.equal(await probe('1.1.1.1, 2.2.2.2'), 'unknown');
  });

  test('TRUST_PROXY=1, no CIDRs: last XFF hop (legacy single-proxy mode)', async () => {
    process.env.TRUST_PROXY = '1';
    assert.equal(await probe('1.1.1.1, 203.0.113.9'), '203.0.113.9');
  });

  test('TRUST_PROXY=1, no XFF: the TCP peer (unknown here without conninfo)', async () => {
    process.env.TRUST_PROXY = '1';
    assert.equal(await probe(undefined), 'unknown');
  });
});
