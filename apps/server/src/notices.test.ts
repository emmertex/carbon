/**
 * Tests for the system-notice ("Carbon task") primitive — independent of
 * federation. Verifies createSystemNotice injects an Inbox task marked with
 * sys_kind + a pending notice row; that acting on it (session-authed to the
 * owner) resolves it; that a different user gets 403; and that the primitive is
 * kind-generic (an `invoice` notice works identically to `federation_offer`).
 *
 * Mirrors agent-api.test.ts: an in-process Hono app, no real HTTP server.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { getItem, inbox, allItems } from '@carbon/core';
import type { MiddlewareHandler } from 'hono';
import type { AuthVars } from './auth';
import {
  createSystemNotice,
  getNotice,
  listOpenNotices,
  actOnNotice,
} from './notices';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';

/** Register the same two /notices routes the tenant app exposes (session-only). */
function buildNoticeApp(db: TestDb, deviceId: string) {
  const app = makeHono(db, false); // require auth
  const requireSession: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
    if (c.get('authMethod') === 'token') return c.json({ error: 'forbidden' }, 403);
    return next();
  };
  app.get('/notices', requireSession, (c) =>
    c.json({ notices: listOpenNotices(db, c.get('userId')) }),
  );
  app.post('/notices/:id/act', requireSession, async (c) => {
    const userId = c.get('userId');
    const notice = getNotice(db, c.req.param('id'));
    if (!notice) return c.json({ error: 'not found' }, 404);
    if (notice.user_id !== userId) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { action?: string };
    const resolved = await actOnNotice(db, deviceId, notice, b.action ?? 'dismiss');
    return c.json({ notice: resolved });
  });
  return app;
}

describe('createSystemNotice', () => {
  test('injects an Inbox task marked sys_kind + a pending notice row', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');

    const { item, notice } = createSystemNotice(db, deviceId, uid, {
      kind: 'federation_offer',
      title: 'Bob wants to share Roadmap',
      body: 'Approve to accept the share.',
      actions: ['accept', 'decline'],
    });

    // The item is a Carbon-authored Inbox task owned by the addressed user.
    assert.equal(item.type, 'task');
    assert.equal(item.parent_id, null);
    assert.equal(item.owner_id, uid);
    assert.equal(item.sys_kind, 'federation_offer');
    assert.equal(item.note, 'Approve to accept the share.');
    assert.ok(inbox(allItems(db)).some((i) => i.id === item.id), 'lands in the Inbox');

    // The notice row is the actionable truth: pending, with a random token.
    assert.equal(notice.state, 'pending');
    assert.equal(notice.user_id, uid);
    assert.equal(notice.item_id, item.id);
    assert.ok(notice.action_token && notice.action_token.length >= 16);
    assert.deepEqual(JSON.parse(notice.payload_json!), { actions: ['accept', 'decline'] });
  });

  test('is kind-generic — an invoice notice round-trips like any other', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    const { item, notice } = createSystemNotice(db, deviceId, uid, {
      kind: 'invoice',
      title: 'Invoice #42 is ready',
    });
    assert.equal(item.sys_kind, 'invoice');
    assert.equal(notice.kind, 'invoice');
    assert.equal(notice.state, 'pending');
    assert.equal(listOpenNotices(db, uid).length, 1);
  });
});

describe('POST /notices/:id/act', () => {
  test('the owner session resolves the notice (and tombstones the item)', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('alice', 'pw');
    const { item, notice } = createSystemNotice(db, deviceId, uid, {
      kind: 'federation_offer',
      title: 'offer',
    });

    const res = await appFetch(buildNoticeApp(db, deviceId), `/notices/${notice.id}/act`, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { notice: { state: string; resolved_at: string | null } };
    assert.equal(body.notice.state, 'declined'); // dismiss → declined by default
    assert.ok(body.notice.resolved_at);

    // Resolved notice no longer listed as open; item tombstoned (done → left Inbox).
    assert.equal(listOpenNotices(db, uid).length, 0);
    assert.equal(getItem(db, item.id)?.status, 'done');
  });

  test('action=accept resolves as accepted', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('alice', 'pw');
    const { notice } = createSystemNotice(db, deviceId, uid, { kind: 'invoice', title: 'inv' });
    const res = await appFetch(buildNoticeApp(db, deviceId), `/notices/${notice.id}/act`, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });
    const body = (await res.json()) as { notice: { state: string } };
    assert.equal(body.notice.state, 'accepted');
  });

  test('a different user’s session gets 403', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    const { basic: malloryBasic } = addUser('mallory', 'pw');
    const { notice } = createSystemNotice(db, deviceId, uid, {
      kind: 'federation_offer',
      title: 'alice-only offer',
    });

    const res = await appFetch(buildNoticeApp(db, deviceId), `/notices/${notice.id}/act`, {
      method: 'POST',
      headers: { Authorization: malloryBasic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });
    assert.equal(res.status, 403, 'only the addressed user may act');
    // The notice is untouched.
    assert.equal(getNotice(db, notice.id)?.state, 'pending');
  });

  test('GET /notices lists only this user’s open notices', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('alice', 'pw');
    const { id: other } = addUser('bob', 'pw');
    createSystemNotice(db, deviceId, uid, { kind: 'invoice', title: 'alice inv' });
    createSystemNotice(db, deviceId, other, { kind: 'invoice', title: 'bob inv' });

    const res = await appFetch(buildNoticeApp(db, deviceId), '/notices', {
      headers: { Authorization: basic },
    });
    const body = (await res.json()) as { notices: { user_id: string }[] };
    assert.equal(body.notices.length, 1);
    assert.equal(body.notices[0]!.user_id, uid);
  });
});
