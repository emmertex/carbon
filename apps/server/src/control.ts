import { randomUUID, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { Context, MiddlewareHandler } from 'hono';
import { type Db, createUser, getUserByUsername } from '@carbon/core';
import { openDb } from './sqlite';
import {
  hashPassword,
  verifyPassword,
  setPassword,
  sha256Hex,
  createFailThrottle,
  LOGIN_FAIL_WINDOW_MS,
  LOGIN_FAIL_MAX,
  LOGIN_FAIL_IP_MAX,
} from './auth';
import { setVerifiedEmail } from './mfa';
import { initTenantDb, RESERVED_SUBDOMAINS, type TenantLocation } from './tenant';
import { setNlSettings } from './agents';
import { getHostLmConfig, HOST_LM_AGENT_ID } from './host-lm';

export type TenantStatus = 'active' | 'provisional' | 'suspended' | 'deleted';

export interface TenantRecord {
  id: string;
  subdomain: string;
  display_name: string | null;
  status: TenantStatus;
  plan: string | null;
  created_at: string;
  db_path: string;
  blobs_dir: string;
  /** ISO timestamp after which the workspace locks (read-only renew gate). Null = never. */
  expires_at: string | null;
  /** ISO timestamp set when a host admin manually locks the workspace. Null = not locked. */
  locked_at: string | null;
  /** Contact email captured at signup (receipts / expiry notices / host-admin display). */
  admin_email: string | null;
  /** Per-workspace blob storage cap in bytes. Null = use the server default;
   *  0 = unlimited. Enforced before accepting new blob uploads. */
  blob_quota_bytes: number | null;
  /** Max human (non-bot) users this workspace may have. Null = use the server
   *  default (MAX_WORKSPACE_USERS); 0 = unlimited. Enforced on user creation. */
  max_users: number | null;
  /** 1 = this workspace's agents may target private/loopback/LAN endpoints (e.g. a
   *  self-hosted LLM); null/0 = blocked by the SSRF guard. Host-admin controlled. */
  allow_private_endpoints: number | null;
  /** 1 = this workspace may select the host-shared LM (see host-lm.ts) for NL commands /
   *  Telegram; 0 = not offered. Host-admin controlled; seeded at provision time. */
  host_lm_available: number | null;
  /** Host-ceiling override for federation (Gate 1). One of `off`|`intra_server`|
   *  `cross_server`; null = inherit the FEDERATION_MODE env default. Host-admin
   *  controlled; lets a host pin one abusive tenant below the global default. */
  federation_mode: string | null;
}

/** Lock = derived state. A workspace is "locked" (soft gate) when it is operationally
 *  active but its access has lapsed: either a host admin set locked_at, or the expiry
 *  passed. Distinct from `suspended` (operator hard-off, doesn't resolve at all). */
export type LockState = 'open' | 'locked';

export function tenantLockState(
  rec: Pick<TenantRecord, 'status' | 'expires_at' | 'locked_at'>,
  now: number = Date.now(),
): LockState {
  if (rec.status !== 'active') return 'open'; // provisional flows in unlocked; others don't resolve
  if (rec.locked_at) return 'locked';
  if (rec.expires_at && now > Date.parse(rec.expires_at)) return 'locked';
  return 'open';
}

/** Control-plane vars set on the Hono context for host-admin routes. */
export interface HostVars {
  hostAdmin: string;
}

/** Add a column if it isn't already present (idempotent migration for control.db,
 *  which has no migration runner — mirrors the ALTER pattern in @carbon/core schema). */
function ensureColumn(db: Db, table: string, col: string, decl: string): void {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}

/** Open the cross-tenant control DB (tenant registry, host admins, subscriptions). */
export function openControlDb(path: string): Db {
  const db = openDb(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id           TEXT PRIMARY KEY,
      subdomain    TEXT NOT NULL UNIQUE,
      display_name TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      plan         TEXT,
      created_at   TEXT NOT NULL,
      db_path      TEXT NOT NULL,
      blobs_dir    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_admins (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      tenant_id          TEXT PRIMARY KEY,
      provider           TEXT,
      external_id        TEXT,
      status             TEXT,
      current_period_end TEXT
    );
    -- Webhook idempotency: each provider event is applied at most once.
    CREATE TABLE IF NOT EXISTS billing_events (
      event_id    TEXT PRIMARY KEY,
      type        TEXT,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_signups (
      id             TEXT PRIMARY KEY,
      email          TEXT NOT NULL,
      subdomain      TEXT,
      display_name   TEXT,
      admin_username TEXT NOT NULL,
      password_hash  TEXT NOT NULL,
      code_hash      TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      attempts       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_signups(email);
    -- Email-verified workspace self-deletion. One pending row per tenant (re-starting
    -- reissues the code). token_hash is null until the OTC is verified; once set it
    -- authorizes the data export + the final delete until expires_at.
    CREATE TABLE IF NOT EXISTS pending_deletes (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL UNIQUE,
      email       TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      token_hash  TEXT,
      expires_at  TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_delete_token ON pending_deletes(token_hash);
  `);
  // Additive migrations for control DBs created before the billing/expiry feature.
  ensureColumn(db, 'tenants', 'expires_at', 'TEXT');
  ensureColumn(db, 'tenants', 'locked_at', 'TEXT');
  ensureColumn(db, 'tenants', 'admin_email', 'TEXT');
  ensureColumn(db, 'tenants', 'blob_quota_bytes', 'INTEGER');
  ensureColumn(db, 'tenants', 'max_users', 'INTEGER');
  ensureColumn(db, 'tenants', 'allow_private_endpoints', 'INTEGER');
  // 1 = this workspace may use the host-shared LM (see host-lm.ts). Defaults to available
  // (1) for pre-existing tenants; new tenants get an explicit value from
  // HOST_LM_AVAILABLE_NEW_ACCOUNTS at provision time (see provisionTenant below).
  ensureColumn(db, 'tenants', 'host_lm_available', 'INTEGER NOT NULL DEFAULT 1');
  // Federation host-ceiling override (Gate 1). Null = inherit FEDERATION_MODE env default.
  ensureColumn(db, 'tenants', 'federation_mode', 'TEXT');
  // Subscription columns added for Square auto-renewing subscriptions.
  ensureColumn(db, 'subscriptions', 'square_customer_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'square_subscription_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'plan_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'canceled_at', 'TEXT');
  return db;
}

// ----- host admins ----------------------------------------------------------

function hostAdminCount(db: Db): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM host_admins')?.n ?? 0;
}

/** Seed host admins from HOST_ADMINS="alice:<sha256hex>,bob:<sha256hex>" on first run. */
export function bootstrapHostAdmins(db: Db, env: string | undefined): void {
  if (hostAdminCount(db) > 0 || !env) return;
  for (const pair of env.split(',').map((p) => p.trim()).filter(Boolean)) {
    const idx = pair.indexOf(':');
    if (idx < 0) continue;
    const username = pair.slice(0, idx);
    const hash = pair.slice(idx + 1).toLowerCase();
    if (!username || !hash) continue;
    db.run('INSERT OR IGNORE INTO host_admins (id, username, password_hash) VALUES (?, ?, ?)', [
      randomUUID(),
      username,
      hash,
    ]);
    console.log(`[carbon] bootstrapped host admin "${username}"`);
  }
}

// A real-shaped scrypt hash to compare against when the host admin is unknown.
const DUMMY_HOST_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(64)}`;

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

// Host-admin Basic-auth brute-force throttle (same window/caps as tenant login).
const hostAdminFailByUser = createFailThrottle(LOGIN_FAIL_WINDOW_MS, LOGIN_FAIL_MAX);
const hostAdminFailByIp = createFailThrottle(LOGIN_FAIL_WINDOW_MS, LOGIN_FAIL_IP_MAX);

export interface HostAdminAuthOptions {
  /** Resolve client IP for per-IP lockout (from trusted clientIp helper). */
  clientIp?: (c: Context) => string;
}

/** Basic-auth guard for /host/* admin routes against the host_admins table. */
export function hostAdminAuth(
  db: Db,
  opts: HostAdminAuthOptions = {},
): MiddlewareHandler<{ Variables: HostVars }> {
  return async (c, next) => {
    const creds = decodeBasic(c.req.header('Authorization'));
    if (creds) {
      const userKey = creds.username.toLowerCase();
      const ip = opts.clientIp?.(c) ?? 'unknown';
      if (
        !hostAdminFailByUser.allowed(userKey) ||
        (ip !== 'unknown' && !hostAdminFailByIp.allowed(ip))
      ) {
        return c.json({ error: 'too many attempts, try later' }, 429);
      }
      const row = db.get<{ password_hash: string }>(
        'SELECT password_hash FROM host_admins WHERE username = ?',
        [creds.username],
      );
      if (row && verifyPassword(row.password_hash, creds.password)) {
        hostAdminFailByUser.clear(userKey);
        if (ip !== 'unknown') hostAdminFailByIp.clear(ip);
        c.set('hostAdmin', creds.username);
        return next();
      }
      // Constant-ish work on a missing admin so timing doesn't leak valid usernames.
      if (!row) verifyPassword(DUMMY_HOST_HASH, creds.password);
      hostAdminFailByUser.record(userKey);
      if (ip !== 'unknown') hostAdminFailByIp.record(ip);
    }
    return c.json({ error: 'unauthorized' }, 401);
  };
}

// ----- tenant records -------------------------------------------------------

export function listTenants(db: Db): TenantRecord[] {
  return db.all<TenantRecord>('SELECT * FROM tenants WHERE status != ? ORDER BY created_at', ['deleted']);
}

export function listActiveTenants(db: Db): TenantLocation[] {
  return db
    .all<TenantRecord>("SELECT * FROM tenants WHERE status IN ('active','provisional')")
    .map((r) => ({ id: r.id, subdomain: r.subdomain, dbPath: r.db_path, blobsDir: r.blobs_dir }));
}

export function getTenantById(db: Db, id: string): TenantRecord | null {
  return db.get<TenantRecord>('SELECT * FROM tenants WHERE id = ?', [id]) ?? null;
}

/** Resolve a routable tenant by subdomain. Suspended/deleted tenants resolve to null. */
export function resolveTenantLocation(db: Db, subdomain: string): TenantLocation | null {
  const r = db.get<TenantRecord>(
    "SELECT * FROM tenants WHERE subdomain = ? AND status IN ('active','provisional')",
    [subdomain],
  );
  if (!r) return null;
  return { id: r.id, subdomain: r.subdomain, dbPath: r.db_path, blobsDir: r.blobs_dir };
}

export function setTenantStatus(db: Db, id: string, status: TenantStatus): void {
  db.run('UPDATE tenants SET status = ? WHERE id = ?', [status, id]);
}

export function setTenantPlan(db: Db, id: string, plan: string | null): void {
  db.run('UPDATE tenants SET plan = ? WHERE id = ?', [plan, id]);
}

/** Resolve the full tenant record for a subdomain (any non-deleted status). Used by
 *  the lock gate + health, which must see locked/expired tenants (they still resolve). */
export function getTenantBySubdomain(db: Db, subdomain: string): TenantRecord | null {
  return (
    db.get<TenantRecord>("SELECT * FROM tenants WHERE subdomain = ? AND status != 'deleted'", [
      subdomain,
    ]) ?? null
  );
}

/** Host-admin "Set Expiry": when the workspace locks (null = never). */
export function setTenantExpiry(db: Db, id: string, expiresAt: string | null): void {
  db.run('UPDATE tenants SET expires_at = ? WHERE id = ?', [expiresAt, id]);
}

/** Host-admin "Lock"/"Unlock": set or clear the manual lock override. */
export function setTenantLock(db: Db, id: string, locked: boolean): void {
  db.run('UPDATE tenants SET locked_at = ? WHERE id = ?', [
    locked ? new Date().toISOString() : null,
    id,
  ]);
}

/** Host-admin per-workspace blob storage cap (bytes). Null resets to the server
 *  default; 0 means unlimited. */
export function setTenantBlobQuota(db: Db, id: string, bytes: number | null): void {
  db.run('UPDATE tenants SET blob_quota_bytes = ? WHERE id = ?', [bytes, id]);
}

/** Host-admin per-workspace user cap. Null resets to the server default
 *  (MAX_WORKSPACE_USERS); 0 means unlimited. */
export function setTenantMaxUsers(db: Db, id: string, n: number | null): void {
  db.run('UPDATE tenants SET max_users = ? WHERE id = ?', [n, id]);
}

/** Persist the workspace billing/contact email (e.g. captured at subscribe time when a
 *  host-admin-created tenant had none). Used for receipts + the Square customer. */
export function setTenantAdminEmail(db: Db, id: string, email: string | null): void {
  db.run('UPDATE tenants SET admin_email = ? WHERE id = ?', [email, id]);
}

/** Host-admin "Allow private endpoints": let this workspace's agents reach
 *  private/loopback/LAN hosts despite the multi-tenant SSRF guard. */
export function setTenantAllowPrivate(db: Db, id: string, allow: boolean): void {
  db.run('UPDATE tenants SET allow_private_endpoints = ? WHERE id = ?', [allow ? 1 : 0, id]);
}

/** Host-admin: grant/revoke this workspace's access to the host-shared LM. */
export function setTenantHostLmAvailable(db: Db, id: string, available: boolean): void {
  db.run('UPDATE tenants SET host_lm_available = ? WHERE id = ?', [available ? 1 : 0, id]);
}

/** Host-admin federation host-ceiling override (Gate 1). `off`|`intra_server`|
 *  `cross_server`, or null to reset to the FEDERATION_MODE env default. */
export function setTenantFederationMode(
  db: Db,
  id: string,
  mode: 'off' | 'intra_server' | 'cross_server' | null,
): void {
  db.run('UPDATE tenants SET federation_mode = ? WHERE id = ?', [mode, id]);
}

/** Soft-delete then remove the tenant's data dir. Caller handles export/grace first. */
export function deleteTenant(db: Db, id: string): void {
  const rec = getTenantById(db, id);
  setTenantStatus(db, id, 'deleted');
  if (rec) {
    try {
      // dataDir is the parent of the db file: data/tenants/<id>/
      rmSync(join(rec.db_path, '..'), { recursive: true, force: true });
    } catch (e) {
      console.error(`[carbon] failed to remove tenant data dir for ${id}:`, e);
    }
  }
}

// ----- subdomain validation + provisioning ----------------------------------

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Returns an error message if the subdomain is invalid/reserved, else null. */
export function validateSubdomain(s: string): string | null {
  const label = s.toLowerCase();
  if (!SUBDOMAIN_RE.test(label)) {
    return 'subdomain must be 1-63 chars: lowercase letters, digits, hyphens (not leading/trailing)';
  }
  if (RESERVED_SUBDOMAINS.has(label)) return 'subdomain is reserved';
  return null;
}

function generateSubdomain(): string {
  return randomBytes(3).toString('hex'); // 6 hex chars, e.g. "89eb1c"
}

export interface ProvisionInput {
  subdomain?: string;
  adminUsername: string;
  /** Plaintext password (hashed here). Omit when passing adminPasswordHash. */
  adminPassword?: string;
  /** Pre-hashed password (e.g. carried through pending_signups). Wins over adminPassword. */
  adminPasswordHash?: string;
  displayName?: string;
  plan?: string;
  status?: TenantStatus;
  /** ISO timestamp the workspace locks at (trial end). Null/omitted = never expires. */
  expiresAt?: string | null;
  /** Contact email stored on the tenant for receipts / notices. */
  adminEmail?: string | null;
}

/**
 * Create a tenant: register it, build its DB (full per-tenant init), and seed the
 * first admin user. Returns the new record. Throws on validation / collision.
 */
export function provisionTenant(db: Db, tenantsDir: string, input: ProvisionInput): TenantRecord {
  const passwordHash = input.adminPasswordHash ?? (input.adminPassword ? hashPassword(input.adminPassword) : null);
  if (!input.adminUsername || !passwordHash) {
    throw new Error('adminUsername and a password (or password hash) required');
  }

  let subdomain = input.subdomain?.toLowerCase().trim() || generateSubdomain();
  if (input.subdomain) {
    const err = validateSubdomain(subdomain);
    if (err) throw new Error(err);
  } else {
    // Retry auto-generated slugs until one is free.
    let tries = 0;
    while (db.get('SELECT 1 AS x FROM tenants WHERE subdomain = ?', [subdomain]) && tries++ < 10) {
      subdomain = generateSubdomain();
    }
  }
  if (db.get('SELECT 1 AS x FROM tenants WHERE subdomain = ?', [subdomain])) {
    throw new Error('subdomain already taken');
  }

  const id = randomUUID();
  const dbPath = join(tenantsDir, id, 'carbon.db');
  const blobsDir = join(tenantsDir, id, 'blobs');
  const createdAt = new Date().toISOString();
  const status: TenantStatus = input.status ?? 'active';
  // New signups get an explicit value from the current env setting, rather than the
  // grandfathering default the ensureColumn migration gives pre-existing tenants.
  const hostLmCfg = getHostLmConfig();
  const hostLmAvailable = hostLmCfg ? hostLmCfg.availableNewAccounts : false;

  db.run(
    `INSERT INTO tenants
       (id, subdomain, display_name, status, plan, created_at, db_path, blobs_dir, expires_at, admin_email, host_lm_available)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      subdomain,
      input.displayName ?? null,
      status,
      input.plan ?? null,
      createdAt,
      dbPath,
      blobsDir,
      input.expiresAt ?? null,
      input.adminEmail ?? null,
      hostLmAvailable ? 1 : 0,
    ],
  );

  // Build the tenant DB and seed its first admin (so it is not in open-mode). If any
  // of this fails, roll back the tenants row and remove the half-built data dir so we
  // don't leave a "ghost" tenant that resolves but can't load (A7).
  try {
    const ctx = initTenantDb({ id, subdomain, dbPath, blobsDir });
    if (getUserByUsername(ctx.db, input.adminUsername)) {
      // Brand-new DB, should never happen — defensive.
      throw new Error('admin username already exists in fresh tenant');
    }
    const user = createUser(ctx.db, {
      username: input.adminUsername,
      displayName: input.displayName ?? input.adminUsername,
      role: 'admin',
    });
    setPassword(ctx.db, user.id, passwordHash);
    // Signup OTC already proved this address — count it as the email MFA factor so
    // the admin only needs a new-device challenge (or can add TOTP as backup).
    if (input.adminEmail) {
      try {
        setVerifiedEmail(ctx.db, user.id, input.adminEmail);
      } catch {
        /* invalid email at provision time — skip; admin can enroll later */
      }
    }
    // Pre-enable NL commands with the host-shared model when the host operator opted new
    // accounts into that by default.
    if (hostLmAvailable && hostLmCfg?.enabledByDefault) {
      setNlSettings(ctx.db, { agentId: HOST_LM_AGENT_ID, enabled: true });
    }
  } catch (e) {
    db.run('DELETE FROM tenants WHERE id = ?', [id]);
    try {
      rmSync(join(tenantsDir, id), { recursive: true, force: true });
    } catch {
      /* nothing to clean up */
    }
    throw e;
  }

  return getTenantById(db, id)!;
}

// ----- OTC email-verified signups -------------------------------------------

const OTC_TTL_MIN = Math.max(1, Number(process.env.OTC_TTL_MIN) || 15);
const OTC_MAX_ATTEMPTS = Math.max(1, Number(process.env.OTC_MAX_ATTEMPTS) || 5);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface PendingSignupRow {
  id: string;
  email: string;
  subdomain: string | null;
  display_name: string | null;
  admin_username: string;
  password_hash: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  created_at: string;
}

export interface StartSignupInput {
  email: string;
  subdomain?: string;
  displayName?: string;
  adminUsername: string;
  adminPassword: string;
}

function generateOtc(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Newest non-expired pending signup for an email, or null. */
export function getPendingSignup(db: Db, email: string): PendingSignupRow | null {
  const row = db.get<PendingSignupRow>(
    'SELECT * FROM pending_signups WHERE email = ? ORDER BY created_at DESC LIMIT 1',
    [email.trim().toLowerCase()],
  );
  if (!row) return null;
  if (Date.now() > Date.parse(row.expires_at)) {
    db.run('DELETE FROM pending_signups WHERE id = ?', [row.id]);
    return null;
  }
  return row;
}

/**
 * Stage a signup pending email verification: validate, hash the password + a fresh
 * 6-digit code, and (re)insert the pending row for this email. Returns the plaintext
 * code for the caller to email. Throws on validation / subdomain collision.
 */
export function createPendingSignup(db: Db, input: StartSignupInput): { id: string; code: string } {
  if (!EMAIL_RE.test(input.email)) throw new Error('a valid email is required');
  if (!input.adminUsername || !input.adminPassword) {
    throw new Error('adminUsername and adminPassword required');
  }
  if (input.subdomain) {
    const err = validateSubdomain(input.subdomain);
    if (err) throw new Error(err);
    if (db.get('SELECT 1 AS x FROM tenants WHERE subdomain = ?', [input.subdomain.toLowerCase()])) {
      throw new Error('subdomain already taken');
    }
  }
  const id = randomUUID();
  const code = generateOtc();
  const now = Date.now();
  const expiresAt = new Date(now + OTC_TTL_MIN * 60_000).toISOString();
  const email = input.email.trim().toLowerCase();
  // Replace any prior pending row for this email so re-requesting reissues a code.
  db.transaction(() => {
    db.run('DELETE FROM pending_signups WHERE email = ?', [email]);
    db.run(
      `INSERT INTO pending_signups
         (id, email, subdomain, display_name, admin_username, password_hash, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        id,
        email,
        input.subdomain?.toLowerCase().trim() || null,
        input.displayName?.trim() || null,
        input.adminUsername,
        hashPassword(input.adminPassword),
        sha256Hex(code),
        expiresAt,
        new Date(now).toISOString(),
      ],
    );
  });
  return { id, code };
}

/**
 * Verify a code against the newest non-expired pending row for an email. On success
 * returns the pending record (caller provisions then deletes it). On mismatch the
 * attempt is counted and the row is deleted once attempts hit the cap.
 */
export function verifyPendingSignup(
  db: Db,
  email: string,
  code: string,
): { ok: true; pending: PendingSignupRow } | { ok: false; error: string } {
  const row = db.get<PendingSignupRow>(
    'SELECT * FROM pending_signups WHERE email = ? ORDER BY created_at DESC LIMIT 1',
    [email.trim().toLowerCase()],
  );
  // Stable error for every failure mode so callers can't probe whether a pending
  // signup exists for an email (or whether the code expired vs was wrong).
  if (!row) return { ok: false, error: 'invalid_code' };
  if (Date.now() > Date.parse(row.expires_at)) {
    db.run('DELETE FROM pending_signups WHERE id = ?', [row.id]);
    return { ok: false, error: 'invalid_code' };
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(sha256Hex(String(code ?? '')), 'hex');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!match) {
    const attempts = row.attempts + 1;
    if (attempts >= OTC_MAX_ATTEMPTS) {
      db.run('DELETE FROM pending_signups WHERE id = ?', [row.id]);
    } else {
      db.run('UPDATE pending_signups SET attempts = ? WHERE id = ?', [attempts, row.id]);
    }
    return { ok: false, error: 'invalid_code' };
  }
  return { ok: true, pending: row };
}

export function deletePendingSignup(db: Db, id: string): void {
  db.run('DELETE FROM pending_signups WHERE id = ?', [id]);
}

/** Sweep expired pending signups (called from the maintenance scheduler). */
export function gcPendingSignups(db: Db): void {
  db.run('DELETE FROM pending_signups WHERE expires_at < ?', [new Date().toISOString()]);
}

// ----- OTC email-verified workspace deletion --------------------------------
// Mirrors the signup OTC flow, but for tearing a workspace down. Anyone who can
// receive the workspace's contact email can delete it — being signed in is neither
// required nor sufficient (the page is reachable without a session). The verified
// OTC mints a short-lived token that authorizes both the data export and the final
// irreversible delete.

/** How long a verified delete token stays valid (export + confirm window). */
const DELETE_TOKEN_TTL_MIN = Math.max(1, Number(process.env.DELETE_TOKEN_TTL_MIN) || 30);

export interface PendingDeleteRow {
  id: string;
  tenant_id: string;
  email: string;
  code_hash: string;
  token_hash: string | null;
  expires_at: string;
  attempts: number;
  created_at: string;
}

/**
 * Stage a workspace deletion pending email verification: (re)insert a pending row for
 * the tenant with a fresh 6-digit code. Returns the plaintext code for the caller to
 * email. The caller is responsible for confirming the email matches the workspace
 * before invoking this (so an unrelated address can't trigger a delete code).
 */
export function createPendingDelete(
  db: Db,
  input: { tenantId: string; email: string },
): { id: string; code: string } {
  const id = randomUUID();
  const code = generateOtc();
  const now = Date.now();
  const expiresAt = new Date(now + OTC_TTL_MIN * 60_000).toISOString();
  const email = input.email.trim().toLowerCase();
  // One pending row per tenant; re-requesting reissues a code and clears any prior token.
  db.run(
    `INSERT INTO pending_deletes (id, tenant_id, email, code_hash, token_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, 0, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       id = excluded.id, email = excluded.email, code_hash = excluded.code_hash,
       token_hash = NULL, expires_at = excluded.expires_at, attempts = 0,
       created_at = excluded.created_at`,
    [id, input.tenantId, email, sha256Hex(code), expiresAt, new Date(now).toISOString()],
  );
  return { id, code };
}

/**
 * Verify a delete code for a tenant. On success, mint and store a short-lived token
 * (returned plaintext to the caller) that authorizes the export + final delete, and
 * return it. On mismatch the attempt is counted and the row dropped at the cap.
 */
export function verifyPendingDelete(
  db: Db,
  tenantId: string,
  code: string,
): { ok: true; token: string } | { ok: false; error: string } {
  const row = db.get<PendingDeleteRow>('SELECT * FROM pending_deletes WHERE tenant_id = ?', [tenantId]);
  if (!row) return { ok: false, error: 'invalid_code' };
  if (Date.now() > Date.parse(row.expires_at)) {
    db.run('DELETE FROM pending_deletes WHERE id = ?', [row.id]);
    return { ok: false, error: 'invalid_code' };
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(sha256Hex(String(code ?? '')), 'hex');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!match) {
    const attempts = row.attempts + 1;
    if (attempts >= OTC_MAX_ATTEMPTS) db.run('DELETE FROM pending_deletes WHERE id = ?', [row.id]);
    else db.run('UPDATE pending_deletes SET attempts = ? WHERE id = ?', [attempts, row.id]);
    return { ok: false, error: 'invalid_code' };
  }
  const token = `carbondel_${randomBytes(24).toString('hex')}`;
  const tokenExpiry = new Date(Date.now() + DELETE_TOKEN_TTL_MIN * 60_000).toISOString();
  db.run('UPDATE pending_deletes SET token_hash = ?, expires_at = ? WHERE id = ?', [
    sha256Hex(token),
    tokenExpiry,
    row.id,
  ]);
  return { ok: true, token };
}

/** Resolve a verified delete token to its pending row (tenant_id), or null if the
 *  token is unknown/expired. Used by both the export and the confirm-delete routes
 *  (it does not delete the row, so the same token serves both steps). */
export function resolveDeleteToken(db: Db, token: string): PendingDeleteRow | null {
  if (!token) return null;
  const row = db.get<PendingDeleteRow>('SELECT * FROM pending_deletes WHERE token_hash = ?', [sha256Hex(token)]);
  if (!row) return null;
  if (Date.now() > Date.parse(row.expires_at)) {
    db.run('DELETE FROM pending_deletes WHERE id = ?', [row.id]);
    return null;
  }
  return row;
}

export function deletePendingDelete(db: Db, id: string): void {
  db.run('DELETE FROM pending_deletes WHERE id = ?', [id]);
}

/** Sweep expired pending deletes (called from the maintenance scheduler). */
export function gcPendingDeletes(db: Db): void {
  db.run('DELETE FROM pending_deletes WHERE expires_at < ?', [new Date().toISOString()]);
}
