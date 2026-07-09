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

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Db } from '@carbon/core';
import type { PushPayload } from './push';

// ----- token store ----------------------------------------------------------

export function ensureFcmTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
}

export function saveFcmToken(db: Db, userId: string, token: string): void {
  // Look up first: on a re-registration (same token, e.g. a re-installed app or a refreshed
  // token that happens to collide) reuse the existing id/created_at rather than generating a
  // fresh id that ON CONFLICT then silently discards, leaving the row's id inconsistent with
  // what was actually inserted.
  const existing = db.get<{ id: string }>('SELECT id FROM fcm_tokens WHERE token = ?', [token]);
  db.run(
    `INSERT INTO fcm_tokens (id, user_id, token, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id`,
    [existing?.id ?? crypto.randomUUID(), userId, token, new Date().toISOString()],
  );
}

export function removeFcmToken(db: Db, token: string): void {
  db.run('DELETE FROM fcm_tokens WHERE token = ?', [token]);
}

function tokensForUser(db: Db, userId: string): string[] {
  return db
    .all<{ token: string }>('SELECT token FROM fcm_tokens WHERE user_id = ?', [userId])
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
    const raw = inline ?? (file ? readFileSync(file, 'utf8') : null);
    serviceAccount = raw ? (JSON.parse(raw) as ServiceAccount) : null;
  } catch (e) {
    console.error('[carbon] failed to load FCM service account:', e);
    serviceAccount = null;
  }
  if (serviceAccount === null) {
    console.warn(
      '[carbon] FCM disabled: set FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE to push to native apps',
    );
  }
  return serviceAccount;
}

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(sa: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = b64url(
    createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key),
  );
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    console.error('[carbon] FCM token exchange failed:', res.status, await res.text());
    return null;
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: now + json.expires_in };
  return json.access_token;
}

// ----- send -----------------------------------------------------------------

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
  const tokens = tokensForUser(db, userId);
  if (tokens.length === 0) return result;
  result.targets = tokens.length;
  const accessToken = await getAccessToken(sa);
  if (!accessToken) return result;

  const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  await Promise.all(
    tokens.map(async (token) => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
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
        if (res.ok) {
          result.delivered++;
        } else if (res.status === 404 || res.status === 410) {
          removeFcmToken(db, token); // token gone — drop it
          result.targets--;
        } else {
          console.error('[carbon] FCM send failed:', res.status, await res.text());
        }
      } catch (e) {
        console.error('[carbon] FCM send error:', e);
      }
    }),
  );
  return result;
}
