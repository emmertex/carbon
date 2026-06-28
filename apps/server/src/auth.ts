import { createHash, timingSafeEqual, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import {
  type Db,
  type User,
  listUsers,
  getUser,
  getUserByUsername,
  createUser,
  allItems,
  tasksAtLocation,
  visibleItemIds,
} from '@carbon/core';
import { notifyTask } from './push';

export type AuthMethod = 'basic' | 'token' | 'session' | 'open';
export const SCOPES = ['tasks:read', 'tasks:write', 'inbox:write'] as const;
export type Scope = (typeof SCOPES)[number];

export interface AuthVars {
  userId: string;
  username: string;
  role: 'admin' | 'member';
  scopes: string[];
  authMethod: AuthMethod;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ----- password hashing (A3) ------------------------------------------------
// Passwords are low-entropy, so a bare sha256 is crackable on a DB leak. New
// passwords use salted scrypt, stored as `scrypt$<saltHex>$<keyHex>`. Legacy bare
// 64-hex sha256 hashes (older accounts, AUTH_USERS / HOST_ADMINS env, add-user
// script) still verify, so existing deployments keep working unchanged.
const SCRYPT_KEYLEN = 32;
// A real-shaped hash to compare against when the username is unknown (timing parity).
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(64)}`;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(stored: string, password: string): boolean {
  if (stored.startsWith('scrypt$')) {
    const [, salt, keyHex] = stored.split('$');
    if (!salt || !keyHex) return false;
    let derived: Buffer;
    try {
      derived = scryptSync(password, salt, SCRYPT_KEYLEN);
    } catch {
      return false;
    }
    const expected = Buffer.from(keyHex, 'hex');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
  // Legacy: bare sha256 hex.
  return safeEqualHex(stored, sha256Hex(password));
}

/** Server-only auth + integration tables (not part of the synced core schema). */
export function ensureServerTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_auth (
      user_id       TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      ha_person     TEXT
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL,
      scopes       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS gps_history (
      user_id    TEXT PRIMARY KEY,
      lat        REAL NOT NULL,
      lng        REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Browser/device sign-in sessions. Distinct from api_tokens (integrations):
    -- a session grants the full human identity (incl. admin), is minted by
    -- exchanging a password once, and lets the client store an opaque,
    -- revocable, expiring token instead of the plaintext password.
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      token_hash   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      expires_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);
  `);
}

// ----- sign-in sessions (browser / device tokens) ---------------------------

// Sessions slide forward on use; an unused session dies after this window.
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Mint a session for a user; returns the plaintext token (stored client-side). */
export function createSession(db: Db, userId: string): string {
  const id = randomUUID();
  const secret = `carbons_${randomBytes(24).toString('hex')}`;
  const now = Date.now();
  db.run(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      sha256Hex(secret),
      new Date(now).toISOString(),
      new Date(now + SESSION_TTL_MS).toISOString(),
    ],
  );
  return secret;
}

/** Validate a session token; null if unknown or expired. Slides the expiry on use. */
function validateSession(db: Db, secret: string): { userId: string } | null {
  const row = db.get<{ id: string; user_id: string; expires_at: string }>(
    'SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?',
    [sha256Hex(secret)],
  );
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) < now) {
    db.run('DELETE FROM sessions WHERE id = ?', [row.id]);
    return null;
  }
  db.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?', [
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_MS).toISOString(),
    row.id,
  ]);
  return { userId: row.user_id };
}

/** Revoke a session by its plaintext token (logout). No-op if unknown. */
export function revokeSession(db: Db, secret: string): void {
  db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256Hex(secret)]);
}

// ----- API tokens (for HA / integrations / Hermes) --------------------------

export interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
}

