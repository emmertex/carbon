/**
 * Control plane function tests — provisioning, tenant CRUD, lock state,
 * subdomain validation, and the pending-signup OTP flow.
 * All tests use in-memory DBs; no HTTP server needed (routes are thin wrappers).
 */
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openControlDb,
  provisionTenant,
  getTenantById,
  getTenantBySubdomain,
  listTenants,
  setTenantStatus,
  setTenantExpiry,
  setTenantLock,
  deleteTenant,
  tenantLockState,
  validateSubdomain,
  createPendingSignup,
  verifyPendingSignup,
  deletePendingSignup,
  gcPendingSignups,
  createPendingDelete,
  verifyPendingDelete,
  resolveDeleteToken,
  gcPendingDeletes,
} from './control';

let tenantsDir: string;

before(() => {
  tenantsDir = mkdtempSync(join(tmpdir(), 'carbon-ctrl-test-'));
});

after(() => {
  rmSync(tenantsDir, { recursive: true, force: true });
});

// ─── validateSubdomain ────────────────────────────────────────────────────────

describe('validateSubdomain', () => {
  test('valid lowercase alphanum subdomain returns null (no error)', () => {
    assert.equal(validateSubdomain('myteam'), null);
    assert.equal(validateSubdomain('team123'), null);
  });

  test('mixed-case is normalised (accepted as lowercase equivalent)', () => {
    // validateSubdomain normalises to lowercase before checking — 'MyTeam' → 'myteam' which is valid
    assert.equal(validateSubdomain('MyTeam'), null, 'uppercase normalised to lowercase');
  });

  test('hyphens are allowed in the middle', () => {
    assert.equal(validateSubdomain('my-team'), null);
  });

  test('leading hyphen is rejected', () => {
    assert.ok(validateSubdomain('-team') !== null, 'leading hyphen rejected');
  });

  test('trailing hyphen is rejected', () => {
    assert.ok(validateSubdomain('team-') !== null, 'trailing hyphen rejected');
  });

  test('empty string is rejected', () => {
    assert.ok(validateSubdomain('') !== null, 'empty string rejected');
  });

  test('too-long subdomain is rejected', () => {
    assert.ok(validateSubdomain('a'.repeat(64)) !== null, '64-char subdomain rejected');
  });
});

// ─── tenant provision / CRUD ─────────────────────────────────────────────────

describe('provisionTenant', () => {
  test('creates a tenant record and its DB', () => {
    const db = openControlDb(':memory:');
    const rec = provisionTenant(db, tenantsDir, {
      subdomain: 'acme',
      adminUsername: 'alice',
      adminPassword: 'secret',
      displayName: 'Acme Corp',
    });
    assert.ok(rec.id, 'has an id');
    assert.equal(rec.subdomain, 'acme');
    assert.equal(rec.display_name, 'Acme Corp');
    assert.equal(rec.status, 'active');
    assert.ok(rec.db_path, 'db_path is set');
  });

  test('getTenantById retrieves the record', () => {
    const db = openControlDb(':memory:');
    const rec = provisionTenant(db, tenantsDir, {
      subdomain: 'foocorp',
      adminUsername: 'bob',
      adminPassword: 'pw',
    });
    const found = getTenantById(db, rec.id);
    assert.ok(found, 'found by id');
    assert.equal(found!.subdomain, 'foocorp');
  });

  test('getTenantBySubdomain retrieves the record', () => {
    const db = openControlDb(':memory:');
    provisionTenant(db, tenantsDir, {
      subdomain: 'barco',
      adminUsername: 'charlie',
      adminPassword: 'pw',
    });
    const found = getTenantBySubdomain(db, 'barco');
    assert.ok(found, 'found by subdomain');
  });

  test('getTenantById returns null for unknown id', () => {
    const db = openControlDb(':memory:');
    assert.equal(getTenantById(db, 'nonexistent'), null);
  });

  test('listTenants includes all provisioned tenants', () => {
    const db = openControlDb(':memory:');
    provisionTenant(db, tenantsDir, {
      subdomain: 'list1',
      adminUsername: 'u1',
      adminPassword: 'p',
    });
    provisionTenant(db, tenantsDir, {
      subdomain: 'list2',
      adminUsername: 'u2',
      adminPassword: 'p',
    });
    const list = listTenants(db);
    assert.ok(list.length >= 2);
    assert.ok(list.find((t) => t.subdomain === 'list1'));
    assert.ok(list.find((t) => t.subdomain === 'list2'));
  });

  test('duplicate subdomain throws', () => {
    const db = openControlDb(':memory:');
    provisionTenant(db, tenantsDir, {
      subdomain: 'duptest',
      adminUsername: 'u',
      adminPassword: 'p',
    });
    assert.throws(
      () =>
        provisionTenant(db, tenantsDir, {
          subdomain: 'duptest',
          adminUsername: 'u2',
          adminPassword: 'p',
        }),
      /subdomain already taken/,
    );
  });
});

