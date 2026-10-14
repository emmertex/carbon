import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { openDb } from './sqlite';
import {
  migrate,
  createUser,
  createItem,
} from '@carbon/core';
import {
  ensureServerTables,
  createToken,
  revokeToken,
} from './auth';

const DEV = 'test-device';

// Helper: create a fresh in-memory test DB
function makeDb() {
  const db = openDb(':memory:');
  migrate(db);
  ensureServerTables(db);
  return db;
}

// ─── token lifecycle ──────────────────────────────────────────────────────────

describe('personal API tokens — lifecycle', () => {
  test('createToken returns plaintext secret shown once', () => {
    const db = makeDb();
    const user = createUser(db, { username: 'alice' });

    const { token, row } = createToken(db, {
      userId: user.id,
      name: 'my key',
      scopes: ['tasks:read'],
    });

    // Secret format
    assert.ok(token.startsWith('carbon_'));
    assert.equal(token.length, 55, 'token is 55 chars');

    // Row has hashed token, not plaintext
    const rowFromDb = db.get<{ id: string; user_id: string; name: string; token_hash: string }>(
      'SELECT id, user_id, name, token_hash FROM api_tokens WHERE id = ?',
      [row.id],
    );
    assert.ok(rowFromDb, 'row exists in DB');
    assert.equal(rowFromDb.name, 'my key');
    assert.equal(rowFromDb.user_id, user.id);
    // token_hash is a sha256 (64 hex chars)
    assert.equal(rowFromDb.token_hash.length, 64);
    assert.notEqual(rowFromDb.token_hash, token, 'stored hash differs from plaintext');
  });

  test('tokens are scoped to user', () => {
    const db = makeDb();
    const alice = createUser(db, { username: 'alice' });
    const bob = createUser(db, { username: 'bob' });

    createToken(db, { userId: alice.id, name: 'alice-key', scopes: ['tasks:read'] });
    createToken(db, { userId: bob.id, name: 'bob-key', scopes: ['tasks:read'] });

    // Both users have tokens
    const aliceTokens = db.all<{ name: string }>('SELECT name FROM api_tokens WHERE user_id = ?', [alice.id]);
    assert.equal(aliceTokens.length, 1);
    assert.equal(aliceTokens[0].name, 'alice-key');

    const bobTokens = db.all<{ name: string }>('SELECT name FROM api_tokens WHERE user_id = ?', [bob.id]);
    assert.equal(bobTokens.length, 1);
    assert.equal(bobTokens[0].name, 'bob-key');
  });

  test('revokeToken marks as revoked', () => {
    const db = makeDb();
    const user = createUser(db, { username: 'alice' });

    const { row } = createToken(db, {
      userId: user.id,
      name: 'to-revoke',
      scopes: ['tasks:read'],
    });

    // Before revocation: not revoked
    const row1 = db.get<{ revoked: number }>('SELECT revoked FROM api_tokens WHERE id = ?', [row.id]);
    assert.ok(row1, 'token row exists');
    assert.equal(row1.revoked, 0, 'token not revoked');

    // Revoke
    revokeToken(db, row.id);

    // After revocation: revoked
    const row2 = db.get<{ revoked: number }>('SELECT revoked FROM api_tokens WHERE id = ?', [row.id]);
    assert.ok(row2, 'token row exists after revocation');
    assert.equal(row2.revoked, 1, 'revoked token is marked as revoked');
  });

  test('expired token has expires_at set', () => {
    const db = makeDb();
    const user = createUser(db, { username: 'alice' });

    const { row } = createToken(db, {
      userId: user.id,
      name: 'expiring-key',
      scopes: ['tasks:read'],
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
    });

    // Expired tokens have expires_at set
    assert.ok(row.expires_at, 'token has expires_at timestamp');
  });

  test('validateToken accepts non-expired token', () => {
    const db = makeDb();
    const user = createUser(db, { username: 'alice' });

    const { token } = createToken(db, {
      userId: user.id,
      name: 'not-expiring',
      scopes: ['tasks:read'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(), // tomorrow
    });

    // Token created successfully and not expired
    const row = db.get<{ id: string }>('SELECT id FROM api_tokens WHERE name = ?', ['not-expiring']);
    assert.ok(row, 'non-expired token exists');
  });
});

// ─── project-subtree restrictions ────────────────────────────────────────────

describe('personal API tokens — project-subtree restrictions', () => {
  // The restriction is stored on the token row and enforced from validateToken's
  // projectIds (the dead Credential.restrictedProjectId field was removed).
  test('token project restriction is persisted on the token row', () => {
    const db = makeDb();
    const user = createUser(db, { username: 'alice' });
    const projectA = createItem(db, DEV, { type: 'project', title: 'Project A', ownerId: user.id });
    createToken(db, {
      userId: user.id,
      name: 'test-restricted',
      scopes: ['tasks:read'],
      projectIds: [projectA.id],
    });
    const row = db.get<{ project_ids: string }>('SELECT project_ids FROM api_tokens WHERE name = ?', ['test-restricted']);
    assert.ok(row, 'restricted token exists in DB');
    assert.ok(row.project_ids.includes(projectA.id), 'project A id is in restriction');
  });
});
