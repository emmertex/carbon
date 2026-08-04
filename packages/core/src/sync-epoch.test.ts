import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';
import { insertOp, applyOp, nextTs } from './crdt';
import { insertRecordOp } from './records';
import { createItem, getItem, upsertTag, upsertShare } from './repo';
import {
  compactSettingRecordOps,
  rebuildSyncLogFromMaterialization,
} from './sync-epoch';
import type { Op } from './types';
import type { RecordOp } from './records';

let seq = 0;
function settingOp(
  over: Partial<RecordOp> & { row_id: string; data: unknown },
): RecordOp {
  return {
    id: `set-${++seq}`,
    entity: 'setting',
    ts: 1000 + seq,
    device_id: 'dev-a',
    ...over,
  };
}

test('compactSettingRecordOps keeps LWW winner per scope+user; prunes losers', () => {
  const db = openMemoryDb();
  const older = settingOp({
    row_id: 'ui',
    ts: 100,
    data: { user_id: 'u1', payload: { a: 1 } },
  });
  const newer = settingOp({
    row_id: 'ui',
    ts: 200,
    data: { user_id: 'u1', payload: { a: 2 } },
  });
  const otherUser = settingOp({
    row_id: 'ui',
    ts: 150,
    data: { user_id: 'u2', payload: { a: 9 } },
  });
  // Extra op so MAX(rowid) is not a loser we need to delete this pass.
  const views = settingOp({
    row_id: 'views',
    ts: 300,
    data: { user_id: 'u1', payload: {} },
  });
  for (const o of [older, newer, otherUser, views]) insertRecordOp(db, o, true);

  const removed = compactSettingRecordOps(db);
  assert.equal(removed, 1, 'only older u1/ui loser pruned');
  const ids = db
    .all<{ id: string }>('SELECT id FROM record_ops WHERE entity = ? ORDER BY rowid', ['setting'])
    .map((r) => r.id);
  assert.ok(!ids.includes(older.id));
  assert.ok(ids.includes(newer.id));
  assert.ok(ids.includes(otherUser.id), 'other user scope retained');
  assert.ok(ids.includes(views.id));
});

test('compactSettingRecordOps never deletes MAX(rowid)', () => {
  const db = openMemoryDb();
  // Only two setting ops for the same key: the loser is also MAX(rowid).
  const winner = settingOp({
    row_id: 'ui',
    ts: 200,
    device_id: 'dev-z',
    data: { user_id: 'u1', payload: { v: 2 } },
  });
  const loserAtTop = settingOp({
    row_id: 'ui',
    ts: 100,
    device_id: 'dev-a',
    data: { user_id: 'u1', payload: { v: 1 } },
  });
  insertRecordOp(db, winner, true);
  insertRecordOp(db, loserAtTop, true); // higher rowid, lower ts

  const maxBefore =
    db.get<{ m: number }>('SELECT MAX(rowid) AS m FROM record_ops')!.m;
  const removed = compactSettingRecordOps(db);
  assert.equal(removed, 0, 'loser at MAX(rowid) retained this pass');
  assert.equal(
    db.get<{ m: number }>('SELECT MAX(rowid) AS m FROM record_ops')!.m,
    maxBefore,
  );
  assert.ok(
    db.get('SELECT 1 AS x FROM record_ops WHERE id = ?', [loserAtTop.id]),
    'top-rowid loser still present',
  );
});

test('compactSettingRecordOps syncedOnly skips unsynced ops', () => {
  const db = openMemoryDb();
  const syncedOld = settingOp({
    row_id: 'ui',
    ts: 100,
    data: { user_id: 'u1', payload: { a: 1 } },
  });
  const unsyncedNew = settingOp({
    row_id: 'ui',
    ts: 200,
    data: { user_id: 'u1', payload: { a: 2 } },
  });
  const syncedPad = settingOp({
    row_id: 'views',
    ts: 300,
    data: { user_id: 'u1', payload: {} },
  });
  insertRecordOp(db, syncedOld, true);
  insertRecordOp(db, unsyncedNew, false);
  insertRecordOp(db, syncedPad, true);

  const removed = compactSettingRecordOps(db, { syncedOnly: true });
  assert.equal(removed, 0, 'unsynced winner does not license deleting synced older');
  assert.ok(db.get('SELECT 1 AS x FROM record_ops WHERE id = ?', [syncedOld.id]));
  assert.ok(db.get('SELECT 1 AS x FROM record_ops WHERE id = ?', [unsyncedNew.id]));
});

test('rebuildSyncLogFromMaterialization shrinks log and preserves item state', () => {
  const db = openMemoryDb();
  const item = createItem(db, 'dev-a', {
    type: 'task',
    title: 'Hello',
    note: 'body',
    ownerId: 'u1',
  });
  // Extra note-only edits to bloat the log.
  for (let i = 0; i < 5; i++) {
    const o: Op = {
      id: `n-${i}`,
      item_id: item.id,
      ts: nextTs(db),
      device_id: 'dev-a',
      fields: { note: `v${i}` },
    };
    insertOp(db, o, true);
    applyOp(db, o);
  }
  upsertTag(db, {
    id: 't:work',
    name: 'Work',
    color: null,
    status: 'active',
    sort_order: 0,
    geo: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted: false,
  });
  upsertShare(db, {
    id: `s:${item.id}:u2`,
    item_id: item.id,
    user_id: 'u2',
    permission: 'read',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted: false,
  });
  // Setting history.
  insertRecordOp(
    db,
    settingOp({ row_id: 'ui', ts: 1, data: { user_id: 'u1', payload: { old: true } } }),
    true,
  );
  insertRecordOp(
    db,
    settingOp({ row_id: 'ui', ts: 2, data: { user_id: 'u1', payload: { old: false } } }),
    true,
  );

  const opsBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n;
  assert.ok(opsBefore > 1);

  const titleBefore = getItem(db, item.id)!.title;
  const noteBefore = getItem(db, item.id)!.note;
  const result = rebuildSyncLogFromMaterialization(db);

  assert.equal(getItem(db, item.id)!.title, titleBefore);
  assert.equal(getItem(db, item.id)!.note, noteBefore);
  assert.equal(result.opCount, 1, 'one bootstrap op per item');
  assert.ok(result.recordOpCount >= 2, 'tag + share (+ settings) bootstrapped');
  assert.ok(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n < opsBefore,
    'op log shrank',
  );

  // Fresh peer replaying bootstrap converges.
  const fresh = openMemoryDb();
  const opRows = db.all<{
    id: string;
    item_id: string;
    ts: number;
    device_id: string;
    fields: string;
  }>('SELECT id, item_id, ts, device_id, fields FROM ops ORDER BY rowid');
  for (const r of opRows) {
    const o: Op = {
      id: r.id,
      item_id: r.item_id,
      ts: Number(r.ts),
      device_id: r.device_id,
      fields: JSON.parse(r.fields),
    };
    insertOp(fresh, o, true);
    applyOp(fresh, o);
  }
  assert.equal(getItem(fresh, item.id)?.title, titleBefore);
  assert.equal(getItem(fresh, item.id)?.note, noteBefore);

  // Only one setting winner survives.
  const settings = db.all<{ data: string }>(
    "SELECT data FROM record_ops WHERE entity = 'setting' AND row_id = 'ui'",
  );
  assert.equal(settings.length, 1);
  assert.equal(JSON.parse(settings[0]!.data).payload.old, false);
});
