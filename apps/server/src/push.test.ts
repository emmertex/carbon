import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Hono } from 'hono';
import webpush from 'web-push';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';
import { saveSubscription, removeSubscription, checkReminders, notifyTask } from './push';
import { saveFcmToken, removeFcmToken } from './fcm';
import { createItem, updateItem, createTag, updateTag, setItemTags, tagId, shareItem } from '@carbon/core';
import type { AuthVars } from './auth';

function buildPushApp(db: TestDb, vapidPublicKey: string) {
  const app = makeHono(db, false); // require real auth

  app.get('/push/vapid', (c) => c.text(vapidPublicKey));

  app.post('/push/subscribe', async (c) => {
    const sub = (await c.req.json().catch(() => null)) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    } | null;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return c.json({ error: 'invalid subscription' }, 400);
    }
    saveSubscription(db, c.get('userId'), {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return c.json({ ok: true }, 201);
  });

  app.post('/push/unsubscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
    if (body.endpoint) removeSubscription(db, body.endpoint);
    return c.json({ ok: true });
  });

  app.post('/push/fcm', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!body.token) return c.json({ error: 'missing token' }, 400);
    saveFcmToken(db, c.get('userId'), body.token);
    return c.json({ ok: true });
  });

  app.post('/push/fcm/unsubscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (body.token) removeFcmToken(db, body.token);
    return c.json({ ok: true });
  });

  return app;
}

// ─── VAPID ──────────────────────────────────────────────────────────────────

describe('GET /push/vapid', () => {
  test('returns the VAPID public key as plain text', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { basic } = addUser('u', 'pw');
    const app = buildPushApp(db, vapidPublicKey);
    const res = await appFetch(app, '/push/vapid', { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, vapidPublicKey);
    assert.ok(text.length > 10, 'VAPID public key should be non-trivial');
  });

  test('requires authentication', async () => {
    const { db, vapidPublicKey } = makeTestDb();
    const app = buildPushApp(db, vapidPublicKey);
    const res = await appFetch(app, '/push/vapid');
    assert.equal(res.status, 401);
  });
});

// ─── Web Push subscribe / unsubscribe ────────────────────────────────────────

describe('POST /push/subscribe', () => {
  test('saves a valid subscription', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('u', 'pw');
    const app = buildPushApp(db, vapidPublicKey);
    const sub = {
      endpoint: 'https://push.example.com/sub123',
      keys: { p256dh: 'AAAA', auth: 'BBBB' },
    };
    const res = await appFetch(app, '/push/subscribe', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    assert.equal(res.status, 201);
    const row = db.get<{ user_id: string; endpoint: string }>(
      'SELECT user_id, endpoint FROM push_subscriptions WHERE endpoint = ?',
      [sub.endpoint],
    );
    assert.ok(row, 'subscription persisted');
    assert.equal(row!.user_id, userId);
  });

  test('returns 400 when subscription is missing keys', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { basic } = addUser('u', 'pw');
    const app = buildPushApp(db, vapidPublicKey);
    const res = await appFetch(app, '/push/subscribe', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example.com/x' }),
    });
    assert.equal(res.status, 400);
  });

  test('re-subscribing the same endpoint is idempotent', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { basic } = addUser('u', 'pw');
    const app = buildPushApp(db, vapidPublicKey);
    const sub = {
      endpoint: 'https://push.example.com/same',
      keys: { p256dh: 'X', auth: 'Y' },
    };
    await appFetch(app, '/push/subscribe', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    const res2 = await appFetch(app, '/push/subscribe', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    assert.equal(res2.status, 201);
    const count = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?',
      [sub.endpoint],
    )?.n;
    assert.equal(count, 1, 'no duplicate rows');
  });
});

