import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { makeTestDb } from './test-app';
import {
  ensureFcmTable,
  saveFcmToken,
  removeFcmToken,
  sendFcmToUser,
  isDeadFcmToken,
  resetFcmStateForTests,
} from './fcm';
import { generateKeyPairSync } from 'node:crypto';

describe('ensureFcmTable', () => {
  test('creates the fcm_tokens table', () => {
    const { db } = makeTestDb();
    ensureFcmTable(db);
    // Verify by trying to insert a row (will fail if table doesn't exist)
    db.run("INSERT INTO fcm_tokens (id, user_id, token, created_at) VALUES (?, ?, ?, ?)",
      ['test-id', 'user-1', 'test-token', new Date().toISOString()]);
    const row = db.get("SELECT * FROM fcm_tokens WHERE id = ?", ['test-id']);
    assert.ok(row);
  });
});

describe('saveFcmToken / removeFcmToken', () => {
  test('saves and removes a token', () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'user-1', 'token-abc');
    const row = db.get('SELECT * FROM fcm_tokens WHERE token = ?', ['token-abc']);
    assert.ok(row);
    assert.equal(row.user_id, 'user-1');

    removeFcmToken(db, 'token-abc');
    const gone = db.get('SELECT * FROM fcm_tokens WHERE token = ?', ['token-abc']);
    assert.equal(gone, undefined);
  });

  test('re-saving same token reuses existing id', () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'user-1', 'token-abc');
    const first = db.get('SELECT id FROM fcm_tokens WHERE token = ?', ['token-abc']);
    assert.ok(first);
    saveFcmToken(db, 'user-2', 'token-abc');
    const second = db.get('SELECT id FROM fcm_tokens WHERE token = ?', ['token-abc']);
    assert.ok(second);
    assert.equal(first.id, second.id);
  });

  test('different tokens get different ids', () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'user-1', 'token-abc');
    saveFcmToken(db, 'user-1', 'token-def');
    const rows = db.all('SELECT id FROM fcm_tokens WHERE user_id = ?', ['user-1']);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
  });
});

describe('sendFcmToUser', () => {
  test('returns zero targets when unconfigured', async () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'user-1', 'token-abc');
    // No service account configured
    const result = await sendFcmToUser(db, 'user-1', { title: 'T', body: 'B' });
    assert.equal(result.targets, 0);
    assert.equal(result.delivered, 0);
  });

  test('returns zero targets when user has no tokens', async () => {
    const { db } = makeTestDb();
    const result = await sendFcmToUser(db, 'user-1', { title: 'T', body: 'B' });
    assert.equal(result.targets, 0);
  });
});

// ─── J / D / token cache: FCM against a stubbed fetch ────────────────────────

const fcmErr = (status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ error: { status, message: 'x', ...extra } });

describe('isDeadFcmToken', () => {
  test('classifies FCM v1 error codes', () => {
    assert.equal(isDeadFcmToken(404, fcmErr('NOT_FOUND', { details: [{ errorCode: 'UNREGISTERED' }] })), true);
    assert.equal(isDeadFcmToken(403, fcmErr('PERMISSION_DENIED', { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] })), true);
    assert.equal(
      isDeadFcmToken(400, fcmErr('INVALID_ARGUMENT', { details: [{ fieldViolations: [{ field: 'message.token' }] }] })),
      true,
      'INVALID_ARGUMENT blamed on the token',
    );
    assert.equal(
      isDeadFcmToken(400, fcmErr('INVALID_ARGUMENT', { details: [{ fieldViolations: [{ field: 'message.data' }] }] })),
      false,
      'INVALID_ARGUMENT on another field is our bug, not the token',
    );
    assert.equal(isDeadFcmToken(503, fcmErr('UNAVAILABLE')), false);
    assert.equal(isDeadFcmToken(500, 'not json'), false);
  });
});

