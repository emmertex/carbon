import assert from 'node:assert/strict';
import { test, describe, afterEach } from 'node:test';
import { geocodeConfigFromEnv, makeOsmProvider } from './geocode';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(json: unknown, ok = true) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(json), { status: ok ? 200 : 500 })) as typeof fetch;
}

describe('geocodeConfigFromEnv', () => {
  test('defaults on for single-tenant, off for multi-tenant', () => {
    assert.equal(geocodeConfigFromEnv({}, false).enabled, true);
    assert.equal(geocodeConfigFromEnv({}, true).enabled, false);
  });
  test('explicit env overrides the default', () => {
    assert.equal(geocodeConfigFromEnv({ CARBON_GEOCODE_ENABLED: '0' }, false).enabled, false);
    assert.equal(geocodeConfigFromEnv({ CARBON_GEOCODE_ENABLED: 'true' }, true).enabled, true);
  });
  test('custom endpoints honoured', () => {
    const cfg = geocodeConfigFromEnv(
      { CARBON_NOMINATIM_URL: 'http://nom.lan/', CARBON_OVERPASS_URL: 'http://op.lan/api' },
      false,
    );
    assert.equal(cfg.nominatimUrl, 'http://nom.lan');
    assert.equal(cfg.overpassUrl, 'http://op.lan/api');
  });
});

describe('makeOsmProvider', () => {
  test('returns null when disabled', () => {
    const cfg = geocodeConfigFromEnv({ CARBON_GEOCODE_ENABLED: '0' }, false);
    assert.equal(makeOsmProvider(cfg, true), null);
  });

  test('nearestBrand picks the closest Overpass element', async () => {
    const near = { lat: -37.8, lng: 145.0 };
    stubFetch({
      elements: [
        { lat: -37.9, lon: 145.1, tags: { name: 'Coles Far' } }, // ~14 km
        { lat: -37.81, lon: 145.01, tags: { name: 'Coles Near' } }, // ~1.4 km
      ],
    });
    const cfg = geocodeConfigFromEnv({}, false);
    const provider = makeOsmProvider(cfg, true)!;
    const hit = await provider.nearestBrand('coles', near);
    assert.equal(hit?.label, 'Coles Near');
  });

  test('non-2xx Overpass then empty Nominatim → null', async () => {
    stubFetch({ elements: [] }, false); // every fetch returns 500
    const cfg = geocodeConfigFromEnv({}, false);
    const provider = makeOsmProvider(cfg, true)!;
    const hit = await provider.nearestBrand('coles', { lat: -37.8, lng: 145.0 });
    assert.equal(hit, null);
  });

  test('thrown fetch error degrades to null (no throw)', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as typeof fetch;
    const cfg = geocodeConfigFromEnv({}, false);
    const provider = makeOsmProvider(cfg, true)!;
    const hit = await provider.nearestBrand('coles', { lat: -37.8, lng: 145.0 });
    assert.equal(hit, null);
  });

  test('search returns distance-sorted candidates, capped by limit', async () => {
    const near = { lat: -37.8, lng: 145.0 };
    stubFetch({
      elements: [
        { lat: -37.95, lon: 145.15, tags: { name: 'Coles Far' } }, // ~21 km
        { lat: -37.81, lon: 145.01, tags: { name: 'Coles Near' } }, // ~1.4 km
        { lat: -37.85, lon: 145.05, tags: { name: 'Coles Mid' } }, // ~7 km
      ],
    });
    const provider = makeOsmProvider(geocodeConfigFromEnv({}, false), true)!;
    const hits = await provider.search('coles', near, { limit: 2 });
    assert.deepEqual(
      hits.map((h) => h.label),
      ['Coles Near', 'Coles Mid'],
    );
  });

  test('search enriches the label with the suburb when addr:suburb is present', async () => {
    stubFetch({
      elements: [
        { lat: -37.81, lon: 145.01, tags: { name: 'Coles', 'addr:suburb': 'Ringwood' } },
        { lat: -37.82, lon: 145.02, tags: { name: 'Woolworths' } }, // no locality → name only
      ],
    });
    const provider = makeOsmProvider(geocodeConfigFromEnv({}, false), true)!;
    const hits = await provider.search('co', { lat: -37.8, lng: 145.0 });
    assert.equal(hits[0].label, 'Coles, Ringwood');
    assert.equal(hits[1].label, 'Woolworths');
  });

  test('search falls back to Nominatim with addressdetails-derived suburb', async () => {
    let nominatimUrl = '';
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/search')) {
        nominatimUrl = url;
        return new Response(
          JSON.stringify([
            { lat: '-37.81', lon: '145.01', name: 'Coles', address: { suburb: 'Croydon' } },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 }); // Overpass empty
    }) as typeof fetch;
    const provider = makeOsmProvider(geocodeConfigFromEnv({}, false), true)!;
    const hits = await provider.search('coles', { lat: -37.8, lng: 145.0 });
    assert.equal(hits[0].label, 'Coles, Croydon');
    assert.match(nominatimUrl, /addressdetails=1/);
  });

  test('Overpass query strips regex metacharacters and sends the configured User-Agent', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    }) as typeof fetch;
    const provider = makeOsmProvider(geocodeConfigFromEnv({}, false), true)!;
    await provider.search('co.*les|woolies', { lat: -37.8, lng: 145.0 });
    const overpass = calls[0]; // first call is the Overpass POST
    const sentQuery = decodeURIComponent(String(overpass.init?.body ?? ''));
    // The injected metacharacters must not survive into the regex match.
    assert.ok(!sentQuery.includes('.*'), 'expected .* to be stripped');
    assert.ok(!sentQuery.includes('|'), 'expected | to be stripped');
    const headers = overpass.init?.headers as Record<string, string>;
    assert.match(headers['user-agent'], /CarbonTasks/);
  });

  test('an identical search is served from cache (no second upstream request)', async () => {
    let count = 0;
    globalThis.fetch = (async () => {
      count++;
      return new Response(
        JSON.stringify({ elements: [{ lat: -37.81, lon: 145.01, tags: { name: 'Coles' } }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const provider = makeOsmProvider(geocodeConfigFromEnv({}, false), true)!;
    const near = { lat: -37.8, lng: 145.0 };
    await provider.search('coles', near);
    const afterFirst = count;
    await provider.search('coles', near);
    assert.equal(count, afterFirst, 'second identical search should hit the cache');
  });

  test('nearestBrand still returns the single nearest via search()', async () => {
    stubFetch({
      elements: [
        { lat: -37.9, lon: 145.1, tags: { name: 'Coles Far' } },
        { lat: -37.81, lon: 145.01, tags: { name: 'Coles Near' } },
      ],
    });
    const provider = makeOsmProvider(geocodeConfigFromEnv({}, false), true)!;
    const hit = await provider.nearestBrand('coles', { lat: -37.8, lng: 145.0 });
    assert.equal(hit?.label, 'Coles Near');
  });
});
