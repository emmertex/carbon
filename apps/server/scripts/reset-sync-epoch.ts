// Rebuild a workspace's ops/record_ops from materialized state and bump sync_epoch.
// Breaks incremental sync for every client and federation peer — clients must wipe
// and re-pull (or stay offline). See docs/sync-epoch.md.
//
// Usage:
//   npm run reset-sync-epoch -w @carbon/server -- <tenant|default>
//   npm run reset-sync-epoch -w @carbon/server -- <tenant|default> --force
//
// Refuses when any federation_links row has status = 'active' (unless --force).
// Always VACUUM INTO a pre-reset backup beside the DB when possible.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { rebuildSyncLogFromMaterialization } from '@carbon/core';
import { migrate } from '@carbon/core';
import { openDb } from '../src/sqlite';
import {
  ensureFederationTables,
  ensureGovernanceTables,
  listLinks,
  getSyncEpoch,
  bumpSyncEpoch,
} from '../src/federation';
import { openControlDb, getTenantBySubdomain, getTenantById } from '../src/control';

const DB_PATH = resolve(process.env.DATABASE_PATH ?? './data/carbon.db');
const DATA_DIR = dirname(DB_PATH);
const CONTROL_DB_PATH = resolve(process.env.CONTROL_DB_PATH ?? join(DATA_DIR, 'control.db'));

const args = process.argv.slice(2);
const force = args.includes('--force');
const tenantArg = args.find((a) => a !== '--force');

function usage(): never {
  console.error(`Usage:
  reset-sync-epoch <tenant|default> [--force]

Rebuilds ops/record_ops from current materialization, bumps sync_epoch, and VACUUMs.
Active federation links must be revoked first (or pass --force to proceed anyway).
`);
  process.exit(1);
}

if (!tenantArg) usage();

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
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = openDb(dbPath);
migrate(db);
ensureFederationTables(db);
ensureGovernanceTables(db);

const activeLinks = listLinks(db).filter((l) => l.status === 'active');
if (activeLinks.length && !force) {
  console.error(
    `Refusing: ${activeLinks.length} active federation link(s). Revoke them first, ` +
      `or pass --force (peers will need a manual re-bootstrap either way).`,
  );
  process.exit(1);
}
if (activeLinks.length && force) {
  console.warn(
    `WARNING: proceeding with ${activeLinks.length} active federation link(s); ` +
      `their rowid cursors are now invalid.`,
  );
}

const beforeEpoch = getSyncEpoch(db);
const opBefore =
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')?.n ?? 0;
const recBefore =
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM record_ops')?.n ?? 0;

// Crash-safe snapshot beside the live DB before we rewrite the logs.
const backupDir = join(dirname(dbPath), 'epoch-backups');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = join(backupDir, `pre-epoch-${beforeEpoch}-${stamp}.db`);
try {
  db.raw.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  console.log(`Pre-reset backup: ${backupPath}`);
} catch (e) {
  console.warn('VACUUM INTO backup failed (continuing):', e);
}

const result = rebuildSyncLogFromMaterialization(db);
const afterEpoch = bumpSyncEpoch(db);

try {
  db.raw.exec('VACUUM');
} catch (e) {
  console.warn('VACUUM failed (log rebuild still committed):', e);
}

console.log(`
Sync epoch reset complete for ${tenantArg}:
  epoch:  ${beforeEpoch} → ${afterEpoch}
  ops:    ${opBefore} → ${result.opCount}
  records:${recBefore} → ${result.recordOpCount}

Clients must clear local cache and re-download (or stay offline).
Federation peers need a fresh link / re-bootstrap.
`);