function withFcm(
  handler: (url: string, auth: string, token: string) => Response | Promise<Response>,
  oauthTokens: string[],
) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const realFetch = globalThis.fetch;
  const prevEnv = process.env.FCM_SERVICE_ACCOUNT_JSON;
  process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
    project_id: 'p',
    client_email: 'sa@p.iam',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  resetFcmStateForTests();
  const calls = { oauth: 0 };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/')) {
      const value = oauthTokens[Math.min(calls.oauth++, oauthTokens.length - 1)];
      return Response.json({ access_token: value, expires_in: 3600 });
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const token = JSON.parse(String(init?.body)).message.token as string;
    return handler(u, auth, token);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      if (prevEnv === undefined) delete process.env.FCM_SERVICE_ACCOUNT_JSON;
      else process.env.FCM_SERVICE_ACCOUNT_JSON = prevEnv;
      resetFcmStateForTests();
    },
  };
}

describe('sendFcmToUser with a configured service account', () => {
  test('drops UNREGISTERED / SENDER_ID_MISMATCH / token INVALID_ARGUMENT tokens, keeps others', async () => {
    const { db } = makeTestDb();
    for (const t of ['ok', 'unreg', 'mismatch', 'badtoken', 'otherbad', 'flaky']) saveFcmToken(db, 'u', t);
    const realError = console.error;
    console.error = () => {};
    const env = withFcm((_u, _a, token) => {
      switch (token) {
        case 'ok': return Response.json({ name: 'm' });
        case 'unreg': return new Response(fcmErr('NOT_FOUND', { details: [{ errorCode: 'UNREGISTERED' }] }), { status: 404 });
        case 'mismatch': return new Response(fcmErr('PERMISSION_DENIED', { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] }), { status: 403 });
        case 'badtoken': return new Response(fcmErr('INVALID_ARGUMENT', { details: [{ fieldViolations: [{ field: 'message.token' }] }] }), { status: 400 });
        case 'otherbad': return new Response(fcmErr('INVALID_ARGUMENT', { details: [{ fieldViolations: [{ field: 'message.data' }] }] }), { status: 400 });
        default: return new Response(fcmErr('UNAVAILABLE'), { status: 503 });
      }
    }, ['tok']);
    try {
      const r = await sendFcmToUser(db, 'u', { title: 'T', body: 'B' });
      assert.deepEqual(r, { targets: 3, delivered: 1 });
    } finally {
      env.restore();
      console.error = realError;
    }
    const left = db.all<{ token: string }>('SELECT token FROM fcm_tokens ORDER BY token').map((r) => r.token);
    assert.deepEqual(left, ['flaky', 'ok', 'otherbad']);
  });

  test('a 401 clears the cached OAuth token and retries once with a fresh one', async () => {
    const { db } = makeTestDb();
    saveFcmToken(db, 'u', 'dev');
    const seen: string[] = [];
    const env = withFcm((_u, auth) => {
      seen.push(auth);
      return auth === 'Bearer fresh' ? Response.json({ name: 'm' }) : new Response('{}', { status: 401 });
    }, ['stale', 'fresh']);
    try {
      const r = await sendFcmToUser(db, 'u', { title: 'T', body: 'B' });
      assert.deepEqual(r, { targets: 1, delivered: 1 });
      assert.deepEqual(seen, ['Bearer stale', 'Bearer fresh']);
      assert.equal(env.calls.oauth, 2);
      // The fresh token is now cached: the next send mints nothing new.
      await sendFcmToUser(db, 'u', { title: 'T', body: 'B' });
      assert.equal(env.calls.oauth, 2);
    } finally {
      env.restore();
    }
  });

  test('sends to a user\'s tokens in parallel', async () => {
    const { db } = makeTestDb();
    for (const t of ['a', 'b', 'c', 'd']) saveFcmToken(db, 'u', t);
    let inFlight = 0;
    let peak = 0;
    const env = withFcm(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return Response.json({ name: 'm' });
    }, ['tok']);
    try {
      const r = await sendFcmToUser(db, 'u', { title: 'T', body: 'B' });
      assert.deepEqual(r, { targets: 4, delivered: 4 });
    } finally {
      env.restore();
    }
    assert.ok(peak > 1, `expected overlapping sends, peak was ${peak}`);
  });

  test('fcm_tokens has a (user_id, token) index', () => {
    const { db } = makeTestDb();
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT token FROM fcm_tokens WHERE user_id = ?", ['u']);
    assert.ok(plan.some((p) => p.detail.includes('idx_fcm_tokens_user')), JSON.stringify(plan));
  });
});