describe('POST /push/unsubscribe', () => {
  test('removes an existing subscription', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { basic } = addUser('u', 'pw', 'admin');
    const app = buildPushApp(db, vapidPublicKey);
    const endpoint = 'https://push.example.com/todelete';

    // Subscribe first
    await appFetch(app, '/push/subscribe', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, keys: { p256dh: 'A', auth: 'B' } }),
    });
    assert.ok(db.get('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', [endpoint]));

    // Unsubscribe
    const res = await appFetch(app, '/push/unsubscribe', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    assert.equal(res.status, 200);
    assert.ok(!db.get('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', [endpoint]));
  });

  test('unsubscribing a nonexistent endpoint does not error', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { basic } = addUser('u', 'pw');
    const app = buildPushApp(db, vapidPublicKey);
    const res = await appFetch(app, '/push/unsubscribe', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://gone.example.com/x' }),
    });
    assert.equal(res.status, 200);
  });
});

// ─── Reminder scanner: on-hold suppression ───────────────────────────────────

describe('checkReminders', () => {
  test('skips due tasks that carry an on-hold tag', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId } = addUser('u', 'pw');
    const past = new Date(Date.now() - 60_000).toISOString();

    const free = createItem(db, deviceId, { title: 'free', ownerId: userId });
    updateItem(db, deviceId, free.id, { due_date: past });
    const held = createItem(db, deviceId, { title: 'held', ownerId: userId });
    updateItem(db, deviceId, held.id, { due_date: past });
    createTag(db, deviceId, 'Waiting');
    updateTag(db, deviceId, tagId('Waiting'), { status: 'on-hold' });
    setItemTags(db, deviceId, held.id, [tagId('Waiting')]);

    await checkReminders(db);

    const sent = (id: string) =>
      !!db.get('SELECT 1 AS x FROM reminders_sent WHERE item_id = ? AND kind = ?', [id, 'due']);
    assert.ok(sent(free.id), 'the ordinary task fires its due reminder');
    assert.ok(!sent(held.id), 'the on-hold-tagged task is suppressed');
  });
});

// ─── Web Push error handling ──────────────────────────────────────────────────

describe('notifyTask WebPush error handling', () => {
  test('a non-404/410 send error is logged and the subscription is kept', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId } = addUser('u', 'pw');
    const endpoint = 'https://push.example.com/server-error';
    saveSubscription(db, userId, { endpoint, keys: { p256dh: 'A', auth: 'B' } });
    const item = createItem(db, deviceId, { title: 'task', ownerId: userId });

    const realSend = webpush.sendNotification;
    const realError = console.error;
    const logged: unknown[][] = [];
    webpush.sendNotification = (async () => {
      throw Object.assign(new Error('server exploded'), { statusCode: 500 });
    }) as typeof webpush.sendNotification;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      await notifyTask(db, item.id, { title: 'hi', body: 'there' });
    } finally {
      webpush.sendNotification = realSend;
      console.error = realError;
    }

    assert.ok(
      logged.some((a) => a.some((x) => String(x).includes('web push send failed'))),
      'the 500 error was logged, not silently swallowed',
    );
    assert.ok(
      db.get('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', [endpoint]),
      'subscription is NOT cleaned up for a non-404/410 error',
    );
  });

  test('a 410 (gone) error is not logged as an unexpected failure and cleans up the subscription', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId } = addUser('u2', 'pw');
    const endpoint = 'https://push.example.com/gone';
    saveSubscription(db, userId, { endpoint, keys: { p256dh: 'A', auth: 'B' } });
    const item = createItem(db, deviceId, { title: 'task2', ownerId: userId });

    const realSend = webpush.sendNotification;
    const realError = console.error;
    const logged: unknown[][] = [];
    webpush.sendNotification = (async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    }) as typeof webpush.sendNotification;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      await notifyTask(db, item.id, { title: 'hi', body: 'there' });
    } finally {
      webpush.sendNotification = realSend;
      console.error = realError;
    }

    assert.ok(
      !logged.some((a) => a.some((x) => String(x).includes('web push send failed'))),
      'a 410 is the expected "subscription gone" path, not an unexpected-error log',
    );
    assert.ok(
      !db.get('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', [endpoint]),
      'subscription is cleaned up for a 410',
    );
  });
});