/** Create a token; returns the plaintext secret (shown once) + the row. */
export function createToken(
  db: Db,
  input: { userId: string; name: string; scopes: string[] },
): { token: string; row: TokenRow } {
  const id = randomUUID();
  const secret = `carbon_${randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.userId, input.name, sha256Hex(secret), JSON.stringify(input.scopes), now],
  );
  return {
    token: secret,
    row: { id, user_id: input.userId, name: input.name, scopes: input.scopes, created_at: now, last_used_at: null },
  };
}

export function listTokens(db: Db): TokenRow[] {
  return db
    .all<{ id: string; user_id: string; name: string; scopes: string; created_at: string; last_used_at: string | null }>(
      'SELECT id, user_id, name, scopes, created_at, last_used_at FROM api_tokens WHERE revoked = 0 ORDER BY created_at DESC',
    )
    .map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] }));
}

export function revokeToken(db: Db, id: string): void {
  db.run('UPDATE api_tokens SET revoked = 1 WHERE id = ?', [id]);
}

function validateToken(
  db: Db,
  secret: string,
): { userId: string; scopes: string[] } | null {
  const row = db.get<{ id: string; user_id: string; scopes: string }>(
    'SELECT id, user_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked = 0',
    [sha256Hex(secret)],
  );
  if (!row) return null;
  db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
  return { userId: row.user_id, scopes: JSON.parse(row.scopes) as string[] };
}

function userCount(db: Db): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE deleted = 0')?.n ?? 0;
}

export function setPassword(db: Db, userId: string, passwordHash: string): void {
  db.run(
    `INSERT INTO user_auth (user_id, password_hash) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash`,
    [userId, passwordHash],
  );
}

function getPasswordHash(db: Db, userId: string): string | undefined {
  return db.get<{ password_hash: string }>(
    'SELECT password_hash FROM user_auth WHERE user_id = ?',
    [userId],
  )?.password_hash;
}

export function getHaPerson(db: Db, userId: string): string | null {
  return (
    db.get<{ ha_person: string | null }>('SELECT ha_person FROM user_auth WHERE user_id = ?', [
      userId,
    ])?.ha_person ?? null
  );
}

export function setHaPerson(db: Db, userId: string, person: string | null): void {
  db.run(
    `INSERT INTO user_auth (user_id, password_hash, ha_person) VALUES (?, '', ?)
     ON CONFLICT(user_id) DO UPDATE SET ha_person = excluded.ha_person`,
    [userId, person],
  );
}

export function resolveUserByHaPerson(db: Db, person: string): string | null {
  return (
    db.get<{ user_id: string }>('SELECT user_id FROM user_auth WHERE ha_person = ?', [person])
      ?.user_id ?? null
  );
}

// ----- GPS history (HA device-tracker feed) --------------------------------

/** Store the latest GPS coordinate for a user (called by HA on a tick). */
export function saveGps(db: Db, userId: string, lat: number, lng: number): void {
  db.run(
    `INSERT INTO gps_history (user_id, lat, lng, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at`,
    [userId, lat, lng, new Date().toISOString()],
  );
}

/** Get the latest GPS coordinate for a user, or null if none recorded. */
export function getGps(
  db: Db,
  userId: string,
): { lat: number; lng: number; updated_at: string } | null {
  return (
    db.get<{ lat: number; lng: number; updated_at: string }>(
      'SELECT lat, lng, updated_at FROM gps_history WHERE user_id = ?',
      [userId],
    ) ?? null
  );
}

/**
 * On each tick, check every user with a known GPS position against their
 * geo-tagged active tasks.  If they are within radius of a task they haven't
 * been notified about recently, fire a push notification.
 */
export function checkGpsProximity(db: Db): void {
  const rows = db.all<{ user_id: string; lat: number; lng: number }>(
    'SELECT user_id, lat, lng FROM gps_history',
  );

  for (const pos of rows) {
    const visible = visibleItemIds(db, pos.user_id);
    const items = allItems(db).filter((i) => visible.has(i.id));
    const point = { lat: pos.lat, lng: pos.lng };
    const near = tasksAtLocation(items, point);
    for (const t of near) {
      const marker = `gps:${t.id}`;
      if (alreadySent(db, t.id, 'gps', marker)) continue;
      void notifyTask(db, t.id, {
        title: 'Near task',
        body: t.title || 'Untitled task',
        url: '/today',
        tag: marker,
      });
      markSent(db, t.id, 'gps', marker);
    }
  }
}

function alreadySent(db: Db, itemId: string, kind: string, marker: string): boolean {
  return !!db.get(
    'SELECT 1 AS x FROM reminders_sent WHERE item_id = ? AND kind = ? AND marker = ?',
    [itemId, kind, marker],
  );
}

function markSent(db: Db, itemId: string, kind: string, marker: string): void {
  db.run(
    `INSERT INTO reminders_sent (item_id, kind, marker, sent_at) VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [itemId, kind, marker, new Date().toISOString()],
  );
}

