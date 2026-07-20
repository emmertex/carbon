// Break-glass MFA admin for sync servers. Usage (from apps/server or via workspace):
//   npm run mfa-admin -w @carbon/server -- issue-session <tenant|default> <username>
//   npm run mfa-admin -w @carbon/server -- issue-recovery <tenant|default> <username>
//   npm run mfa-admin -w @carbon/server -- reset-mfa <tenant|default> <username>
//   npm run mfa-admin -w @carbon/server -- reset-trust <tenant|default> <username> [device_id]
//
// Resolves the same DATABASE_PATH / CONTROL_DB_PATH / TENANTS_DIR as the server.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getUserByUsername } from '@carbon/core';
import { openDb } from '../src/sqlite';
import { migrate } from '@carbon/core';
import { ensureServerTables, createSession } from '../src/auth';
import {
  issueRecoveryCodes,
  resetMfa,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  trustDevice,
} from '../src/mfa';
import { openControlDb, getTenantBySubdomain, getTenantById } from '../src/control';

const DB_PATH = resolve(process.env.DATABASE_PATH ?? './data/carbon.db');
const DATA_DIR = dirname(DB_PATH);
const CONTROL_DB_PATH = resolve(process.env.CONTROL_DB_PATH ?? join(DATA_DIR, 'control.db'));

const [cmd, tenantArg, username, deviceId] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  mfa-admin issue-session <tenant|default> <username>
  mfa-admin issue-recovery <tenant|default> <username>
  mfa-admin reset-mfa <tenant|default> <username>
  mfa-admin reset-trust <tenant|default> <username> [device_id]
`);
  process.exit(1);
}

if (!cmd || !tenantArg || !username) usage();

function resolveDbPath(tenant: string): string {
  if (tenant === 'default') return DB_PATH;
  if (!existsSync(CONTROL_DB_PATH)) {
    console.error(`Control DB not found at ${CONTROL_DB_PATH}`);
    process.exit(1);
  }
  const control = openControlDb(CONTROL_DB_PATH);
  const rec =
    getTenantBySubdomain(control, tenant.toLowerCase()) ?? getTenantById(control, tenant);
  if (!rec || rec.status === 'deleted') {
    console.error(`Unknown tenant: ${tenant}`);
    process.exit(1);
  }
  return rec.db_path;
}

const dbPath = resolveDbPath(tenantArg);
if (!existsSync(dbPath) && tenantArg === 'default') {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = openDb(dbPath);
migrate(db);
ensureServerTables(db);

const user = getUserByUsername(db, username);
if (!user) {
  console.error(`User not found: ${username}`);
  process.exit(1);
}

switch (cmd) {
  case 'issue-session': {
    const consoleDevice = `console:${randomUUID()}`;
    trustDevice(db, user.id, consoleDevice, 'Server console');
    const token = createSession(db, user.id);
    console.log('\nEmergency session token (paste into the client or use as Bearer):\n');
    console.log(token);
    console.log(`\nTrusted console device: ${consoleDevice}\n`);
    break;
  }
  case 'issue-recovery': {
    const codes = issueRecoveryCodes(db, user.id, 'console');
    console.log('\nOne-use recovery code (give to the user once):\n');
    console.log(codes[0]);
    console.log('');
    break;
  }
  case 'reset-mfa': {
    resetMfa(db, user.id);
    console.log(`Cleared MFA factors, recovery codes, and device trust for "${username}".`);
    break;
  }
  case 'reset-trust': {
    if (deviceId) {
      const ok = revokeTrustedDevice(db, user.id, deviceId);
      console.log(ok ? `Revoked device ${deviceId}.` : `Device not found: ${deviceId}`);
    } else {
      const n = revokeAllTrustedDevices(db, user.id);
      console.log(`Revoked ${n} trusted device(s) for "${username}".`);
    }
    break;
  }
  default:
    usage();
}

// better-sqlite / node:sqlite — close if available
try {
  (db as { raw?: { close?: () => void } }).raw?.close?.();
} catch {
  /* ignore */
}