// ─── tenant status / expiry / lock ────────────────────────────────────────────

describe('tenant status management', () => {
  test('setTenantStatus changes status', () => {
    const db = openControlDb(':memory:');
    const { id } = provisionTenant(db, tenantsDir, {
      subdomain: 'statustest',
      adminUsername: 'u',
      adminPassword: 'p',
    });
    setTenantStatus(db, id, 'suspended');
    assert.equal(getTenantById(db, id)!.status, 'suspended');
  });

  test('setTenantExpiry updates expiry date', () => {
    const db = openControlDb(':memory:');
    const { id } = provisionTenant(db, tenantsDir, {
      subdomain: 'expirytest',
      adminUsername: 'u',
      adminPassword: 'p',
    });
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    setTenantExpiry(db, id, future);
    assert.equal(getTenantById(db, id)!.expires_at, future);
  });

  test('tenantLockState is open when expires_at is in the future', () => {
    const db = openControlDb(':memory:');
    const { id } = provisionTenant(db, tenantsDir, {
      subdomain: 'openstate',
      adminUsername: 'u',
      adminPassword: 'p',
    });
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    setTenantExpiry(db, id, future);
    assert.equal(tenantLockState(getTenantById(db, id)!), 'open');
  });

  test('tenantLockState is locked when expires_at is in the past', () => {
    const db = openControlDb(':memory:');
    const { id } = provisionTenant(db, tenantsDir, {
      subdomain: 'paststate',
      adminUsername: 'u',
      adminPassword: 'p',
    });
    const past = new Date(Date.now() - 1000).toISOString();
    setTenantExpiry(db, id, past);
    assert.equal(tenantLockState(getTenantById(db, id)!), 'locked');
  });

  test('tenantLockState is locked when locked_at is set (operator lock)', () => {
    const db = openControlDb(':memory:');
    const { id } = provisionTenant(db, tenantsDir, {
      subdomain: 'oplock',
      adminUsername: 'u',
      adminPassword: 'p',
    });
    setTenantLock(db, id, true);
    assert.equal(tenantLockState(getTenantById(db, id)!), 'locked');
  });

  test('setTenantLock(false) clears locked_at', () => {
    const db = openControlDb(':memory:');
    const { id } = provisionTenant(db, tenantsDir, {
      subdomain: 'unlockme',
      adminUsername: 'u',
      adminPassword: 'p',
    });
    setTenantLock(db, id, true);
    setTenantLock(db, id, false);
    assert.equal(getTenantById(db, id)!.locked_at, null);
  });
});

// ─── deleteTenant ─────────────────────────────────────────────────────────────

describe('deleteTenant', () => {
  test('tombstones or removes the tenant', () => {
    const db = openControlDb(':memory:');
    const { id } = provisionTenant(db, tenantsDir, {
      subdomain: 'todelete',
      adminUsername: 'u',
      adminPassword: 'p',
    });
    deleteTenant(db, id);
    const rec = getTenantById(db, id);
    // deleteTenant may tombstone (status='deleted') or hard-delete
    if (rec) {
      assert.equal(rec.status, 'deleted');
    } else {
      assert.ok(true, 'hard-deleted');
    }
  });
});

// ─── pending signup flow ──────────────────────────────────────────────────────

describe('pending signup flow', () => {
  test('createPendingSignup returns an id and a 6-digit code', () => {
    const db = openControlDb(':memory:');
    const { id, code } = createPendingSignup(db, {
      email: 'alice@example.com',
      subdomain: 'alicecorp',
      adminUsername: 'alice',
      adminPassword: 'password123',
    });
    assert.ok(id, 'signup id returned');
    assert.match(code, /^\d{6}$/, '6-digit OTP code');
  });

  test('verifyPendingSignup accepts the correct code', () => {
    const db = openControlDb(':memory:');
    const { code } = createPendingSignup(db, {
      email: 'bob@example.com',
      subdomain: 'bobco',
      adminUsername: 'bob',
      adminPassword: 'pw',
    });
    const result = verifyPendingSignup(db, 'bob@example.com', code);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.pending.id, 'pending row returned');
    }
  });

  test('verifyPendingSignup rejects a wrong code', () => {
    const db = openControlDb(':memory:');
    createPendingSignup(db, {
      email: 'carol@example.com',
      subdomain: 'carolco',
      adminUsername: 'carol',
      adminPassword: 'pw',
    });
    const result = verifyPendingSignup(db, 'carol@example.com', '000000');
    assert.equal(result.ok, false);
  });

  test('deletePendingSignup removes the row', () => {
    const db = openControlDb(':memory:');
    const { id } = createPendingSignup(db, {
      email: 'dave@example.com',
      subdomain: 'daveco',
      adminUsername: 'dave',
      adminPassword: 'pw',
    });
    deletePendingSignup(db, id);
    const row = db.get('SELECT 1 FROM pending_signups WHERE id = ?', [id]);
    assert.ok(!row, 'signup row deleted');
  });

  test('gcPendingSignups removes expired entries', () => {
    const db = openControlDb(':memory:');
    db.run(
      `INSERT INTO pending_signups
         (id, email, subdomain, display_name, admin_username, password_hash, code_hash, expires_at, attempts, created_at)
       VALUES ('gc-test', 'gc@example.com', 'gcco', NULL, 'gc', 'hash', 'chash', ?, 0, ?)`,
      [
        new Date(Date.now() - 3_600_000).toISOString(),
        new Date().toISOString(),
      ],
    );
    gcPendingSignups(db);
    assert.ok(!db.get('SELECT 1 FROM pending_signups WHERE id = ?', ['gc-test']));
  });
});

