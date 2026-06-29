import { randomUUID, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import { type Db, createUser, getUserByUsername } from '@carbon/core';
import { openDb } from './sqlite';
import { hashPassword, verifyPassword, setPassword, sha256Hex } from './auth';
import { initTenantDb, RESERVED_SUBDOMAINS, type TenantLocation } from './tenant';

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
  /** 1 = this workspace's agents may target private/loopback/LAN endpoints (e.g. a
   *  self-hosted LLM); null/0 = blocked by the SSRF guard. Host-admin controlled. */
  allow_private_endpoints: number | null;
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
  `);
  // Additive migrations for control DBs created before the billing/expiry feature.
  ensureColumn(db, 'tenants', 'expires_at', 'TEXT');
  ensureColumn(db, 'tenants', 'locked_at', 'TEXT');
  ensureColumn(db, 'tenants', 'admin_email', 'TEXT');
  ensureColumn(db, 'tenants', 'blob_quota_bytes', 'INTEGER');
  ensureColumn(db, 'tenants', 'allow_private_endpoints', 'INTEGER');
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

/** Basic-auth guard for /host/* admin routes against the host_admins table. */
export function hostAdminAuth(db: Db): MiddlewareHandler<{ Variables: HostVars }> {
  return async (c, next) => {
    const creds = decodeBasic(c.req.header('Authorization'));
    if (creds) {
      const row = db.get<{ password_hash: string }>(
        'SELECT password_hash FROM host_admins WHERE username = ?',
        [creds.username],
      );
      if (row && verifyPassword(row.password_hash, creds.password)) {
        c.set('hostAdmin', creds.username);
        return next();
      }
      // Constant-ish work on a missing admin so timing doesn't leak valid usernames.
      if (!row) verifyPassword(DUMMY_HOST_HASH, creds.password);
    }
    return c.json({ error: 'unauthorized' }, 401);
  };
}

// ----- tenant records -------------------------------------------------------

function rowToRecord(r: TenantRecord): TenantRecord {
  return r;
}

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

  db.run(
    `INSERT INTO tenants
       (id, subdomain, display_name, status, plan, created_at, db_path, blobs_dir, expires_at, admin_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  if (!row) return { ok: false, error: 'code expired or not found' };
  if (Date.now() > Date.parse(row.expires_at)) {
    db.run('DELETE FROM pending_signups WHERE id = ?', [row.id]);
    return { ok: false, error: 'code expired or not found' };
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
    return { ok: false, error: 'invalid code' };
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

export { rowToRecord };
