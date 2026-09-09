import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getUiPrefs, saveUiPrefs } from './config';

test('duplicate first-tap preferences migrate once and can then be disabled', () => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  } });
  const key = 'carbon.ui::local|local';
  for (const raw of [
    { firstTapDetails: false, tapOpensDetail: true },
    { firstTapDetails: true, tapOpensDetail: false },
    { tapOpensDetail: true },
  ]) {
    data.set(key, JSON.stringify(raw));
    const prefs = getUiPrefs();
    assert.equal(prefs.firstTapDetails, true);
    assert.equal('tapOpensDetail' in prefs, false);
    saveUiPrefs({ ...prefs, firstTapDetails: false });
    assert.equal(getUiPrefs().firstTapDetails, false);
    assert.equal('tapOpensDetail' in JSON.parse(data.get(key)!), false);
  }
});
