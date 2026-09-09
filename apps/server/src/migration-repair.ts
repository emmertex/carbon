import {
  copyFileSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  migrate,
  verifyMigration,
  getSchemaVersion,
  LATEST_SCHEMA_VERSION,
  type Db,
} from "@carbon/core";

type FileDb = Db & { raw: DatabaseSync };
const markerPath = (path: string) => `${path}.migration-pending.json`;
const snapshotPath = (path: string) => `${path}.migration-snapshot.db`;
function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDir(path: string): void {
  syncFile(dirname(path));
}

function verifySnapshot(path: string, from: number): void {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = raw.prepare("PRAGMA integrity_check").all();
    if (
      !integrity.length ||
      integrity.some((row) => Object.values(row)[0] !== "ok")
    )
      throw new Error("migration snapshot integrity check failed");
    const meta = raw
      .prepare("SELECT name FROM sqlite_master WHERE name = 'meta'")
      .get();
    const version = meta
      ? Number(
          raw
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get()?.value ?? 0,
        )
      : 0;
    if (version !== from)
      throw new Error("migration snapshot version mismatch");
  } finally {
    raw.close();
  }
}

/** Must run before opening the live database. A stable durable marker survives
 * process death after migration commit or during restore. Recovery is idempotent. */
export function recoverPendingMigration(path: string): boolean {
  const marker = markerPath(path);
  if (!existsSync(marker)) return false;
  const { from } = JSON.parse(readFileSync(marker, "utf8")) as { from: number };
  if (!Number.isSafeInteger(from) || from < 0)
    throw new Error(
      "Invalid pending migration marker; preserve files for recovery",
    );
  const snapshot = snapshotPath(path);
  verifySnapshot(snapshot, from); // never overwrite the live file with unverified bytes
  const staged = `${path}.migration-restore.tmp`;
  copyFileSync(snapshot, staged);
  syncFile(staged);
  verifySnapshot(staged, from);
  // No live handle is open here. A crash during sidecar removal/rename leaves the
  // marker and snapshot intact, so the next startup repeats the complete restore.
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  renameSync(staged, path);
  syncDir(path);
  rmSync(marker);
  syncDir(path);
  rmSync(snapshot, { force: true });
  return true;
}

/** Consistent SQLite snapshot, durable intent, migrate, verify, then expose. */
export function migrateWithRepair(
  db: FileDb,
  path: string,
  open: (p: string) => FileDb,
): FileDb {
  if (existsSync(markerPath(path))) {
    db.raw.close();
    recoverPendingMigration(path);
    db = open(path);
  }
  const from = getSchemaVersion(db);
  if (from >= LATEST_SCHEMA_VERSION) return db;
  const snapshot = snapshotPath(path);
  const staged = `${snapshot}.tmp`;
  try {
    rmSync(staged, { force: true });
    // VACUUM INTO takes a SQLite-consistent snapshot including committed WAL data.
    db.raw.exec(`VACUUM INTO '${staged.replace(/'/g, "''")}'`);
    verifySnapshot(staged, from);
    syncFile(staged);
    renameSync(staged, snapshot);
    syncDir(path);
    const marker = markerPath(path);
    writeFileSync(`${marker}.tmp`, JSON.stringify({ from }));
    syncFile(`${marker}.tmp`);
    renameSync(`${marker}.tmp`, marker);
    syncDir(path);
    migrate(db);
    const report = verifyMigration(db, LATEST_SCHEMA_VERSION);
    if (!report.ok)
      throw new Error(
        `post-migration verification failed: ${report.errors.join("; ")}`,
      );
    rmSync(marker);
    syncDir(path);
    rmSync(snapshot, { force: true });
    return db;
  } catch (cause) {
    db.raw.close();
    if (existsSync(markerPath(path))) {
      recoverPendingMigration(path);
      throw new Error(
        `schema migration failed and was rolled back to the pre-migration snapshot (schema v${from}); retry on next load`,
        { cause },
      );
    }
    throw cause; // snapshot/intent failure: no migration ran, fail closed
  }
}
