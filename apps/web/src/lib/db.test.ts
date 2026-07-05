import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

// db.ts touches `document`/`window` (registerPersistFlush) and `localforage`
// (module-level `.config()` call) at import time. Provide minimal EventTarget-based
// stubs so it loads and its listener wiring is exercisable under the plain node
// test runner (no jsdom in this project's web test setup).
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
}
const fakeDocument = new FakeDocument();
const fakeWindow = new EventTarget();
(globalThis as unknown as { document: FakeDocument }).document = fakeDocument;
(globalThis as unknown as { window: EventTarget }).window = fakeWindow;

const { registerPersistFlush } = await import('./db');

describe('registerPersistFlush()', () => {
  beforeEach(() => {
    fakeDocument.visibilityState = 'visible';
  });

  // June 2026 review recommendation #3 ("a persistence-durability test for
  // flush-on-pagehide") — this was still outstanding per the July 2026 review.
  test('flushes on pagehide', () => {
    let calls = 0;
    registerPersistFlush(() => {
      calls++;
    });
    fakeWindow.dispatchEvent(new Event('pagehide'));
    assert.equal(calls, 1);
  });

  test('flushes when visibility becomes hidden', () => {
    let calls = 0;
    registerPersistFlush(() => {
      calls++;
    });
    fakeDocument.visibilityState = 'hidden';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls, 1);
  });

  test('does not flush when visibility changes but stays visible', () => {
    let calls = 0;
    registerPersistFlush(() => {
      calls++;
    });
    fakeDocument.visibilityState = 'visible';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls, 0);
  });
});