/** Start a 1-minute GPS proximity check across all tenants. */
export function startGpsScheduler(dbs: () => Db[]): void {
  setInterval(() => {
    for (const db of dbs()) {
      try {
        checkGpsProximity(db);
      } catch (e) {
        console.error('[carbon] gps proximity check failed:', e);
      }
    }
  }, 60_000);
}

/**
 * On first run, seed users from AUTH_USERS="alice:<sha256hex>,bob:<sha256hex>"
 * as admins. Once any user exists, the env is ignored — manage users via the API.
 */
export function bootstrapUsers(db: Db, env: string | undefined): void {
  if (userCount(db) > 0 || !env) return;
  for (const pair of env.split(',').map((p) => p.trim()).filter(Boolean)) {
    const idx = pair.indexOf(':');
    if (idx < 0) continue;
    const username = pair.slice(0, idx);
    const hash = pair.slice(idx + 1).toLowerCase();
    if (!username || !hash) continue;
    const user = createUser(db, { username, displayName: username, role: 'admin' });
    setPassword(db, user.id, hash);
    console.log(`[carbon] bootstrapped admin user "${username}"`);
  }
}

/**
 * Basic-auth against the DB. If there are no users at all, run open (single-user
 * first run) as a synthetic local admin. Sets userId/username/role on the context.
 */
export function basicAuth(
  db: Db,
  allowOpen = true,
): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    if (allowOpen && userCount(db) === 0) {
      c.set('userId', 'local');
      c.set('username', 'local');
      c.set('role', 'admin');
      c.set('scopes', [...SCOPES]);
      c.set('authMethod', 'open');
      return next();
    }
    const header = c.req.header('Authorization');

    // Bearer token. A session token is a full human identity (sign-in from a
    // browser/device); an api_token is a scoped integration. Try session first.
    if (header?.startsWith('Bearer ')) {
      const secret = header.slice(7).trim();
      const session = validateSession(db, secret);
      const sessionUser = session ? getUser(db, session.userId) : undefined;
      if (session && sessionUser) {
        c.set('userId', sessionUser.id);
        c.set('username', sessionUser.username);
        c.set('role', sessionUser.role);
        c.set('scopes', [...SCOPES]);
        c.set('authMethod', 'session');
        return next();
      }
      const validated = validateToken(db, secret);
      const user = validated ? getUser(db, validated.userId) : undefined;
      if (validated && user) {
        c.set('userId', user.id);
        c.set('username', user.username);
        c.set('role', user.role);
        c.set('scopes', validated.scopes);
        c.set('authMethod', 'token');
        return next();
      }
      return c.json({ error: 'invalid token' }, 401);
    }

    // Basic auth (human users). Full scopes.
    const creds = decodeBasic(header);
    if (creds) {
      const user = getUserByUsername(db, creds.username);
      const hash = user ? getPasswordHash(db, user.id) : undefined;
      if (user && hash && verifyPassword(hash, creds.password)) {
        c.set('userId', user.id);
        c.set('username', user.username);
        c.set('role', user.role);
        c.set('scopes', [...SCOPES]);
        c.set('authMethod', 'basic');
        return next();
      }
      // Spend comparable work on a missing user so response timing doesn't reveal
      // which usernames exist (A9).
      if (!user) verifyPassword(DUMMY_HASH, creds.password);
    }
    // Note: deliberately NO WWW-Authenticate header — that would make the browser
    // pop its native Basic-auth login dialog. Carbon handles sign-in in-app.
    return c.json({ error: 'unauthorized' }, 401);
  };
}

/** Admin guard — humans only (tokens never get admin powers). */
export const requireAdmin: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  if (c.get('authMethod') === 'token' || c.get('role') !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  return next();
};

/** Scope guard — human (basic/open) sessions pass; tokens must hold the scope. */
export function requireScope(scope: Scope): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    if (c.get('authMethod') !== 'token') return next();
    const scopes = c.get('scopes') ?? [];
    if (scopes.includes(scope)) return next();
    return c.json({ error: `missing scope: ${scope}` }, 403);
  };
}

function decodeBasic(header: string | undefined): { username: string; password: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/** Public projection of a user (no secrets) for the roster + /api/me. */
export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    is_bot: u.is_bot,
    avatar_color: u.avatar_color,
    avatar_initial: u.avatar_initial,
    plan_startup_min: u.plan_startup_min,
    plan_default_estimate_min: u.plan_default_estimate_min,
  };
}

export { listUsers };
