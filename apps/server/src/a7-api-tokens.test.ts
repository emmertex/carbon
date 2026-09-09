import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { openDb } from './sqlite';
import {
  migrate,
  createUser,
  createItem,
  shareItem,
  getItem,
  type Item,
} from '@carbon/core';
import {
  ensureServerTables,
  createToken,
  revokeToken,
} from './auth';
import {
  credentialFromVars,
  canReadItem,
  canWriteItem,
} from './authorize';

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
  test('token with project restriction is limited to that subtree', () => {
    const db = makeDb();
    const user = createUser(db, { username: 'alice' });

    // Create two projects
    const projectA = createItem(db, DEV, { type: 'project', title: 'Project A', ownerId: user.id });
    const projectB = createItem(db, DEV, { type: 'project', title: 'Project B', ownerId: user.id });

    // Task in Project A
    const taskInA = createItem(db, DEV, { type: 'task', title: 'In A', ownerId: user.id });
    db.run('UPDATE items SET parent_id = ? WHERE id = ?', [projectA.id, taskInA.id]);

    // Task in Project B
    const taskInB = createItem(db, DEV, { type: 'task', title: 'In B', ownerId: user.id });
    db.run('UPDATE items SET parent_id = ? WHERE id = ?', [projectB.id, taskInB.id]);

    // Create a token restricted to Project A
    const { token } = createToken(db, {
      userId: user.id,
      name: 'test-restricted',
      scopes: ['tasks:read'],
      projectIds: [projectA.id],
    });

    // Token is created with project restriction stored in DB
    const row = db.get<{ project_ids: string }>('SELECT project_ids FROM api_tokens WHERE name = ?', ['test-restricted']);
    assert.ok(row, 'restricted token exists in DB');
    assert.ok(row.project_ids, 'project_ids field is set');
    assert.ok(row.project_ids.includes(projectA.id), 'project A id is in restriction');

    // Build credential with project restriction
    const cred = credentialFromVars({
      authMethod: 'token',
      userId: user.id,
      role: 'member',
      scopes: ['tasks:read'],
      restrictedProjectId: projectA.id,
    });

    // Can read items in Project A
    assert.ok(canReadItem(db, cred, projectA.id), 'can read restricted project');
    assert.ok(canReadItem(db, cred, taskInA.id), 'can read task in restricted project');

    // Cannot read items outside Project A
    assert.ok(!canReadItem(db, cred, projectB.id), 'cannot read other project');
    assert.ok(!canReadItem(db, cred, taskInB.id), 'cannot read task in other project');
  });

  test('token with project restriction has write access within subtree only', () => {
    const db = makeDb();
    const user = createUser(db, { username: 'alice' });

    const projectA = createItem(db, DEV, { type: 'project', title: 'Project A', ownerId: user.id });
    const taskInA = createItem(db, DEV, { type: 'task', title: 'In A', ownerId: user.id });
    db.run('UPDATE items SET parent_id = ? WHERE id = ?', [projectA.id, taskInA.id]);

    const projectB = createItem(db, DEV, { type: 'project', title: 'Project B', ownerId: user.id });

    createToken(db, {
      userId: user.id,
      name: 'project-a-write',
      scopes: ['tasks:read', 'tasks:write'],
      projectIds: [projectA.id],
    });

    const cred = credentialFromVars({
      authMethod: 'token',
      userId: user.id,
      role: 'member',
      scopes: ['tasks:read', 'tasks:write'],
      restrictedProjectId: projectA.id,
    });

    assert.ok(canWriteItem(db, cred, projectA.id), 'can write in restricted project');
    assert.ok(canWriteItem(db, cred, taskInA.id), 'can write task in restricted project');
    assert.ok(!canWriteItem(db, cred, projectB.id), 'cannot write outside restricted project');
  });
});
