import assert from 'node:assert/strict';
import { test, describe, afterEach } from 'node:test';
import { isPrivateIp, assertSafeEndpoint, safeFetch, EndpointError } from './safe-fetch';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub globalThis.fetch with a fixed URL -> response table, keyed by exact request URL. */
function stubFetch(table: Record<string, { status: number; location?: string; body?: string }>) {
  globalThis.fetch = (async (url: string | URL) => {
    const key = String(url);
    const r = table[key];
    if (!r) throw new Error(`unexpected fetch to ${key}`);
    return new Response(r.body ?? '', {
      status: r.status,
      headers: r.location ? { location: r.location } : {},
    });
  }) as typeof fetch;
}

describe('isPrivateIp', () => {
  test('IPv4 private/loopback/link-local/CGNAT ranges are blocked', () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('10.0.0.5'), true);
    assert.equal(isPrivateIp('172.16.0.1'), true);
    assert.equal(isPrivateIp('172.31.255.255'), true);
    assert.equal(isPrivateIp('192.168.1.1'), true);
    assert.equal(isPrivateIp('169.254.169.254'), true); // cloud metadata
    assert.equal(isPrivateIp('100.64.0.1'), true); // CGNAT
    assert.equal(isPrivateIp('0.0.0.0'), true);
  });
  test('IPv4 public addresses are allowed', () => {
    assert.equal(isPrivateIp('8.8.8.8'), false);
    assert.equal(isPrivateIp('1.1.1.1'), false);
    assert.equal(isPrivateIp('172.32.0.1'), false); // just outside 172.16/12
    assert.equal(isPrivateIp('100.63.0.1'), false); // just outside CGNAT
  });
  test('IPv6 loopback/link-local/ULA/mapped ranges are blocked', () => {
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('fe80::1'), true);
    assert.equal(isPrivateIp('fc00::1'), true);
    assert.equal(isPrivateIp('fd12::1'), true);
    assert.equal(isPrivateIp('::ffff:10.0.0.5'), true); // IPv4-mapped private
    assert.equal(isPrivateIp('::ffff:169.254.169.254'), true);
    // Hex-group form of ::ffff:0:0/96 (Node/some resolvers emit this instead of dotted-quad).
    assert.equal(isPrivateIp('::ffff:7f00:1'), true); // 127.0.0.1
    assert.equal(isPrivateIp('::ffff:0a00:1'), true); // 10.0.0.1
    assert.equal(isPrivateIp('::ffff:a9fe:a9fe'), true); // 169.254.169.254
    assert.equal(isPrivateIp('::ffff:c0a8:1'), true); // 192.168.0.1
    // Fully-expanded IPv4-mapped forms.
    assert.equal(isPrivateIp('0:0:0:0:0:ffff:127.0.0.1'), true);
    assert.equal(isPrivateIp('0:0:0:0:0:ffff:7f00:1'), true);
  });
  test('IPv6 public addresses are allowed', () => {
    assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
    assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
    assert.equal(isPrivateIp('::ffff:808:808'), false); // hex form of 8.8.8.8
    assert.equal(isPrivateIp('0:0:0:0:0:ffff:8.8.8.8'), false);
  });
  test('NAT64-embedded private IPv4 is blocked in both address forms', () => {
    assert.equal(isPrivateIp('64:ff9b::a9fe:a9fe'), true); // hex form, 169.254.169.254
    assert.equal(isPrivateIp('64:ff9b::169.254.169.254'), true); // RFC 6052 dotted form
    assert.equal(isPrivateIp('64:ff9b::a00:1'), true); // hex form, 10.0.0.1
  });
  test('NAT64-embedded public IPv4 is allowed', () => {
    assert.equal(isPrivateIp('64:ff9b::808:808'), false); // hex form, 8.8.8.8
    assert.equal(isPrivateIp('64:ff9b::8.8.8.8'), false); // dotted form
  });
});

describe('assertSafeEndpoint', () => {
  test('rejects malformed URLs and non-http(s) protocols', async () => {
    await assert.rejects(() => assertSafeEndpoint('not a url', false), EndpointError);
    await assert.rejects(() => assertSafeEndpoint('ftp://example.com/', false), EndpointError);
  });
  test('rejects localhost and private/loopback IP literals', async () => {
    await assert.rejects(() => assertSafeEndpoint('http://localhost/', false), EndpointError);
    await assert.rejects(() => assertSafeEndpoint('http://foo.localhost/', false), EndpointError);
    await assert.rejects(() => assertSafeEndpoint('http://127.0.0.1/', false), EndpointError);
    await assert.rejects(() => assertSafeEndpoint('http://169.254.169.254/', false), EndpointError);
    await assert.rejects(() => assertSafeEndpoint('http://[::1]/', false), EndpointError);
    await assert.rejects(() => assertSafeEndpoint('http://[::ffff:7f00:1]/', false), EndpointError);
    await assert.rejects(
      () => assertSafeEndpoint('http://[0:0:0:0:0:ffff:169.254.169.254]/', false),
      EndpointError,
    );
  });
  test('allows public IP literals', async () => {
    await assert.doesNotReject(() => assertSafeEndpoint('http://8.8.8.8/', false));
  });
  test('allowPrivate bypasses the guard entirely', async () => {
    await assert.doesNotReject(() => assertSafeEndpoint('http://127.0.0.1/', true));
    await assert.doesNotReject(() => assertSafeEndpoint('http://localhost/', true));
  });
});

