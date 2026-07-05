/**
 * Tests for the "completed items are piling up" Inbox nudge — verifies the
 * +200 threshold crossing against `purge_notice_state`: only purgeable items
 * (old enough, real tasks) count, the watermark stops a re-fire on every tick
 * (including after a real dismissal), purging below a band re-arms the
 * sequence at the current band, and bot / federation-shadow users are skipped.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createItem, updateItem, createUser } from '@carbon/core';
import { listOpenNotices, actOnNotice } from './notices';
import { checkPurgeSuggestions } from './purge-notices';
import { makeTestDb } from './test-app';

// The sweep only counts items completed more than COMPLETED_PURGE_AGE_DAYS (7)
// ago, so completions are stamped 10 days old unless a test says otherwise.
const OLD = new Date(Date.now() - 10 * 86_400_000).toISOString();

function completeN(
  db: ReturnType<typeof makeTestDb>['db'],
  deviceId: string,
  ownerId: string,
  n: number,
  completedAt = OLD,
) {
  for (let i = 0; i < n; i++) {
    const item = createItem(db, deviceId, { title: `done ${i}`, ownerId });
    updateItem(db, deviceId, item.id, { status: 'done', completed_at: completedAt });
  }
}

describe('checkPurgeSuggestions', () => {
  test('no notice below the first threshold', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    completeN(db, deviceId, uid, 199);
    checkPurgeSuggestions(db, deviceId);
    assert.equal(listOpenNotices(db, uid).length, 0);
  });

  test('recent completions do not count: the nudge only fires for purgeable (old enough) items', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    completeN(db, deviceId, uid, 250, new Date().toISOString());
    checkPurgeSuggestions(db, deviceId);
    assert.equal(listOpenNotices(db, uid).length, 0);
  });

  test('crossing 200 fires exactly one notice, and re-running the sweep does not duplicate it', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    completeN(db, deviceId, uid, 200);
    checkPurgeSuggestions(db, deviceId);
    checkPurgeSuggestions(db, deviceId);
    checkPurgeSuggestions(db, deviceId);
    const open = listOpenNotices(db, uid);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.kind, 'purge_suggestion');
  });

  test('a dismissed notice does not re-fire until the NEXT threshold', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    completeN(db, deviceId, uid, 200);
    checkPurgeSuggestions(db, deviceId);
    const [first] = listOpenNotices(db, uid);
    assert.ok(first);

    // User dismisses the notice but doesn't purge — the count stays >= 200.
    await actOnNotice(db, deviceId, first!, 'dismiss');
    assert.equal(listOpenNotices(db, uid).length, 0);

    // Growing within the same band (350 < 400) must not re-prompt.
    completeN(db, deviceId, uid, 150);
    checkPurgeSuggestions(db, deviceId);
    assert.equal(listOpenNotices(db, uid).length, 0);

    // Crossing 400 fires a fresh, distinct notice.
    completeN(db, deviceId, uid, 60); // now 410 old + the 1 resolved notice task
    checkPurgeSuggestions(db, deviceId);
    const reopened = listOpenNotices(db, uid);
    assert.equal(reopened.length, 1);
    assert.notEqual(reopened[0]!.id, first!.id);
  });

  test('dropping back under the step (a full purge) re-arms the sequence from 200', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    completeN(db, deviceId, uid, 200);
    checkPurgeSuggestions(db, deviceId);
    assert.equal(listOpenNotices(db, uid).length, 1);

    // Simulate a purge: soft-delete all the completed items back to 0.
    const items = db.all<{ id: string }>(
      `SELECT id FROM items WHERE owner_id = ? AND status = 'done'`,
      [uid],
    );
    for (const it of items) db.run('UPDATE items SET deleted = 1 WHERE id = ?', [it.id]);
    checkPurgeSuggestions(db, deviceId); // resets last_threshold to 0, no new notice

    completeN(db, deviceId, uid, 200);
    checkPurgeSuggestions(db, deviceId);
    // A fresh crossing of 200 fires again rather than requiring 400+.
    assert.equal(listOpenNotices(db, uid).length, 2);
  });

  test('a partial purge lowers the watermark to the current band, not all the way', () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    completeN(db, deviceId, uid, 410);
    checkPurgeSuggestions(db, deviceId); // one notice, watermark 400
    assert.equal(listOpenNotices(db, uid).length, 1);

    // Purge 200 of them: count 210, band 200 < 400 → watermark drops to 200.
    const items = db.all<{ id: string }>(
      `SELECT id FROM items WHERE owner_id = ? AND status = 'done' LIMIT 200`,
      [uid],
    );
    for (const it of items) db.run('UPDATE items SET deleted = 1 WHERE id = ?', [it.id]);
    checkPurgeSuggestions(db, deviceId); // no new notice, just re-arms
    assert.equal(listOpenNotices(db, uid).length, 1);

    // Growing back over 400 must fire again — not wait for the old 600 mark.
    completeN(db, deviceId, uid, 200); // now 410
    checkPurgeSuggestions(db, deviceId);
    assert.equal(listOpenNotices(db, uid).length, 2);
  });

  test('bot users are skipped', () => {
    const { db, deviceId } = makeTestDb();
    const bot = createUser(db, { username: 'agent-bot', isBot: true });
    completeN(db, deviceId, bot.id, 300);
    checkPurgeSuggestions(db, deviceId);
    assert.equal(listOpenNotices(db, bot.id).length, 0);
  });

  test('federation shadow users are skipped', () => {
    const { db, deviceId } = makeTestDb();
    const remote = createUser(db, { username: 'bob@peer' });
    db.run('UPDATE users SET is_remote = 1 WHERE id = ?', [remote.id]);
    completeN(db, deviceId, remote.id, 300);
    checkPurgeSuggestions(db, deviceId);
    assert.equal(listOpenNotices(db, remote.id).length, 0);
  });
});
