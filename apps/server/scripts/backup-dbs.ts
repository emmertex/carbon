// Snapshot the control DB + every tenant SQLite DB into timestamped backup files,
// then prune anything older than the retention window. Safe to run while the
// server is up: WAL-mode DBs are copied via `VACUUM INTO`, which SQLite guarantees
// produces a consistent, crash-safe snapshot without blocking readers/writers for
// more than the time it takes to write the new file.
//
// Usage (from apps/server):
//   npm run backup
//   BACKUP_DIR=/mnt/backups BACKUP_RETENTION_DAYS=30 npm run backup
//
// Reads the same DATABASE_PATH / CONTROL_DB_PATH / TENANTS_DIR env vars the
// server itself uses, so it finds the same files without any extra config —
// see src/index.ts for where those are defined.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = resolve(process.env.DATABASE_PATH ?? './data/carbon.db');
const DATA_DIR = dirname(DB_PATH);
const CONTROL_DB_PATH = resolve(process.env.CONTROL_DB_PATH ?? join(DATA_DIR, 'control.db'));
const TENANTS_DIR = resolve(process.env.TENANTS_DIR ?? join(DATA_DIR, 'tenants'));
const BACKUP_DIR = resolve(process.env.BACKUP_DIR ?? join(DATA_DIR, 'backups'));
const RETENTION_DAYS = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 14);

interface Target {
  /** Sub-directory of BACKUP_DIR this DB's snapshots live in. */
  label: string;
  srcPath: string;
}

/** Find every tenant DB under TENANTS_DIR/<id>/carbon.db (mirrors provisionTenant's layout). */
function findTenantDbs(): Target[] {
  if (!existsSync(TENANTS_DIR)) return [];
  const ids = readdirSync(TENANTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  return ids.map((e) => ({
    label: `tenants/${e.name}`,
    srcPath: join(TENANTS_DIR, e.name, 'carbon.db'),
  }));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Snapshot one DB via VACUUM INTO. Returns the backup file path, or null if skipped. */
function backupOne(target: Target): string | null {
  if (!existsSync(target.srcPath)) {
    console.warn(`skip (missing): ${target.srcPath}`);
    return null;
  }
  const destDir = join(BACKUP_DIR, target.label);
  mkdirSync(destDir, { recursive: true });
  const destPath = join(destDir, `${timestamp()}.db`);

  // Open read-only: VACUUM INTO only reads the source, and read-only avoids
  // accidentally creating/locking WAL side-files on a DB we don't otherwise touch.
  const db = new DatabaseSync(target.srcPath, { readOnly: true });
  try {
    // Escape single quotes in the path for the SQL string literal.
    const escaped = destPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  return destPath;
}

/** Delete snapshot files older than RETENTION_DAYS in one label's backup dir. */
function pruneOld(label: string): number {
  const dir = join(BACKUP_DIR, label);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isFile() && stat.mtimeMs < cutoff) {
      rmSync(path);
      removed++;
    }
  }
  return removed;
}

function main(): void {
  const targets: Target[] = [
    { label: 'default', srcPath: DB_PATH },
    { label: 'control', srcPath: CONTROL_DB_PATH },
    ...findTenantDbs(),
  ];

  mkdirSync(BACKUP_DIR, { recursive: true });

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const target of targets) {
    try {
      const dest = backupOne(target);
      if (dest === null) {
        skipped++;
        continue;
      }
      const sizeKb = (statSync(dest).size / 1024).toFixed(1);
      console.log(`backed up ${target.label} -> ${dest} (${sizeKb} KiB)`);
      ok++;
    } catch (err) {
      failed++;
      console.error(`FAILED backing up ${target.label} (${target.srcPath}):`, err);
    }
  }

  let pruned = 0;
  for (const target of targets) {
    try {
      pruned += pruneOld(target.label);
    } catch (err) {
      console.error(`FAILED pruning ${target.label}:`, err);
      failed++;
    }
  }

  console.log(
    `\nbackup summary: ${ok} succeeded, ${skipped} skipped, ${failed} failed, ${pruned} old snapshot(s) pruned (retention ${RETENTION_DAYS}d)`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main();
