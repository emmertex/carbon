import { Semaphore } from "./concurrency";
const fcmSem = new Semaphore(16, 128);
// Firebase Cloud Messaging (HTTP v1) sender for the Capacitor/Android shell.
//
// Self-contained: mints an OAuth access token from a service-account JSON using
// node:crypto (RS256 JWT) — no firebase-admin dependency. Inert until a service
// account is supplied, so web-only deployments are unaffected:
//
//   FCM_SERVICE_ACCOUNT_JSON  — the service-account JSON inline, or
//   FCM_SERVICE_ACCOUNT_FILE  — a path to it.
//
// Device tokens live in their own table (separate from Web Push subscriptions so
// the existing NOT NULL p256dh/auth constraints stay intact).

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Db } from "@carbon/core";
import type { PushPayload } from "./push";
import { safeFetch } from "./safe-fetch";

// ----- token store ----------------------------------------------------------

export function ensureFcmTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user ON fcm_tokens(user_id, token);
  `);
}

export function saveFcmToken(db: Db, userId: string, token: string): void {
  // Look up first: on a re-registration (same token, e.g. a re-installed app or a refreshed
  // token that happens to collide) reuse the existing id/created_at rather than generating a
  // fresh id that ON CONFLICT then silently discards, leaving the row's id inconsistent with
  // what was actually inserted.
  const existing = db.get<{ id: string }>(
    "SELECT id FROM fcm_tokens WHERE token = ?",
    [token],
  );
  db.run(
    `INSERT INTO fcm_tokens (id, user_id, token, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id`,
    [
      existing?.id ?? crypto.randomUUID(),
      userId,
      token,
      new Date().toISOString(),
    ],
  );
}

export function removeFcmToken(db: Db, token: string): void {
  db.run("DELETE FROM fcm_tokens WHERE token = ?", [token]);
}

function tokensForUser(db: Db, userId: string): string[] {
  return db
    .all<{ token: string }>("SELECT token FROM fcm_tokens WHERE user_id = ?", [
      userId,
    ])
    .map((r) => r.token);
}

// ----- service account + OAuth ----------------------------------------------

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let serviceAccount: ServiceAccount | null | undefined; // undefined = not yet resolved

function loadServiceAccount(): ServiceAccount | null {
  if (serviceAccount !== undefined) return serviceAccount;
  const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
  const file = process.env.FCM_SERVICE_ACCOUNT_FILE;
  try {
    const raw = inline ?? (file ? readFileSync(file, "utf8") : null);
    serviceAccount = raw ? (JSON.parse(raw) as ServiceAccount) : null;
  } catch (e) {
    console.error("[carbon] failed to load FCM service account:", e);
    serviceAccount = null;
  }
  if (serviceAccount === null) {
    console.warn(
      "[carbon] FCM disabled: set FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE to push to native apps",
    );
  }
  return serviceAccount;
}

const b64url = (b: Buffer | string): string =>
  Buffer.from(b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(sa: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = b64url(
    createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key),
  );
  const assertion = `${header}.${claims}.${signature}`;

  // A2: route through safeFetch (the fixed public URL is SSRF-safe, but this still gets
  // the response-size cap + socket timeout + redirect policy).
  const res = await safeFetch("https://oauth2.googleapis.com/token", false, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    console.error(
      "[carbon] FCM token exchange failed:",
      res.status,
      await res.text(),
    );
    return null;
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = { value: json.access_token, expiresAt: now + json.expires_in };
  return json.access_token;
}

// ----- send -----------------------------------------------------------------

/** Test hook: drop the cached OAuth token and re-read the service account. */
export function resetFcmStateForTests(): void {
  cachedToken = null;
  serviceAccount = undefined;
}

/** J: FCM v1 error codes meaning the token itself is dead or not ours — drop it. */
const DEAD_TOKEN_CODES = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{
      "@type"?: string;
      errorCode?: string;
      fieldViolations?: Array<{ field?: string; description?: string }>;
    }>;
  };
}

/** Classify an FCM v1 error response: true when the registration token should be
 *  removed (UNREGISTERED, SENDER_ID_MISMATCH, or INVALID_ARGUMENT blamed on the token
 *  — not on some other part of the message, which would be our bug, not the token's). */
export function isDeadFcmToken(status: number, bodyText: string): boolean {
  if (status === 404 || status === 410) return true;
  let body: FcmErrorBody;
  try {
    body = JSON.parse(bodyText) as FcmErrorBody;
  } catch {
    return false;
  }
  const err = body.error;
  if (!err) return false;
  const codes = new Set<string>();
  if (err.status) codes.add(err.status);
  for (const d of err.details ?? []) if (d.errorCode) codes.add(d.errorCode);
  for (const c of codes) if (DEAD_TOKEN_CODES.has(c)) return true;
  if (codes.has("INVALID_ARGUMENT")) {
    const fields = (err.details ?? []).flatMap((d) =>
      (d.fieldViolations ?? []).map((v) => v.field ?? ""),
    );
    if (fields.some((f) => /(^|\.)token$/.test(f))) return true;
    if (fields.length === 0 && /registration token/i.test(err.message ?? ""))
      return true;
  }
  return false;
}

/** Deliver a payload to every FCM token registered to a user. No-op if unconfigured.
 *  Returns delivery counts (see DeliveryResult in push.ts): unconfigured or tokenless
 *  users contribute zero targets; dead tokens removed mid-send don't count either. */
export async function sendFcmToUser(
  db: Db,
  userId: string,
  payload: PushPayload,
): Promise<{ targets: number; delivered: number }> {
  const result = { targets: 0, delivered: 0 };
  const sa = loadServiceAccount();
  if (!sa) return result;
  // L: one indexed read (idx_fcm_tokens_user) for the targets instead of a COUNT(*)
  // plus a per-token keyset walk.
  const tokens = tokensForUser(db, userId);
  result.targets = tokens.length;
  if (!result.targets) return result;
  let accessToken: string | null;
  try {
    accessToken = await fcmSem.run(() => getAccessToken(sa));
  } catch {
    return result;
  }
  if (!accessToken) return result;

  const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  const post = (token: string, bearer: string) =>
    // A2: safeFetch — bounded response + timeout; the FCM Bearer token is stripped if
    // (and only if) a redirect ever left the Google origin.
    safeFetch(endpoint, false, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: payload.title, body: payload.body },
          data: {
            ...(payload.url ? { url: payload.url } : {}),
            ...(payload.tag ? { tag: payload.tag } : {}),
          },
        },
      }),
    });

  const sendOne = (token: string) =>
    fcmSem.run(async () => {
      let res = await post(token, accessToken!);
      if (res.status === 401) {
        // Cached OAuth token revoked/expired early: drop it, mint a fresh one, retry once.
        await res.body?.cancel();
        if (cachedToken?.value === accessToken) cachedToken = null;
        const fresh = await getAccessToken(sa);
        if (!fresh) {
          console.error("[carbon] FCM send failed: 401 and token refresh failed");
          return;
        }
        accessToken = fresh;
        res = await post(token, fresh);
      }
      if (res.ok) {
        result.delivered++;
        await res.body?.cancel();
        return;
      }
      const text = await res.text();
      if (isDeadFcmToken(res.status, text)) {
        removeFcmToken(db, token); // token gone / not ours — drop it
        result.targets--;
      } else {
        console.error("[carbon] FCM send failed:", res.status, text);
      }
    });

  // D: all tokens in parallel, bounded by fcmSem.
  const settled = await Promise.allSettled(tokens.map(sendOne));
  for (const r of settled)
    if (r.status === "rejected") console.error("[carbon] FCM send error:", r.reason);
  return result;
}
