import type { Db } from './db';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './schema';

const VERSION_KEY = 'schema_version';

/** The stored schema version (0 for a brand-new database with no `meta` row yet). */
export function getSchemaVersion(db: Db): number {
  // `meta` may not exist yet on a brand-new database.
  try {
    const row = db.get<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      [VERSION_KEY],
    );
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

function setVersion(db: Db, version: number): void {
  db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [VERSION_KEY, String(version)],
  );
}

export interface IntegrityReport {
  /** True iff every integrity_check row is 'ok' AND the schema version matches. */
  ok: boolean;
  /** The stored schema version after the check. */
  schemaVersion: number;
  /** Human-readable problems (integrity_check non-'ok' rows, or a version mismatch). */
  errors: string[];
}

/**
 * A4 "verify-before-expose": after migrations, confirm the database is actually sound
 * before a caller treats the new schema as live. Two checks:
 *   1. `PRAGMA integrity_check` — every row must be the literal 'ok' (catches a
 *      migration whose SQL "committed" but left the file structurally corrupt).
 *   2. the stored schema version equals `expectedVersion` (catches a migration that
 *      partially advanced the version or failed to).
 * Returns a report (never throws) so the caller decides how to recover (the server's
 * migration-repair wrapper restores the pre-migration snapshot on a failed report).
 */
export function verifyMigration(db: Db, expectedVersion: number): IntegrityReport {
  const errors: string[] = [];
  let integrityOk = true;
  try {
    for (const row of db.all<{ integrity_check: string }>('PRAGMA integrity_check')) {
      if (row.integrity_check !== 'ok') {
        integrityOk = false;
        errors.push(`integrity_check: ${row.integrity_check}`);
      }
    }
  } catch (e) {
    integrityOk = false;
    errors.push(`integrity_check failed to run: ${String(e)}`);
  }
  const schemaVersion = getSchemaVersion(db);
  if (schemaVersion !== expectedVersion) {
    errors.push(`schema version is ${schemaVersion}, expected ${expectedVersion}`);
  }
  return { ok: integrityOk && errors.length === 0, schemaVersion, errors };
}

/**
 * Bring `db` up to the latest schema version by running every migration whose
 * version is greater than the stored one, inside a single transaction. This
 * actually runs (the old codebase defined migrations but never called them).
 */
export function migrate(db: Db): { from: number; to: number } {
  const from = getSchemaVersion(db);
  if (from >= LATEST_SCHEMA_VERSION) return { from, to: from };

  db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version > from) {
        db.exec(migration.up);
        setVersion(db, migration.version);
      }
    }
  });

  return { from, to: LATEST_SCHEMA_VERSION };
}
