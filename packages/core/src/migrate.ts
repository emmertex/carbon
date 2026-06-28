import type { Db } from './db';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './schema';

const VERSION_KEY = 'schema_version';

function getVersion(db: Db): number {
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

/**
 * Bring `db` up to the latest schema version by running every migration whose
 * version is greater than the stored one, inside a single transaction. This
 * actually runs (the old codebase defined migrations but never called them).
 */
export function migrate(db: Db): { from: number; to: number } {
  const from = getVersion(db);
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