// ─── pending workspace deletion (email-OTC) ──────────────────────────────────

describe('pending delete flow', () => {
  function makeTenant(db: ReturnType<typeof openControlDb>, subdomain: string, email: string) {
    return provisionTenant(db, tenantsDir, {
      subdomain,
      adminUsername: 'admin',
      adminPassword: 'pw',
      adminEmail: email,
    });
  }

  test('createPendingDelete returns a 6-digit code', () => {
    const db = openControlDb(':memory:');
    const rec = makeTenant(db, 'delco', 'owner@example.com');
    const { id, code } = createPendingDelete(db, { tenantId: rec.id, email: 'owner@example.com' });
    assert.ok(id, 'pending delete id returned');
    assert.match(code, /^\d{6}$/, '6-digit code');
  });

  test('verifyPendingDelete accepts the correct code and mints a token', () => {
    const db = openControlDb(':memory:');
    const rec = makeTenant(db, 'delco2', 'owner@example.com');
    const { code } = createPendingDelete(db, { tenantId: rec.id, email: 'owner@example.com' });
    const result = verifyPendingDelete(db, rec.id, code);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.token, /^carbondel_/, 'delete token minted');
  });

  test('verifyPendingDelete rejects a wrong code', () => {
    const db = openControlDb(':memory:');
    const rec = makeTenant(db, 'delco3', 'owner@example.com');
    createPendingDelete(db, { tenantId: rec.id, email: 'owner@example.com' });
    const result = verifyPendingDelete(db, rec.id, '000000');
    assert.equal(result.ok, false);
  });

  test('re-starting reissues a code and invalidates the prior token', () => {
    const db = openControlDb(':memory:');
    const rec = makeTenant(db, 'delco4', 'owner@example.com');
    const first = createPendingDelete(db, { tenantId: rec.id, email: 'owner@example.com' });
    const v = verifyPendingDelete(db, rec.id, first.code);
    assert.equal(v.ok, true);
    const oldToken = v.ok ? v.token : '';
    // A fresh start replaces the row (one pending delete per tenant) and clears the token.
    createPendingDelete(db, { tenantId: rec.id, email: 'owner@example.com' });
    assert.equal(resolveDeleteToken(db, oldToken), null, 'old token no longer valid');
  });

  test('resolveDeleteToken resolves a verified token to its tenant', () => {
    const db = openControlDb(':memory:');
    const rec = makeTenant(db, 'delco5', 'owner@example.com');
    const { code } = createPendingDelete(db, { tenantId: rec.id, email: 'owner@example.com' });
    const v = verifyPendingDelete(db, rec.id, code);
    assert.ok(v.ok);
    const row = resolveDeleteToken(db, v.ok ? v.token : '');
    assert.ok(row, 'token resolves');
    assert.equal(row?.tenant_id, rec.id);
  });

  test('resolveDeleteToken returns null for an unknown token', () => {
    const db = openControlDb(':memory:');
    assert.equal(resolveDeleteToken(db, 'carbondel_nope'), null);
  });

  test('gcPendingDeletes removes expired entries', () => {
    const db = openControlDb(':memory:');
    db.run(
      `INSERT INTO pending_deletes (id, tenant_id, email, code_hash, token_hash, expires_at, attempts, created_at)
       VALUES ('gc-del', 'tenant-x', 'gc@example.com', 'chash', NULL, ?, 0, ?)`,
      [new Date(Date.now() - 3_600_000).toISOString(), new Date().toISOString()],
    );
    gcPendingDeletes(db);
    assert.ok(!db.get('SELECT 1 FROM pending_deletes WHERE id = ?', ['gc-del']));
  });
});
