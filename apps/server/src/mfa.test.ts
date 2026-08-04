import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Secret, TOTP } from 'otpauth';
import { Hono } from 'hono';
import {
  getMfaStatus,
  mfaReady,
  setVerifiedEmail,
  createMfaChallenge,
  validateMfaChallenge,
  consumeMfaChallenge,
  trustDevice,
  isTrustedDevice,
  useTrustedDevice,
  revokeAllTrustedDevices,
  DEVICE_SECRET_GRACE_MS,
  DEVICE_TRUST_FAIL_MAX,
  startTotpEnroll,
  confirmTotpEnroll,
  verifyTotpCode,
  issueRecoveryCodes,
  consumeRecoveryCode,
  resetMfa,
  sendMfaEmailCode,
  MfaEmailSendLimitError,
  MFA_EMAIL_SENDS_MAX,
  MFA_EMAIL_SEND_COOLDOWN_MS,
} from './mfa';
import {
  basicAuth,
  requireMfaChallenge,
  requireSession,
  publicUser,
  createSession as mintSession,
  type AuthVars,
} from './auth';
import { getUser } from '@carbon/core';
import { makeTestDb, appFetch } from './test-app';

function currentTotp(secretBase32: string): string {
  const totp = new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.generate();
}

describe('MFA helpers', () => {
  test('email factor makes mfaReady', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('alice', 'pw');
    assert.equal(mfaReady(db, id), false);
    setVerifiedEmail(db, id, 'alice@example.com');
    assert.equal(mfaReady(db, id), true);
    assert.deepEqual(getMfaStatus(db, id).factors, { email: true, totp: false });
  });

  test('sendMfaEmailCode caps sends per challenge', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      const { db, addUser } = makeTestDb();
      const { id } = addUser('mailcap', 'pw');
      const secret = createMfaChallenge(db, id, 'login');
      const ch = validateMfaChallenge(db, secret)!;
      for (let i = 0; i < MFA_EMAIL_SENDS_MAX; i++) {
        await sendMfaEmailCode(db, ch.id, 'mailcap@example.com');
        t.mock.timers.tick(MFA_EMAIL_SEND_COOLDOWN_MS + 1);
      }
      await assert.rejects(
        () => sendMfaEmailCode(db, ch.id, 'mailcap@example.com'),
        (e: unknown) => e instanceof MfaEmailSendLimitError && e.code === 'send_limit',
      );
    } finally {
      t.mock.timers.reset();
    }
  });

  test('sendMfaEmailCode enforces resend cooldown', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      const { db, addUser } = makeTestDb();
      const { id } = addUser('cooldown', 'pw');
      const secret = createMfaChallenge(db, id, 'enroll');
      const ch = validateMfaChallenge(db, secret)!;
      await sendMfaEmailCode(db, ch.id, 'cooldown@example.com');
      await assert.rejects(
        () => sendMfaEmailCode(db, ch.id, 'cooldown@example.com'),
        (e: unknown) => e instanceof MfaEmailSendLimitError && e.code === 'send_cooldown',
      );
    } finally {
      t.mock.timers.reset();
    }
  });

  test('TOTP enroll + confirm', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('bob', 'pw');
    const { secret } = startTotpEnroll(db, id, 'bob');
    assert.equal(mfaReady(db, id), false);
    assert.ok(confirmTotpEnroll(db, id, currentTotp(secret)));
    assert.equal(mfaReady(db, id), true);
    assert.ok(verifyTotpCode(db, id, currentTotp(secret)));
  });

  test('trusted devices have no expiry', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('carol', 'pw');
    const secret = trustDevice(db, id, 'dev-1', 'Phone');
    assert.ok(isTrustedDevice(db, id, 'dev-1'));
    assert.ok(useTrustedDevice(db, id, 'dev-1', secret));
    assert.equal(revokeAllTrustedDevices(db, id), 1);
    assert.ok(!isTrustedDevice(db, id, 'dev-1'));
  });

  test('device id alone proves nothing — a leaked id gets no bypass', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('mallory-target', 'pw');
    trustDevice(db, id, 'dev-1', 'Phone');
    // Everything an attacker can learn from the devices list / a location report.
    assert.equal(useTrustedDevice(db, id, 'dev-1', ''), null);
    assert.equal(useTrustedDevice(db, id, 'dev-1', 'dev-1'), null);
    assert.equal(useTrustedDevice(db, id, 'dev-1', 'carbond_' + 'a'.repeat(64)), null);
  });

  test('legacy trust rows (no secret) never bypass 2FA', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('legacy', 'pw');
    // A row as written before device secrets existed.
    db.run(
      `INSERT INTO trusted_devices (user_id, device_id, name, created_at, last_used_at)
       VALUES (?, 'old-phone', 'Old', ?, ?)`,
      [id, new Date().toISOString(), new Date().toISOString()],
    );
    assert.ok(isTrustedDevice(db, id, 'old-phone'), 'still listed for the owner');
    assert.equal(useTrustedDevice(db, id, 'old-phone', ''), null);
    assert.equal(useTrustedDevice(db, id, 'old-phone', 'carbond_x'), null);
  });

  test('device secret rotates on every use; the spent one dies with the grace window', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      const { db, addUser } = makeTestDb();
      const { id } = addUser('rotator', 'pw');
      const s1 = trustDevice(db, id, 'dev-1');
      const s2 = useTrustedDevice(db, id, 'dev-1', s1);
      assert.ok(s2);
      assert.notEqual(s2, s1);
      // s1 stays valid briefly, so a login whose response never arrived can retry.
      assert.ok(useTrustedDevice(db, id, 'dev-1', s1));
      t.mock.timers.tick(DEVICE_SECRET_GRACE_MS + 1);
      assert.equal(useTrustedDevice(db, id, 'dev-1', s1), null, 'grace expired');
    } finally {
      t.mock.timers.reset();
    }
  });

  test('a full 2FA pass invalidates the old secret', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('re-enroll', 'pw');
    const s1 = trustDevice(db, id, 'dev-1');
    const s2 = trustDevice(db, id, 'dev-1');
    assert.equal(useTrustedDevice(db, id, 'dev-1', s1), null);
    assert.ok(useTrustedDevice(db, id, 'dev-1', s2));
  });

  test('failed secrets are budgeted per account, and a valid one does not reset it', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('sprayed', 'pw');
    const good = trustDevice(db, id, 'dev-1');
    for (let i = 0; i < DEVICE_TRUST_FAIL_MAX - 1; i++) {
      assert.equal(useTrustedDevice(db, id, `guess-${i}`, `carbond_${i}`), null);
    }
    // Still under budget: the real device works...
    const next = useTrustedDevice(db, id, 'dev-1', good);
    assert.ok(next);
    // ...but it didn't refill the budget, so one more miss shuts the fast path.
    assert.equal(useTrustedDevice(db, id, 'guess-last', 'carbond_zz'), null);
    assert.equal(useTrustedDevice(db, id, 'dev-1', next!), null, 'bypass closed for the window');
  });

  test('recovery codes are single-use', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('dave', 'pw');
    const [code] = issueRecoveryCodes(db, id, 'admin');
    assert.ok(consumeRecoveryCode(db, id, code!));
    assert.ok(!consumeRecoveryCode(db, id, code!));
  });

  test('resetMfa clears factors and trusts', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('erin', 'pw');
    setVerifiedEmail(db, id, 'erin@example.com');
    trustDevice(db, id, 'd1');
    issueRecoveryCodes(db, id, 'self');
    resetMfa(db, id);
    assert.equal(mfaReady(db, id), false);
    assert.ok(!isTrustedDevice(db, id, 'd1'));
  });

  test('challenge validates and expires after consume', () => {
    const { db, addUser } = makeTestDb();
    const { id } = addUser('frank', 'pw');
    const secret = createMfaChallenge(db, id, 'login');
    const ch = validateMfaChallenge(db, secret);
    assert.ok(ch);
    assert.equal(ch!.userId, id);
    consumeMfaChallenge(db, ch!.id);
    assert.equal(validateMfaChallenge(db, secret), null);
  });
});

