// Multi-factor auth for sync-server human accounts: email OTC and/or TOTP,
// infinite trusted devices, one-use recovery codes, and short-lived login/enroll
// challenges. Server-only tables (not part of the synced core schema).
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import type { Db } from '@carbon/core';
import { sendEmail } from './email';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const MFA_CHALLENGE_TTL_MS = 10 * 60_000;
const MFA_OTC_TTL_MS = 15 * 60_000;
const MFA_MAX_ATTEMPTS = 5;
/** Max OTC emails per challenge (enroll / login / settings). */
export const MFA_EMAIL_SENDS_MAX = Math.max(1, Number(process.env.MFA_EMAIL_SENDS_MAX) || 3);
/** Minimum gap between resends for the same challenge. */
export const MFA_EMAIL_SEND_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.MFA_EMAIL_SEND_COOLDOWN_MS) || 30_000,
);
const RECOVERY_CODE_COUNT = 10;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Thrown by sendMfaEmailCode when the per-challenge / cooldown budget is exhausted. */
export class MfaEmailSendLimitError extends Error {
  constructor(readonly code: 'send_limit' | 'send_cooldown') {
    super(code);
    this.name = 'MfaEmailSendLimitError';
  }
}

export type MfaChallengePurpose = 'enroll' | 'login';
export type RecoveryCreatedBy = 'self' | 'admin' | 'console';

export interface MfaFactors {
  email: boolean;
  totp: boolean;
}

