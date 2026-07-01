import type { Db } from '@carbon/core';

// Server-only per-user preferences (never CRDT-synced). Currently just the IANA
// timezone the client last reported, so relative-date NL commands ("tomorrow night")
// resolve against the user's local clock instead of the server's.

export function ensureUserPrefsTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id    TEXT PRIMARY KEY,
      timezone   TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

/** True if `tz` is a timezone name Intl (and thus the LLM prompt formatter) accepts. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getUserTimezone(db: Db, userId: string): string | null {
  return (
    db.get<{ timezone: string | null }>('SELECT timezone FROM user_prefs WHERE user_id = ?', [
      userId,
    ])?.timezone ?? null
  );
}

/** Record the client-reported IANA zone for `userId`. Silently ignores invalid input. */
export function setUserTimezone(db: Db, userId: string, timezone: string): void {
  if (!isValidTimezone(timezone)) return;
  db.run(
    `INSERT INTO user_prefs (user_id, timezone, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at`,
    [userId, timezone, new Date().toISOString()],
  );
}
