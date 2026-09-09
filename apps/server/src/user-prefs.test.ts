import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { makeTestDb } from './test-app';
import {
  ensureUserPrefsTables,
  isValidTimezone,
  getUserTimezone,
  setUserTimezone,
} from './user-prefs';

describe('user-prefs', () => {
  test('ensureUserPrefsTables creates the table', () => {
    const { db } = makeTestDb();
    ensureUserPrefsTables(db);
    const row = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_prefs'");
    assert.ok(row);
  });

  test('isValidTimezone accepts valid zones', () => {
    assert.equal(isValidTimezone('Australia/Melbourne'), true);
    assert.equal(isValidTimezone('America/New_York'), true);
    assert.equal(isValidTimezone('UTC'), true);
  });

  test('isValidTimezone rejects invalid zones', () => {
    assert.equal(isValidTimezone('Not/A-Timezone'), false);
    assert.equal(isValidTimezone(''), false);
  });

  test('getUserTimezone returns null when not set', () => {
    const { db } = makeTestDb();
    assert.equal(getUserTimezone(db, 'user-1'), null);
  });

  test('setUserTimezone stores a valid timezone', () => {
    const { db } = makeTestDb();
    setUserTimezone(db, 'user-1', 'Australia/Melbourne');
    assert.equal(getUserTimezone(db, 'user-1'), 'Australia/Melbourne');
  });

  test('setUserTimezone ignores invalid input', () => {
    const { db } = makeTestDb();
    setUserTimezone(db, 'user-1', 'Not/A-Zone');
    assert.equal(getUserTimezone(db, 'user-1'), null);
  });

  test('setUserTimezone overwrites on conflict', () => {
    const { db } = makeTestDb();
    setUserTimezone(db, 'user-1', 'America/New_York');
    setUserTimezone(db, 'user-1', 'Asia/Tokyo');
    assert.equal(getUserTimezone(db, 'user-1'), 'Asia/Tokyo');
  });
});