export interface TrustedDevice {
  device_id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface MfaStatus {
  email: string | null;
  email_verified: boolean;
  totp: boolean;
  ready: boolean;
  factors: MfaFactors;
}

/** Ensure MFA columns/tables exist (idempotent; called from ensureServerTables). */
export function ensureMfaTables(db: Db): void {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(user_auth)`).map((c) => c.name);
  const add = (name: string, decl: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE user_auth ADD COLUMN ${name} ${decl}`);
  };
  add('email', 'TEXT');
  add('email_verified_at', 'TEXT');
  add('totp_secret', 'TEXT');
  add('totp_confirmed_at', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS trusted_devices (
      user_id      TEXT NOT NULL,
      device_id    TEXT NOT NULL,
      name         TEXT,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      PRIMARY KEY (user_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);

    CREATE TABLE IF NOT EXISTS mfa_challenges (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      purpose    TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_challenges_hash ON mfa_challenges(token_hash);
  `);

  // Per-challenge email OTC send budget (added after initial schema).
  const chCols = db.all<{ name: string }>(`PRAGMA table_info(mfa_challenges)`).map((c) => c.name);
  if (!chCols.includes('email_sends')) {
    db.exec(`ALTER TABLE mfa_challenges ADD COLUMN email_sends INTEGER NOT NULL DEFAULT 0`);
  }
  if (!chCols.includes('last_email_sent_at')) {
    db.exec(`ALTER TABLE mfa_challenges ADD COLUMN last_email_sent_at TEXT`);
  }

  db.exec(`

    CREATE TABLE IF NOT EXISTS mfa_email_codes (
      id           TEXT PRIMARY KEY,
      challenge_id TEXT NOT NULL,
      code_hash    TEXT NOT NULL,
      email        TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_email_codes_challenge ON mfa_email_codes(challenge_id);

    CREATE TABLE IF NOT EXISTS recovery_codes (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      code_hash  TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);
  `);
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function recoveryPlaintext(): string {
  // Crockford-ish: 4 groups of 4 hex chars — easy to read aloud / type.
  const hex = randomBytes(8).toString('hex');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(normalizeEmail(email));
}

interface AuthMfaRow {
  email: string | null;
  email_verified_at: string | null;
  totp_secret: string | null;
  totp_confirmed_at: string | null;
}

function getAuthMfa(db: Db, userId: string): AuthMfaRow | null {
  return (
    db.get<AuthMfaRow>(
      `SELECT email, email_verified_at, totp_secret, totp_confirmed_at FROM user_auth WHERE user_id = ?`,
      [userId],
    ) ?? null
  );
}

export function getMfaStatus(db: Db, userId: string): MfaStatus {
  const row = getAuthMfa(db, userId);
  const emailVerified = !!row?.email_verified_at && !!row.email;
  const totp = !!row?.totp_confirmed_at && !!row.totp_secret;
  return {
    email: emailVerified ? row!.email : row?.email ?? null,
    email_verified: emailVerified,
    totp,
    ready: emailVerified || totp,
    factors: { email: emailVerified, totp },
  };
}

export function mfaReady(db: Db, userId: string): boolean {
  return getMfaStatus(db, userId).ready;
}

/** Set email without verifying (admin create / optional pre-fill). */
export function setUserEmail(db: Db, userId: string, email: string | null): void {
  ensureAuthRow(db, userId);
  if (email == null || email === '') {
    db.run(
      `UPDATE user_auth SET email = NULL, email_verified_at = NULL WHERE user_id = ?`,
      [userId],
    );
    return;
  }
  const e = normalizeEmail(email);
  if (!isValidEmail(e)) throw new Error('invalid email');
  db.run(`UPDATE user_auth SET email = ?, email_verified_at = NULL WHERE user_id = ?`, [
    e,
    userId,
  ]);
}

/** Mark an email as verified (signup handoff or OTC confirm). */
export function setVerifiedEmail(db: Db, userId: string, email: string): void {
  ensureAuthRow(db, userId);
  const e = normalizeEmail(email);
  if (!isValidEmail(e)) throw new Error('invalid email');
  const now = new Date().toISOString();
  db.run(`UPDATE user_auth SET email = ?, email_verified_at = ? WHERE user_id = ?`, [
    e,
    now,
    userId,
  ]);
}

function ensureAuthRow(db: Db, userId: string): void {
  db.run(
    `INSERT INTO user_auth (user_id, password_hash) VALUES (?, '')
     ON CONFLICT(user_id) DO NOTHING`,
    [userId],
  );
}

// ----- trusted devices ------------------------------------------------------

export function isTrustedDevice(db: Db, userId: string, deviceId: string): boolean {
  if (!deviceId) return false;
  const row = db.get<{ device_id: string }>(
    `SELECT device_id FROM trusted_devices WHERE user_id = ? AND device_id = ?`,
    [userId, deviceId],
  );
  return !!row;
}

export function trustDevice(
  db: Db,
  userId: string,
  deviceId: string,
  name?: string | null,
): void {
  if (!deviceId) throw new Error('device_id required');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO trusted_devices (user_id, device_id, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       name = COALESCE(excluded.name, trusted_devices.name),
       last_used_at = excluded.last_used_at`,
    [userId, deviceId, name?.trim() || null, now, now],
  );
}

export function touchTrustedDevice(db: Db, userId: string, deviceId: string): void {
  if (!deviceId) return;
  db.run(
    `UPDATE trusted_devices SET last_used_at = ? WHERE user_id = ? AND device_id = ?`,
    [new Date().toISOString(), userId, deviceId],
  );
}

export function listTrustedDevices(db: Db, userId: string): TrustedDevice[] {
  return db.all<TrustedDevice>(
    `SELECT device_id, name, created_at, last_used_at FROM trusted_devices
     WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC`,
    [userId],
  );
}

export function revokeTrustedDevice(db: Db, userId: string, deviceId: string): boolean {
  const before = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM trusted_devices WHERE user_id = ? AND device_id = ?`,
    [userId, deviceId],
  )?.n;
  db.run(`DELETE FROM trusted_devices WHERE user_id = ? AND device_id = ?`, [userId, deviceId]);
  return (before ?? 0) > 0;
}

export function revokeAllTrustedDevices(db: Db, userId: string): number {
  const n =
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM trusted_devices WHERE user_id = ?`, [
      userId,
    ])?.n ?? 0;
  db.run(`DELETE FROM trusted_devices WHERE user_id = ?`, [userId]);
  return n;
}

// ----- challenges -----------------------------------------------------------

export function createMfaChallenge(
  db: Db,
  userId: string,
  purpose: MfaChallengePurpose,
): string {
  gcMfaChallenges(db);
  const id = randomUUID();
  const secret = `mfac_${randomBytes(24).toString('hex')}`;
  const now = Date.now();
  db.run(
    `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      userId,
      sha256Hex(secret),
      purpose,
      new Date(now + MFA_CHALLENGE_TTL_MS).toISOString(),
      new Date(now).toISOString(),
    ],
  );
  return secret;
}

export interface ValidChallenge {
  id: string;
  userId: string;
  purpose: MfaChallengePurpose;
}

export function validateMfaChallenge(db: Db, secret: string): ValidChallenge | null {
  if (!secret?.startsWith('mfac_')) return null;
  const row = db.get<{
    id: string;
    user_id: string;
    purpose: string;
    expires_at: string;
    attempts: number;
  }>(
    `SELECT id, user_id, purpose, expires_at, attempts FROM mfa_challenges WHERE token_hash = ?`,
    [sha256Hex(secret)],
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    db.run(`DELETE FROM mfa_challenges WHERE id = ?`, [row.id]);
    return null;
  }
  if (row.attempts >= MFA_MAX_ATTEMPTS) {
    db.run(`DELETE FROM mfa_challenges WHERE id = ?`, [row.id]);
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose as MfaChallengePurpose,
  };
}

export function bumpChallengeAttempts(db: Db, challengeId: string): void {
  db.run(`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ?`, [challengeId]);
  const row = db.get<{ attempts: number }>(
    `SELECT attempts FROM mfa_challenges WHERE id = ?`,
    [challengeId],
  );
  if (row && row.attempts >= MFA_MAX_ATTEMPTS) {
    db.run(`DELETE FROM mfa_challenges WHERE id = ?`, [challengeId]);
    db.run(`DELETE FROM mfa_email_codes WHERE challenge_id = ?`, [challengeId]);
  }
}

export function consumeMfaChallenge(db: Db, challengeId: string): void {
  db.run(`DELETE FROM mfa_email_codes WHERE challenge_id = ?`, [challengeId]);
  db.run(`DELETE FROM mfa_challenges WHERE id = ?`, [challengeId]);
}

function gcMfaChallenges(db: Db): void {
  const now = new Date().toISOString();
  db.run(`DELETE FROM mfa_email_codes WHERE expires_at < ?`, [now]);
  db.run(`DELETE FROM mfa_challenges WHERE expires_at < ?`, [now]);
}

// ----- email OTC ------------------------------------------------------------

export async function sendMfaEmailCode(
  db: Db,
  challengeId: string,
  email: string,
): Promise<void> {
  const e = normalizeEmail(email);
  if (!isValidEmail(e)) throw new Error('invalid email');
  const ch = db.get<{ email_sends: number; last_email_sent_at: string | null }>(
    `SELECT email_sends, last_email_sent_at FROM mfa_challenges WHERE id = ?`,
    [challengeId],
  );
  if (!ch) throw new Error('invalid challenge');
  if (ch.email_sends >= MFA_EMAIL_SENDS_MAX) {
    throw new MfaEmailSendLimitError('send_limit');
  }
  if (
    ch.last_email_sent_at &&
    MFA_EMAIL_SEND_COOLDOWN_MS > 0 &&
    Date.now() - Date.parse(ch.last_email_sent_at) < MFA_EMAIL_SEND_COOLDOWN_MS
  ) {
    throw new MfaEmailSendLimitError('send_cooldown');
  }
  db.run(`DELETE FROM mfa_email_codes WHERE challenge_id = ?`, [challengeId]);
  const code = sixDigitCode();
  const id = randomUUID();
  const now = Date.now();
  const sentAt = new Date(now).toISOString();
  db.run(
    `INSERT INTO mfa_email_codes (id, challenge_id, code_hash, email, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      challengeId,
      sha256Hex(code),
      e,
      new Date(now + MFA_OTC_TTL_MS).toISOString(),
      sentAt,
    ],
  );
  const subject = `Your Carbon sign-in code`;
  const text =
    `Your Carbon verification code is:\n\n  ${code}\n\n` +
    `Enter it to finish signing in. It expires shortly. ` +
    `If you didn't request this, you can ignore this email.`;
  await sendEmail(e, subject, text);
  db.run(
    `UPDATE mfa_challenges SET email_sends = email_sends + 1, last_email_sent_at = ? WHERE id = ?`,
    [sentAt, challengeId],
  );
}

export function verifyMfaEmailCode(
  db: Db,
  challengeId: string,
  code: string,
): { ok: true; email: string } | { ok: false; error: string } {
  const row = db.get<{
    id: string;
    code_hash: string;
    email: string;
    expires_at: string;
    attempts: number;
  }>(
    `SELECT id, code_hash, email, expires_at, attempts FROM mfa_email_codes
     WHERE challenge_id = ? ORDER BY created_at DESC LIMIT 1`,
    [challengeId],
  );
  if (!row) return { ok: false, error: 'no_code' };
  if (Date.parse(row.expires_at) < Date.now()) {
    db.run(`DELETE FROM mfa_email_codes WHERE id = ?`, [row.id]);
    return { ok: false, error: 'expired' };
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(sha256Hex(String(code).trim()), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const attempts = row.attempts + 1;
    if (attempts >= MFA_MAX_ATTEMPTS) {
      db.run(`DELETE FROM mfa_email_codes WHERE id = ?`, [row.id]);
    } else {
      db.run(`UPDATE mfa_email_codes SET attempts = ? WHERE id = ?`, [attempts, row.id]);
    }
    return { ok: false, error: 'bad_code' };
  }
  db.run(`DELETE FROM mfa_email_codes WHERE id = ?`, [row.id]);
  return { ok: true, email: row.email };
}

// ----- TOTP -----------------------------------------------------------------

export function startTotpEnroll(
  db: Db,
  userId: string,
  accountLabel: string,
): { secret: string; uri: string } {
  ensureAuthRow(db, userId);
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: 'Carbon',
    label: accountLabel,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  db.run(
    `UPDATE user_auth SET totp_secret = ?, totp_confirmed_at = NULL WHERE user_id = ?`,
    [secret.base32, userId],
  );
  return { secret: secret.base32, uri: totp.toString() };
}

export function verifyTotpCode(db: Db, userId: string, code: string): boolean {
  const row = getAuthMfa(db, userId);
  if (!row?.totp_secret) return false;
  const totp = new TOTP({
    issuer: 'Carbon',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(row.totp_secret),
  });
  const delta = totp.validate({ token: String(code).trim(), window: 1 });
  return delta !== null;
}

export function confirmTotpEnroll(db: Db, userId: string, code: string): boolean {
  if (!verifyTotpCode(db, userId, code)) return false;
  db.run(`UPDATE user_auth SET totp_confirmed_at = ? WHERE user_id = ?`, [
    new Date().toISOString(),
    userId,
  ]);
  return true;
}

export function clearTotp(db: Db, userId: string): void {
  db.run(`UPDATE user_auth SET totp_secret = NULL, totp_confirmed_at = NULL WHERE user_id = ?`, [
    userId,
  ]);
}

// ----- recovery codes -------------------------------------------------------

export function issueRecoveryCodes(
  db: Db,
  userId: string,
  createdBy: RecoveryCreatedBy,
  count = RECOVERY_CODE_COUNT,
): string[] {
  // Replace unused self-codes when regenerating a full set; admin/console one-offs append.
  if (createdBy === 'self') {
    db.run(`DELETE FROM recovery_codes WHERE user_id = ? AND used_at IS NULL AND created_by = 'self'`, [
      userId,
    ]);
  }
  const codes: string[] = [];
  const now = new Date().toISOString();
  const n = createdBy === 'self' ? count : 1;
  for (let i = 0; i < n; i++) {
    const plain = recoveryPlaintext();
    codes.push(plain);
    db.run(
      `INSERT INTO recovery_codes (id, user_id, code_hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), userId, sha256Hex(normalizeRecovery(plain)), createdBy, now],
    );
  }
  return codes;
}

function normalizeRecovery(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-f0-9]/g, '');
}

export function consumeRecoveryCode(db: Db, userId: string, code: string): boolean {
  const norm = normalizeRecovery(code);
  if (!norm) return false;
  const rows = db.all<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`,
    [userId],
  );
  for (const row of rows) {
    if (safeEqualHex(row.code_hash, sha256Hex(norm))) {
      db.run(`UPDATE recovery_codes SET used_at = ? WHERE id = ?`, [
        new Date().toISOString(),
        row.id,
      ]);
      return true;
    }
  }
  return false;
}

export function countUnusedRecoveryCodes(db: Db, userId: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`,
      [userId],
    )?.n ?? 0
  );
}

/** Wipe MFA factors, unused recovery codes, and device trusts (forces re-enroll). */
export function resetMfa(db: Db, userId: string): void {
  db.run(
    `UPDATE user_auth SET email = NULL, email_verified_at = NULL,
       totp_secret = NULL, totp_confirmed_at = NULL WHERE user_id = ?`,
    [userId],
  );
  db.run(`DELETE FROM recovery_codes WHERE user_id = ?`, [userId]);
  revokeAllTrustedDevices(db, userId);
  // Drop outstanding challenges for this user.
  const challenges = db.all<{ id: string }>(`SELECT id FROM mfa_challenges WHERE user_id = ?`, [
    userId,
  ]);
  for (const ch of challenges) {
    db.run(`DELETE FROM mfa_email_codes WHERE challenge_id = ?`, [ch.id]);
  }
  db.run(`DELETE FROM mfa_challenges WHERE user_id = ?`, [userId]);
}

/** Hash helper exported for tests that need to inspect challenge tokens. */
export function hashToken(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