describe('safeFetch redirect handling', () => {
  test('a redirect from a public target to cloud metadata is blocked', async () => {
    stubFetch({
      'http://8.8.8.8/start': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    });
    await assert.rejects(() => safeFetch('http://8.8.8.8/start', false), EndpointError);
  });
  test('a redirect from a public target to loopback is blocked', async () => {
    stubFetch({
      'http://8.8.8.8/start': { status: 302, location: 'http://127.0.0.1:8080/admin' },
    });
    await assert.rejects(() => safeFetch('http://8.8.8.8/start', false), EndpointError);
  });
  test('a redirect between two public targets is followed and returned', async () => {
    stubFetch({
      'http://8.8.8.8/start': { status: 302, location: 'http://1.1.1.1/final' },
      'http://1.1.1.1/final': { status: 200, body: 'ok' },
    });
    const res = await safeFetch('http://8.8.8.8/start', false);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
  test('gives up after too many redirect hops', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const key = String(url);
      const next = key === 'http://8.8.8.8/a' ? 'http://1.1.1.1/b' : 'http://8.8.8.8/a';
      return new Response('', { status: 302, headers: { location: next } });
    }) as typeof fetch;
    await assert.rejects(() => safeFetch('http://8.8.8.8/a', false), EndpointError);
  });
  test('redirects into private space are blocked for a POST webhook call too', async () => {
    stubFetch({
      'http://8.8.8.8/webhook': { status: 303, location: 'http://10.0.0.5/internal' },
    });
    await assert.rejects(
      () => safeFetch('http://8.8.8.8/webhook', false, { method: 'POST', body: '{}' }),
      EndpointError,
    );
  });
});

describe('safeFetch credential headers across redirects', () => {
  /** Like stubFetch, but records the headers each hop was actually called with. */
  function recordingStub(table: Record<string, { status: number; location?: string }>) {
    const hops: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const key = String(url);
      const r = table[key];
      if (!r) throw new Error(`unexpected fetch to ${key}`);
      hops.push({ url: key, headers: Object.fromEntries(new Headers(init?.headers ?? {})) });
      return new Response('', {
        status: r.status,
        headers: r.location ? { location: r.location } : {},
      });
    }) as typeof fetch;
    return hops;
  }

  const secrets = {
    Authorization: 'Bearer sk-live-abc',
    'x-api-key': 'sk-live-abc',
    'x-carbon-secret': 'webhook-secret',
    'x-federation-secret': 'link-secret',
    Cookie: 'session=1',
    'content-type': 'application/json',
    'user-agent': 'carbon/1.0',
  };

  test('a cross-origin redirect drops the credentials but keeps ordinary headers', async () => {
    const hops = recordingStub({
      'http://8.8.8.8/llm': { status: 307, location: 'http://1.1.1.1/steal' },
      'http://1.1.1.1/steal': { status: 200 },
    });
    await safeFetch('http://8.8.8.8/llm', false, { method: 'POST', body: '{}', headers: secrets });
    assert.equal(hops[0].headers['authorization'], 'Bearer sk-live-abc');
    for (const name of [
      'authorization',
      'x-api-key',
      'x-carbon-secret',
      'x-federation-secret',
      'cookie',
    ]) {
      assert.equal(hops[1].headers[name], undefined, `${name} must not reach the new origin`);
    }
    assert.equal(hops[1].headers['content-type'], 'application/json');
    assert.equal(hops[1].headers['user-agent'], 'carbon/1.0');
  });

  test('a same-origin redirect keeps them (the common /path -> /path/ case)', async () => {
    const hops = recordingStub({
      'http://8.8.8.8/dav': { status: 301, location: 'http://8.8.8.8/dav/' },
      'http://8.8.8.8/dav/': { status: 200 },
    });
    await safeFetch('http://8.8.8.8/dav', false, { headers: { Authorization: 'Basic dXNlcjpwdw==' } });
    assert.equal(hops[1].headers['authorization'], 'Basic dXNlcjpwdw==');
  });

  test('an https -> http downgrade on the same host still drops them', async () => {
    const hops = recordingStub({
      'https://8.8.8.8/api': { status: 302, location: 'http://8.8.8.8/api' },
      'http://8.8.8.8/api': { status: 200 },
    });
    await safeFetch('https://8.8.8.8/api', false, { headers: secrets });
    assert.equal(hops[1].headers['authorization'], undefined);
  });

  test('credentials do not come back when a later hop returns to the original origin', async () => {
    const hops = recordingStub({
      'http://8.8.8.8/a': { status: 302, location: 'http://1.1.1.1/b' },
      'http://1.1.1.1/b': { status: 302, location: 'http://8.8.8.8/c' },
      'http://8.8.8.8/c': { status: 200 },
    });
    await safeFetch('http://8.8.8.8/a', false, { headers: secrets });
    assert.equal(hops[1].headers['authorization'], undefined);
    assert.equal(hops[2].headers['authorization'], undefined);
  });
});
