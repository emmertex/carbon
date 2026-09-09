import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { makeTestDb } from './test-app';
import { alreadySent, markSent } from './reminders-sent';

describe('reminders-sent', () => {
  test('alreadySent returns false initially', () => {
    const { db } = makeTestDb();
    assert.equal(alreadySent(db, 'item-1', 'due', '2025-01-01'), false);
  });

  test('markSent + alreadySent dedup', () => {
    const { db } = makeTestDb();
    assert.equal(alreadySent(db, 'item-1', 'due', '2025-01-01'), false);
    markSent(db, 'item-1', 'due', '2025-01-01');
    assert.equal(alreadySent(db, 'item-1', 'due', '2025-01-01'), true);
  });

  test('different kind is not deduped', () => {
    const { db } = makeTestDb();
    markSent(db, 'item-1', 'due', '2025-01-01');
    assert.equal(alreadySent(db, 'item-1', 'defer', '2025-01-01'), false);
  });

  test('different marker is not deduped', () => {
    const { db } = makeTestDb();
    markSent(db, 'item-1', 'due', '2025-01-01');
    assert.equal(alreadySent(db, 'item-1', 'due', '2025-01-02'), false);
  });

  test('different item is not deduped', () => {
    const { db } = makeTestDb();
    markSent(db, 'item-1', 'due', '2025-01-01');
    assert.equal(alreadySent(db, 'item-2', 'due', '2025-01-01'), false);
  });

  test('markSent is idempotent (ON CONFLICT DO NOTHING)', () => {
    const { db } = makeTestDb();
    markSent(db, 'item-1', 'due', '2025-01-01');
    markSent(db, 'item-1', 'due', '2025-01-01');
    const rows = db.all('SELECT * FROM reminders_sent');
    assert.equal(rows.length, 1);
  });
});