describe('MFA login HTTP flow', () => {
  function buildMfaApp() {
    const ctx = makeTestDb();
    const { db, addUser } = ctx;
    const user = addUser('admin', 'pass', 'admin');

    const app = new Hono<{ Variables: AuthVars }>();
    app.use('*', basicAuth(db, { allowOpen: false, basicPaths: ['/login'] }));

    app.post('/login', async (c) => {
      const method = c.get('authMethod');
      if (method !== 'basic') return c.json({ error: 'password auth required' }, 400);
      const id = c.get('userId');
      const body = (await c.req.json().catch(() => ({}))) as {
        device_id?: string;
        device_token?: string;
      };
      const deviceId = body.device_id?.trim() || '';
      const deviceToken = body.device_token?.trim() || '';
      if (!mfaReady(db, id)) {
        return c.json({
          status: 'needs_enrollment',
          challenge: createMfaChallenge(db, id, 'enroll'),
        });
      }
      if (deviceId && deviceToken) {
        const rotated = useTrustedDevice(db, id, deviceId, deviceToken);
        if (rotated) return c.json({ token: mintSession(db, id), device_token: rotated });
      }
      return c.json({
        status: 'needs_2fa',
        challenge: createMfaChallenge(db, id, 'login'),
        factors: getMfaStatus(db, id).factors,
      });
    });

    app.post('/mfa/enroll/totp/start', requireMfaChallenge, (c) => {
      return c.json(startTotpEnroll(db, c.get('userId'), 'admin'));
    });

    app.post('/mfa/enroll/totp/confirm', requireMfaChallenge, async (c) => {
      const body = (await c.req.json()) as { code: string };
      if (!confirmTotpEnroll(db, c.get('userId'), body.code)) return c.json({ error: 'bad' }, 400);
      return c.json({ ok: true });
    });

    app.post('/mfa/enroll/finish', requireMfaChallenge, async (c) => {
      const id = c.get('userId');
      if (!mfaReady(db, id)) return c.json({ error: 'enroll first' }, 400);
      const body = (await c.req.json()) as { device_id: string };
      consumeMfaChallenge(db, c.get('mfaChallengeId')!);
      const device_token = trustDevice(db, id, body.device_id);
      return c.json({
        token: mintSession(db, id),
        user: publicUser(getUser(db, id)!),
        device_token,
      });
    });

    app.post('/mfa/login/verify', requireMfaChallenge, async (c) => {
      const id = c.get('userId');
      const body = (await c.req.json()) as { device_id: string; totp?: string };
      if (!body.totp || !verifyTotpCode(db, id, body.totp)) return c.json({ error: 'bad' }, 400);
      consumeMfaChallenge(db, c.get('mfaChallengeId')!);
      const device_token = trustDevice(db, id, body.device_id);
      return c.json({ token: mintSession(db, id), device_token });
    });

    app.get('/me', requireSession, (c) => c.json({ username: c.get('username') }));

    return { app, db, user };
  }

  test('Basic on /me is rejected (session required)', async () => {
    const { app, user } = buildMfaApp();
    const res = await appFetch(app, '/me', { headers: { Authorization: user.basic } });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /session required/);
  });

  test('login without MFA returns needs_enrollment; enroll TOTP then session works', async () => {
    const { app, user } = buildMfaApp();
    const loginRes = await appFetch(app, '/login', {
      method: 'POST',
      headers: { Authorization: user.basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'phone-1' }),
    });
    assert.equal(loginRes.status, 200);
    const login = (await loginRes.json()) as { status: string; challenge: string };
    assert.equal(login.status, 'needs_enrollment');

    const startRes = await appFetch(app, '/mfa/enroll/totp/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.challenge}` },
    });
    const { secret } = (await startRes.json()) as { secret: string };

    const confirmRes = await appFetch(app, '/mfa/enroll/totp/confirm', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.challenge}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: currentTotp(secret) }),
    });
    assert.equal(confirmRes.status, 200);

    const finishRes = await appFetch(app, '/mfa/enroll/finish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.challenge}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ device_id: 'phone-1' }),
    });
    assert.equal(finishRes.status, 200);
    const { token, device_token } = (await finishRes.json()) as {
      token: string;
      device_token: string;
    };
    assert.ok(token.startsWith('carbons_'));
    assert.ok(device_token, 'enrollment hands the device its trust secret');

    const me = await appFetch(app, '/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);

    const again = await appFetch(app, '/login', {
      method: 'POST',
      headers: { Authorization: user.basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'phone-1', device_token }),
    });
    const againBody = (await again.json()) as { token?: string; status?: string };
    assert.ok(againBody.token, 'trusted device should get a token immediately');
  });

  test('password + leaked device id, without the secret, still needs 2FA', async () => {
    const { app, db, user } = buildMfaApp();
    const { secret } = startTotpEnroll(db, user.id, 'admin');
    confirmTotpEnroll(db, user.id, currentTotp(secret));
    trustDevice(db, user.id, 'phone-1', 'Phone');

    // The attacker has the password (Basic) and the device id — from the devices
    // list, a log, or a backup — but not the secret that device holds.
    const res = await appFetch(app, '/login', {
      method: 'POST',
      headers: { Authorization: user.basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'phone-1' }),
    });
    const body = (await res.json()) as { token?: string; status?: string };
    assert.equal(body.token, undefined, 'no session without the device secret');
    assert.equal(body.status, 'needs_2fa');

    const guessed = await appFetch(app, '/login', {
      method: 'POST',
      headers: { Authorization: user.basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'phone-1', device_token: 'carbond_deadbeef' }),
    });
    assert.equal(((await guessed.json()) as { status?: string }).status, 'needs_2fa');
  });

  test('new device needs 2FA after enrollment', async () => {
    const { app, db, user } = buildMfaApp();
    setVerifiedEmail(db, user.id, 'a@example.com');
    const { secret } = startTotpEnroll(db, user.id, 'admin');
    confirmTotpEnroll(db, user.id, currentTotp(secret));
    trustDevice(db, user.id, 'old-device');

    const loginRes = await appFetch(app, '/login', {
      method: 'POST',
      headers: { Authorization: user.basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'new-laptop' }),
    });
    const login = (await loginRes.json()) as { status: string; challenge: string };
    assert.equal(login.status, 'needs_2fa');

    const verifyRes = await appFetch(app, '/mfa/login/verify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.challenge}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ device_id: 'new-laptop', totp: currentTotp(secret) }),
    });
    assert.equal(verifyRes.status, 200);
    const { token } = (await verifyRes.json()) as { token: string };
    assert.ok(token.startsWith('carbons_'));
    assert.ok(isTrustedDevice(db, user.id, 'new-laptop'));
  });
});