// ─── Per-tenant VAPID signing ─────────────────────────────────────────────────

describe('per-tenant VAPID', () => {
  test('each tenant signs with its own keys, not a process-global pair', async () => {
    const a = makeTestDb();
    const b = makeTestDb();
    assert.notEqual(a.vapidPublicKey, b.vapidPublicKey, 'tenants generate distinct keypairs');

    const setup = (t: ReturnType<typeof makeTestDb>, name: string) => {
      const { id: userId } = t.addUser(name, 'pw');
      saveSubscription(t.db, userId, {
        endpoint: `https://push.example.com/${name}`,
        keys: { p256dh: 'A', auth: 'B' },
      });
      return createItem(t.db, t.deviceId, { title: name, ownerId: userId });
    };
    const itemA = setup(a, 'tenant-a');
    const itemB = setup(b, 'tenant-b');

    const realSend = webpush.sendNotification;
    const signedWith: Record<string, string | undefined> = {};
    webpush.sendNotification = (async (sub: { endpoint: string }, _p: unknown, opts?: unknown) => {
      signedWith[sub.endpoint] = (opts as { vapidDetails?: { publicKey: string } })?.vapidDetails
        ?.publicKey;
      return { statusCode: 201, body: '', headers: {} };
    }) as unknown as typeof webpush.sendNotification;
    try {
      await notifyTask(a.db, itemA.id, { title: 'hi', body: 'a' });
      await notifyTask(b.db, itemB.id, { title: 'hi', body: 'b' });
    } finally {
      webpush.sendNotification = realSend;
    }

    assert.equal(signedWith['https://push.example.com/tenant-a'], a.vapidPublicKey);
    assert.equal(signedWith['https://push.example.com/tenant-b'], b.vapidPublicKey);
  });
});

// ─── Shared-user fan-out ──────────────────────────────────────────────────────

describe('notifyTask shared-user fan-out', () => {
  test('notifies users the task is shared with, including inherited shares', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: ownerId } = addUser('owner', 'pw');
    const { id: directId } = addUser('direct', 'pw');
    const { id: inheritedId } = addUser('inherited', 'pw');
    for (const [uid, name] of [
      [ownerId, 'owner'],
      [directId, 'direct'],
      [inheritedId, 'inherited'],
    ] as const) {
      saveSubscription(db, uid, {
        endpoint: `https://push.example.com/${name}`,
        keys: { p256dh: 'A', auth: 'B' },
      });
    }
    const parent = createItem(db, deviceId, { title: 'parent', ownerId });
    const child = createItem(db, deviceId, { title: 'child', ownerId, parentId: parent.id });
    shareItem(db, deviceId, child.id, directId, 'read');
    shareItem(db, deviceId, parent.id, inheritedId, 'write');

    const realSend = webpush.sendNotification;
    const endpoints: string[] = [];
    webpush.sendNotification = (async (sub: { endpoint: string }) => {
      endpoints.push(sub.endpoint);
      return { statusCode: 201, body: '', headers: {} };
    }) as unknown as typeof webpush.sendNotification;
    try {
      const sent = await notifyTask(db, child.id, { title: 'hi', body: 'there' });
      assert.equal(sent.targets, 3);
      assert.equal(sent.delivered, 3);
    } finally {
      webpush.sendNotification = realSend;
    }

    assert.deepEqual(endpoints.sort(), [
      'https://push.example.com/direct',
      'https://push.example.com/inherited',
      'https://push.example.com/owner',
    ]);
  });
});

// ─── Retry on failed delivery ─────────────────────────────────────────────────

