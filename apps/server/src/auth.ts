import { createHash, timingSafeEqual, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import {
  type Db,
  type User,
  listUsers,
  getUser,
  getUserByUsername,
  createUser,
  tasksNearLocation,
  visibleItemIds,
  heldTagIds,
  itemHasHeldTag,
} from '@carbon/core';
import { notifyTask } from './push';
import { alreadySent, markSent } from './reminders-sent';
import { ensureMfaTables, validateMfaChallenge } from './mfa';
import { stampedClientIp } from './client-ip';

export type AuthMethod = 'basic' | 'token' | 'session' | 'open' | 'mfa_challenge';
export const SCOPES = ['tasks:read', 'tasks:write', 'inbox:write'] as const;
export type Scope = (typeof SCOPES)[number];

export interface AuthVars {
  userId: string;
  username: string;
  role: 'admin' | 'member';
  scopes: string[];
  authMethod: AuthMethod;
  /** Set when authMethod === 'mfa_challenge'. */
  mfaChallengeId?: string;
  mfaChallengePurpose?: 'enroll' | 'login';
}

export interface BasicAuthOptions {
  /** Allow open/no-auth when the tenant has zero users. Opt-in; production sets via ALLOW_OPEN_MODE. */
  allowOpen?: boolean;
  /**
   * Paths (Hono route path, e.g. `/login`) where Basic auth is accepted for humans.
   * Everywhere else Basic is rejected so MFA cannot be bypassed.
   * Default: `['/login']`. Pass `null` to allow Basic on every path (tests only).
   */
  basicPaths?: string[] | null;
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

// ----- basic-auth brute-force throttle (API-1) ------------------------------
// Sliding-window caps on failed Basic-auth attempts:
//   • per tenant DB + lowercased username (enumeration-safe: unknown names count too)
//   • per client IP (cross-tenant; skipped when IP is 'unknown')
//   • optional global process-wide budget
export const LOGIN_FAIL_WINDOW_MS = 15 * 60_000; // 15 minutes
export const LOGIN_FAIL_MAX = 10; // max failed attempts per username per window
export const LOGIN_FAIL_IP_MAX = Math.max(
  LOGIN_FAIL_MAX,
  Number(process.env.LOGIN_FAIL_IP_MAX) || 30,
);
export const LOGIN_FAIL_GLOBAL_MAX = Math.max(
  LOGIN_FAIL_IP_MAX,
  Number(process.env.LOGIN_FAIL_GLOBAL_MAX) || 200,
);

type LoginFailBuckets = Map<string, number[]>;

/** Reusable sliding-window failure budget (host-admin auth, etc.). */
export function createFailThrottle(
  windowMs = LOGIN_FAIL_WINDOW_MS,
  max = LOGIN_FAIL_MAX,
): {
  allowed(key: string): boolean;
  record(key: string): void;
  clear(key: string): void;
} {
  const buckets: LoginFailBuckets = new Map();
  const prune = (now: number) => {
    const win = now - windowMs;
    for (const [k, v] of buckets) {
      const fresh = v.filter((t) => t > win);
      if (fresh.length) buckets.set(k, fresh);
      else buckets.delete(k);
    }
  };
  return {
    allowed(key: string): boolean {
      const now = Date.now();
      prune(now);
      return (buckets.get(key) ?? []).length < max;
    },
    record(key: string): void {
      const now = Date.now();
      prune(now);
      const hits = buckets.get(key) ?? [];
      hits.push(now);
      buckets.set(key, hits);
    },
    clear(key: string): void {
      buckets.delete(key);
    },
  };
}

const loginFailHitsByDb = new WeakMap<Db, LoginFailBuckets>();
const loginFailByIp = createFailThrottle(LOGIN_FAIL_WINDOW_MS, LOGIN_FAIL_IP_MAX);
let globalLoginFails: number[] = [];

function loginFailBuckets(db: Db): LoginFailBuckets {
  let buckets = loginFailHitsByDb.get(db);
  if (!buckets) {
    buckets = new Map();
    loginFailHitsByDb.set(db, buckets);
  }
  return buckets;
}

function pruneLoginFailHits(buckets: LoginFailBuckets, now: number): void {
  const win = now - LOGIN_FAIL_WINDOW_MS;
  for (const [k, v] of buckets) {
    const fresh = v.filter((t) => t > win);
    if (fresh.length) buckets.set(k, fresh);
    else buckets.delete(k);
  }
}

function globalLoginAllowed(): boolean {
  const now = Date.now();
  const win = now - LOGIN_FAIL_WINDOW_MS;
  globalLoginFails = globalLoginFails.filter((t) => t > win);
  return globalLoginFails.length < LOGIN_FAIL_GLOBAL_MAX;
}

function recordGlobalLoginFailure(): void {
  const now = Date.now();
  const win = now - LOGIN_FAIL_WINDOW_MS;
  globalLoginFails = globalLoginFails.filter((t) => t > win);
  globalLoginFails.push(now);
}

/** True if `key` (lowercased username) is still under the tenant's failed-attempt cap. */
function loginAllowed(db: Db, key: string): boolean {
  const now = Date.now();
  const buckets = loginFailBuckets(db);
  pruneLoginFailHits(buckets, now);
  const hits = buckets.get(key) ?? [];
  return hits.length < LOGIN_FAIL_MAX;
}

/** Username + IP + global budgets must all allow the attempt. */
function loginAttemptAllowed(db: Db, usernameKey: string, ip: string): boolean {
  if (!globalLoginAllowed()) return false;
  if (!loginAllowed(db, usernameKey)) return false;
  if (ip !== 'unknown' && !loginFailByIp.allowed(ip)) return false;
  return true;
}

/** Record a failed basic-auth attempt against `key` (lowercased username) in one tenant. */
function recordLoginFailure(db: Db, key: string, ip = 'unknown'): void {
  const now = Date.now();
  const buckets = loginFailBuckets(db);
  pruneLoginFailHits(buckets, now);
  const hits = buckets.get(key) ?? [];
  hits.push(now);
  buckets.set(key, hits);
  recordGlobalLoginFailure();
  if (ip !== 'unknown') loginFailByIp.record(ip);
}

/** Clear failure history for `key` on successful auth in one tenant. */
function clearLoginFailures(db: Db, key: string, ip = 'unknown'): void {
  loginFailHitsByDb.get(db)?.delete(key);
  if (ip !== 'unknown') loginFailByIp.clear(ip);
}

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
    -- Latest known Home Assistant zone per user (enter/leave webhook). Kept
    -- separate from gps_history so a zone update doesn't clobber GPS coords and
    -- vice-versa; the /api/where read merges both into one location.
    CREATE TABLE IF NOT EXISTS user_zone (
      user_id    TEXT PRIMARY KEY,
      zone       TEXT,
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
  ensureMfaTables(db);
  // Additive: horizontal accuracy (metres) for the latest GPS fix, when HA reports
  // it. Idempotent ALTER for DBs created before this column existed.
  const gpsCols = db.all<{ name: string }>(`PRAGMA table_info(gps_history)`);
  if (!gpsCols.some((c) => c.name === 'accuracy')) {
    db.exec(`ALTER TABLE gps_history ADD COLUMN accuracy REAL`);
  }

  // Per-device location store (multi-device Nearby). One row per (user, device):
  // an HA device-tracker, a phone, a laptop browser, etc. all coexist instead of
  // clobbering the single gps_history row. Read-time staleness filtering; a periodic
  // sweep hard-deletes very old rows. gps_history stays as the HA single-row that
  // drives background proximity push (a closed browser can't self-report anyway).
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_locations (
      user_id    TEXT NOT NULL,
      device_id  TEXT NOT NULL,
      name       TEXT,
      lat        REAL NOT NULL,
      lng        REAL NOT NULL,
      accuracy   REAL,
      source     TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_device_locations_user ON device_locations(user_id);
  `);
  // One-time migration: fold any existing single-row HA fix into device_locations so
  // the new read path has it. Idempotent (OR IGNORE on the PK).
  db.exec(`
    INSERT OR IGNORE INTO device_locations (user_id, device_id, name, lat, lng, accuracy, source, updated_at)
    SELECT user_id, 'ha:' || user_id, NULL, lat, lng, accuracy, 'ha', updated_at FROM gps_history
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

/** Revoke every session for a user (sign out everywhere). Returns count deleted. */
export function revokeAllSessions(db: Db, userId: string): number {
  const n =
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [userId])?.n ??
    0;
  db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
  return n;
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

/** Store the latest GPS coordinate for a user (called by HA on a tick). Accuracy
 *  (horizontal, metres) is optional — HA's device_tracker reports `gps_accuracy`. */
export function saveGps(
  db: Db,
  userId: string,
  lat: number,
  lng: number,
  accuracy?: number | null,
): void {
  db.run(
    `INSERT INTO gps_history (user_id, lat, lng, accuracy, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, updated_at = excluded.updated_at`,
    [userId, lat, lng, accuracy ?? null, new Date().toISOString()],
  );
}

/** Get the latest GPS coordinate for a user, or null if none recorded. */
export function getGps(
  db: Db,
  userId: string,
): { lat: number; lng: number; accuracy: number | null; updated_at: string } | null {
  return (
    db.get<{ lat: number; lng: number; accuracy: number | null; updated_at: string }>(
      'SELECT lat, lng, accuracy, updated_at FROM gps_history WHERE user_id = ?',
      [userId],
    ) ?? null
  );
}

// ----- per-device location store --------------------------------------------

export type LocationSource = 'device' | 'ha';

export interface DeviceLocation {
  deviceId: string;
  name: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  source: LocationSource;
  updatedAt: string;
}

/** Devices older than this are omitted from reads (one pill per fresh device). */
export const DEVICE_STALE_MS = 24 * 60 * 60 * 1000; // 1 day
/** Rows older than this are hard-deleted by the periodic sweep. */
export const DEVICE_HARD_DELETE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Upsert a device's latest fix, keyed by (user, device). */
export function saveDeviceLocation(
  db: Db,
  p: {
    userId: string;
    deviceId: string;
    name?: string | null;
    lat: number;
    lng: number;
    accuracy?: number | null;
    source: LocationSource;
  },
): void {
  db.run(
    `INSERT INTO device_locations (user_id, device_id, name, lat, lng, accuracy, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       name = COALESCE(excluded.name, device_locations.name),
       lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy,
       source = excluded.source, updated_at = excluded.updated_at`,
    [
      p.userId,
      p.deviceId,
      p.name ?? null,
      p.lat,
      p.lng,
      p.accuracy ?? null,
      p.source,
      new Date().toISOString(),
    ],
  );
}

function rowToDevice(r: {
  device_id: string;
  name: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  source: string;
  updated_at: string;
}): DeviceLocation {
  return {
    deviceId: r.device_id,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    accuracy: r.accuracy,
    source: r.source === 'ha' ? 'ha' : 'device',
    updatedAt: r.updated_at,
  };
}

/** All of a user's device fixes, newest first; optionally only those within `maxAgeMs`. */
export function listDeviceLocations(
  db: Db,
  userId: string,
  maxAgeMs?: number,
): DeviceLocation[] {
  const rows = db
    .all<Parameters<typeof rowToDevice>[0]>(
      `SELECT device_id, name, lat, lng, accuracy, source, updated_at
       FROM device_locations WHERE user_id = ? ORDER BY updated_at DESC`,
      [userId],
    )
    .map(rowToDevice);
  if (maxAgeMs == null) return rows;
  const cutoff = Date.now() - maxAgeMs;
  return rows.filter((d) => {
    const t = Date.parse(d.updatedAt);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** The freshest fix across all of a user's devices (within `maxAgeMs` if given). */
export function freshestDeviceLocation(
  db: Db,
  userId: string,
  maxAgeMs?: number,
): DeviceLocation | null {
  return listDeviceLocations(db, userId, maxAgeMs)[0] ?? null;
}

/** Remove a specific device (e.g. a retired phone). */
export function deleteDeviceLocation(db: Db, userId: string, deviceId: string): void {
  db.run('DELETE FROM device_locations WHERE user_id = ? AND device_id = ?', [userId, deviceId]);
}

/** Hard-delete rows older than `maxAgeMs` (periodic sweep). Returns rows removed. */
export function pruneStaleDeviceLocations(db: Db, maxAgeMs = DEVICE_HARD_DELETE_MS): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device_locations')?.n ?? 0;
  db.run('DELETE FROM device_locations WHERE updated_at < ?', [cutoff]);
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device_locations')?.n ?? 0;
  return before - after;
}

/** Store the user's current HA zone (on a zone enter). Pass null on leave. */
export function saveZone(db: Db, userId: string, zone: string | null): void {
  db.run(
    `INSERT INTO user_zone (user_id, zone, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET zone = excluded.zone, updated_at = excluded.updated_at`,
    [userId, zone, new Date().toISOString()],
  );
}

export interface UserLocation {
  /** Latest HA zone (cleared on leave), with the time it was entered. */
  zone: { name: string; updatedAt: string } | null;
  /** Latest HA device-tracker GPS fix, with accuracy (m) when known. */
  haGps: { lat: number; lng: number; accuracy: number | null; updatedAt: string } | null;
}

/** The user's current location, with the HA zone and HA GPS kept as distinct
 *  sources (each with its own timestamp) so the Nearby view can surface them
 *  individually. The native device GPS is a third source resolved client-side. */
export function getUserLocation(db: Db, userId: string): UserLocation {
  const gps = getGps(db, userId);
  const zoneRow = db.get<{ zone: string | null; updated_at: string }>(
    'SELECT zone, updated_at FROM user_zone WHERE user_id = ?',
    [userId],
  );
  return {
    zone: zoneRow?.zone ? { name: zoneRow.zone, updatedAt: zoneRow.updated_at } : null,
    haGps: gps
      ? { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy ?? null, updatedAt: gps.updated_at }
      : null,
  };
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

  const held = heldTagIds(db);
  for (const pos of rows) {
    const visible = visibleItemIds(db, pos.user_id);
    const point = { lat: pos.lat, lng: pos.lng };
    // Tag/project locations count as fallbacks (task > tag > project); on-hold
    // tagged tasks are muted like deferred ones.
    const near = tasksNearLocation(db, { point }).filter(
      (t) => visible.has(t.id) && !itemHasHeldTag(db, t.id, held),
    );
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

/** Start a 1-minute GPS proximity check across all tenants (also sweeps stale devices).
 *  Started `startDelayMs` after boot (default: offset from the reminder/federation
 *  sweep, which fires on-the-minute) so the two don't force-load every active tenant
 *  into the LRU on the same tick. */
export function startGpsScheduler(dbs: () => Db[], startDelayMs = 20_000): void {
  setTimeout(() => {
    setInterval(() => {
      for (const db of dbs()) {
        try {
          checkGpsProximity(db);
          pruneStaleDeviceLocations(db);
        } catch (e) {
          console.error('[carbon] gps proximity check failed:', e);
        }
      }
    }, 60_000);
  }, startDelayMs);
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
 * Auth against the DB. Open mode (no users → synthetic `local` admin) is opt-in
 * via `allowOpen` / `ALLOW_OPEN_MODE=1` — default deny. Humans authenticate via
 * session (or Basic on allowlisted paths like `/login`); integrations use scoped
 * API tokens; MFA challenge bearers (`mfac_…`) authenticate only the challenge
 * endpoints.
 */
export function basicAuth(
  db: Db,
  allowOpenOrOpts: boolean | BasicAuthOptions = false,
): MiddlewareHandler<{ Variables: AuthVars }> {
  const opts: BasicAuthOptions =
    typeof allowOpenOrOpts === 'boolean'
      ? { allowOpen: allowOpenOrOpts, basicPaths: ['/login'] }
      : {
          allowOpen: allowOpenOrOpts.allowOpen ?? false,
          basicPaths:
            allowOpenOrOpts.basicPaths === undefined ? ['/login'] : allowOpenOrOpts.basicPaths,
        };
  const allowBasicEverywhere = opts.basicPaths === null;
  const basicPathSet = new Set(opts.basicPaths ?? []);

  return async (c, next) => {
    if (opts.allowOpen && userCount(db) === 0) {
      c.set('userId', 'local');
      c.set('username', 'local');
      c.set('role', 'admin');
      c.set('scopes', [...SCOPES]);
      c.set('authMethod', 'open');
      return next();
    }
    const header = c.req.header('Authorization');
    // Hono may expose `/login` or `/api/login` depending on mount; match either.
    const path = c.req.path;
    const basicAllowed =
      allowBasicEverywhere ||
      [...basicPathSet].some((p) => path === p || path.endsWith(p));

    // Bearer token. Session = full human identity; api_token = scoped integration;
    // mfac_ = short-lived MFA challenge (enroll / login verify only).
    if (header?.startsWith('Bearer ')) {
      const secret = header.slice(7).trim();
      if (secret.startsWith('mfac_')) {
        // Challenge tokens are only valid on /mfa/* — never sync/admin/etc.
        if (!path.includes('/mfa/')) {
          return c.json({ error: 'invalid token' }, 401);
        }
        const challenge = validateMfaChallenge(db, secret);
        const user = challenge ? getUser(db, challenge.userId) : undefined;
        if (challenge && user) {
          c.set('userId', user.id);
          c.set('username', user.username);
          c.set('role', user.role);
          c.set('scopes', []);
          c.set('authMethod', 'mfa_challenge');
          c.set('mfaChallengeId', challenge.id);
          c.set('mfaChallengePurpose', challenge.purpose);
          return next();
        }
        return c.json({ error: 'invalid challenge' }, 401);
      }
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

    // Basic auth — password exchange for login / MFA start only. Reject elsewhere
    // so a password alone cannot reach sync/admin APIs and bypass 2FA.
    const creds = decodeBasic(header);
    if (creds) {
      if (!basicAllowed) {
        return c.json({ error: 'session required' }, 401);
      }
      const loginKey = creds.username.toLowerCase();
      const ip = stampedClientIp(c);
      if (!loginAttemptAllowed(db, loginKey, ip)) {
        return c.json({ error: 'too many attempts, try later' }, 429);
      }
      const user = getUserByUsername(db, creds.username);
      const hash = user ? getPasswordHash(db, user.id) : undefined;
      if (user && hash && verifyPassword(hash, creds.password)) {
        clearLoginFailures(db, loginKey, ip);
        c.set('userId', user.id);
        c.set('username', user.username);
        c.set('role', user.role);
        c.set('scopes', [...SCOPES]);
        c.set('authMethod', 'basic');
        return next();
      }
      // Spend comparable work on a missing user so response timing doesn't reveal
      // which usernames exist (A9). Count this failure the same as a wrong
      // password against the same username-derived key (A9 continued) so the
      // throttle map itself can't be used to probe which usernames exist.
      if (!user) verifyPassword(DUMMY_HASH, creds.password);
      recordLoginFailure(db, loginKey, ip);
    }
    // Note: deliberately NO WWW-Authenticate header — that would make the browser
    // pop its native Basic-auth login dialog. Carbon handles sign-in in-app.
    return c.json({ error: 'unauthorized' }, 401);
  };
}

/** Admin guard — humans only (tokens / MFA challenges never get admin powers). */
export const requireAdmin: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  const method = c.get('authMethod');
  if (method === 'token' || method === 'mfa_challenge' || c.get('role') !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  return next();
};

/** Require a completed human session (not Basic, challenge, or API token). */
export const requireSession: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  if (c.get('authMethod') !== 'session' && c.get('authMethod') !== 'open') {
    return c.json({ error: 'session required' }, 401);
  }
  return next();
};

/** Require a valid MFA challenge bearer. */
export const requireMfaChallenge: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  if (c.get('authMethod') !== 'mfa_challenge') {
    return c.json({ error: 'challenge required' }, 401);
  }
  return next();
};

/** Scope guard — session/open/basic pass; tokens must hold the scope; challenges never. */
export function requireScope(scope: Scope): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    if (c.get('authMethod') === 'mfa_challenge') {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    is_remote: u.is_remote,
    home_server: u.home_server,
  };
}

export { listUsers };
