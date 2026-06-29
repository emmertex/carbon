import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

// where.ts (via the store/config/device chain) touches localStorage at import + runtime.
// Provide a tiny in-memory stub so the module loads under the node test runner.
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

const {
  autoEligible,
  isFixTooInaccurate,
  GPS_ACCURACY_LIMIT_M,
  GPS_STALE_MS,
  ZONE_KEY,
  setSourceOverride,
  getWhere,
} = await import('./where');

const fresh = () => Date.now();
const stale = () => Date.now() - GPS_STALE_MS - 1;
const dev = (
  deviceId: string,
  accuracy: number | null,
  updatedAt = fresh(),
  source: 'self' | 'device' | 'ha' = 'device',
) => ({ deviceId, name: null, source, lat: 1, lng: 2, accuracy, updatedAt });

describe('isFixTooInaccurate()', () => {
  test('null accuracy is kept (not too inaccurate)', () => {
    assert.equal(isFixTooInaccurate(null), false);
  });
  test('at the limit is kept, just past it is rejected', () => {
    assert.equal(isFixTooInaccurate(GPS_ACCURACY_LIMIT_M), false);
    assert.equal(isFixTooInaccurate(GPS_ACCURACY_LIMIT_M + 1), true);
  });
});

describe('autoEligible() over devices', () => {
  test('a fresh, accurate device is eligible', () => {
    const e = autoEligible({ haZone: null, devices: [dev('a', 20)] });
    assert.equal(e.a, true);
  });

  test('a fix worse than 5 km is auto-disabled; an accurate sibling stays on', () => {
    const e = autoEligible({ haZone: null, devices: [dev('a', 6000), dev('b', 20)] });
    assert.equal(e.a, false, 'inaccurate device off');
    assert.equal(e.b, true, 'accurate device still on');
  });

  test('a stale fix is auto-disabled even if accurate', () => {
    const e = autoEligible({ haZone: null, devices: [dev('a', 20, stale())] });
    assert.equal(e.a, false);
  });

  test('a fix with unknown accuracy is kept', () => {
    const e = autoEligible({ haZone: null, devices: [dev('a', null)] });
    assert.equal(e.a, true);
  });

  test('a present zone is always eligible', () => {
    const e = autoEligible({ haZone: { name: 'Home', updatedAt: stale() }, devices: [] });
    assert.equal(e[ZONE_KEY], true);
  });
});

describe('setSourceOverride() persistence', () => {
  beforeEach(() => mem.clear());

  test('records and clears a manual override by device id', () => {
    setSourceOverride('dev1', false);
    assert.equal(getWhere().overrides.dev1, false);
    setSourceOverride('dev1', undefined);
    assert.equal('dev1' in getWhere().overrides, false);
  });
});