describe('checkReminders delivery accounting', () => {
  test('a failed send is retried on the next tick instead of being latched as sent', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId } = addUser('u', 'pw');
    saveSubscription(db, userId, {
      endpoint: 'https://push.example.com/flaky',
      keys: { p256dh: 'A', auth: 'B' },
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const item = createItem(db, deviceId, { title: 'task', ownerId: userId });
    updateItem(db, deviceId, item.id, { due_date: past });

    const sent = () =>
      !!db.get('SELECT 1 AS x FROM reminders_sent WHERE item_id = ? AND kind = ?', [item.id, 'due']);

    const realSend = webpush.sendNotification;
    const realError = console.error;
    console.error = () => {};
    try {
      // Tick 1: every send fails (e.g. push service outage / bad signature).
      webpush.sendNotification = (async () => {
        throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      }) as typeof webpush.sendNotification;
      await checkReminders(db);
      assert.ok(!sent(), 'failed delivery is not marked sent');

      // Tick 2: the send succeeds — now it latches.
      webpush.sendNotification = (async () => ({
        statusCode: 201,
        body: '',
        headers: {},
      })) as unknown as typeof webpush.sendNotification;
      await checkReminders(db);
      assert.ok(sent(), 'successful delivery is marked sent');
    } finally {
      webpush.sendNotification = realSend;
      console.error = realError;
    }
  });

  test('an alert with no subscriptions anywhere is still marked sent (nothing to deliver)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId } = addUser('u', 'pw');
    const past = new Date(Date.now() - 60_000).toISOString();
    const item = createItem(db, deviceId, { title: 'task', ownerId: userId });
    updateItem(db, deviceId, item.id, { due_date: past });

    await checkReminders(db);
    assert.ok(
      db.get('SELECT 1 AS x FROM reminders_sent WHERE item_id = ? AND kind = ?', [item.id, 'due']),
      'no-subscriber alerts latch immediately, matching red-state-only users',
    );
  });

  test('a persistently failing alert older than a day gives up and latches', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: userId } = addUser('u', 'pw');
    saveSubscription(db, userId, {
      endpoint: 'https://push.example.com/dead',
      keys: { p256dh: 'A', auth: 'B' },
    });
    const stale = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const item = createItem(db, deviceId, { title: 'task', ownerId: userId });
    updateItem(db, deviceId, item.id, { due_date: stale });

    const realSend = webpush.sendNotification;
    const realError = console.error;
    console.error = () => {};
    webpush.sendNotification = (async () => {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    }) as typeof webpush.sendNotification;
    try {
      await checkReminders(db);
    } finally {
      webpush.sendNotification = realSend;
      console.error = realError;
    }
    assert.ok(
      db.get('SELECT 1 AS x FROM reminders_sent WHERE item_id = ? AND kind = ?', [item.id, 'due']),
      'day-old undeliverable alerts latch instead of retrying forever',
    );
  });
});

// ─── FCM ─────────────────────────────────────────────────────────────────────

describe('POST /push/fcm', () => {
  test('saves an FCM token', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('u', 'pw');
    const app = buildPushApp(db, vapidPublicKey);
    const res = await appFetch(app, '/push/fcm', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fcm-abc-123' }),
    });
    assert.equal(res.status, 200);
    const row = db.get<{ user_id: string }>('SELECT user_id FROM fcm_tokens WHERE token = ?', [
      'fcm-abc-123',
    ]);
    assert.ok(row, 'FCM token persisted');
    assert.equal(row!.user_id, userId);
  });

  test('returns 400 when token is missing', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { basic } = addUser('u', 'pw');
    const app = buildPushApp(db, vapidPublicKey);
    const res = await appFetch(app, '/push/fcm', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /push/fcm/unsubscribe', () => {
  test('removes an FCM token', async () => {
    const { db, vapidPublicKey, addUser } = makeTestDb();
    const { basic } = addUser('u', 'pw');
    const app = buildPushApp(db, vapidPublicKey);

    // Register first
    await appFetch(app, '/push/fcm', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fcm-del-456' }),
    });
    assert.ok(db.get('SELECT 1 FROM fcm_tokens WHERE token = ?', ['fcm-del-456']));

    // Remove
    const res = await appFetch(app, '/push/fcm/unsubscribe', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fcm-del-456' }),
    });
    assert.equal(res.status, 200);
    assert.ok(!db.get('SELECT 1 FROM fcm_tokens WHERE token = ?', ['fcm-del-456']));
  });
});
