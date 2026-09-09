import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { makeTestDb } from './test-app';
import {
  ensureFcmTable,
  saveFcmToken,
  removeFcmToken,
  sendFcmToUser,
} from './fcm';

describe('ensureFcmTable', () => {
  test('creates the fcm_tokens table', () => {
    const { db } = makeTestDb();
    ensureFcmTable(db);
    // Verify by trying to insert a row (will fail if table doesn't exist)
    db.run("INSERT INTO fcm_tokens (id, user_id, token, created_at) VALUES (?, ?, ?, ?)",
      ['test-id', 'user-1', 'test-token', new Date().toISOString()]);
    const row = db.get("SELECT * FROM fcm_tokens WHERE id = ?", ['test-id']);
    assert.ok(row);
  });
});

describe('saveFcmToken / removeFcmToken', () => {
  test('saves and removes a token', () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'user-1', 'token-abc');
    const row = db.get('SELECT * FROM fcm_tokens WHERE token = ?', ['token-abc']);
    assert.ok(row);
    assert.equal(row.user_id, 'user-1');

    removeFcmToken(db, 'token-abc');
    const gone = db.get('SELECT * FROM fcm_tokens WHERE token = ?', ['token-abc']);
    assert.equal(gone, undefined);
  });

  test('re-saving same token reuses existing id', () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'user-1', 'token-abc');
    const first = db.get('SELECT id FROM fcm_tokens WHERE token = ?', ['token-abc']);
    assert.ok(first);
    saveFcmToken(db, 'user-2', 'token-abc');
    const second = db.get('SELECT id FROM fcm_tokens WHERE token = ?', ['token-abc']);
    assert.ok(second);
    assert.equal(first.id, second.id);
  });

  test('different tokens get different ids', () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'user-1', 'token-abc');
    saveFcmToken(db, 'user-1', 'token-def');
    const rows = db.all('SELECT id FROM fcm_tokens WHERE user_id = ?', ['user-1']);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
  });
});

describe('sendFcmToUser', () => {
  test('returns zero targets when unconfigured', async () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'user-1', 'token-abc');
    // No service account configured
    const result = await sendFcmToUser(db, 'user-1', { title: 'T', body: 'B' });
    assert.equal(result.targets, 0);
    assert.equal(result.delivered, 0);
  });

  test('returns zero targets when user has no tokens', async () => {
    const { db } = makeTestDb();
    const result = await sendFcmToUser(db, 'user-1', { title: 'T', body: 'B' });
    assert.equal(result.targets, 0);
  });
});
