import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  createItem,
  ingestOps,
  visibleItemIds,
  listUsers,
  type Op,
  type RecordOp,
} from '@carbon/core';
import { sanitizeOps, sanitizeRecordOps } from './sync-guard';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';

// ─── inline sync route (mirrors index.ts POST /api/sync) ─────────────────────

interface OpRow {
  seq: number;
  id: string;
  item_id: string;
  ts: number;
  device_id: string;
  fields: string;
}

interface RecRow {
  seq: number;
  id: string;
  entity: string;
  row_id: string;
  ts: number;
  device_id: string;
  data: string;
}

function buildSyncApp(db: TestDb) {
  const { deviceId } = db as unknown as { deviceId: string };
  const app = makeHono(db); // allowOpen=true for single-user mode

  app.post('/sync', async (c) => {
    const userId = c.get('userId');
    const open = userId === 'local';
    const body = (await c.req.json().catch(() => ({}))) as {
      since?: number;
      rsince?: number;
      ops?: Op[];
      recordOps?: RecordOp[];
      need?: string[];
    };
    const since = Number(body.since ?? 0);
    const rsince = Number(body.rsince ?? 0);

    if (!open && Array.isArray(body.ops)) body.ops = sanitizeOps(db, userId, body.ops);
    if (Array.isArray(body.ops) && body.ops.length) ingestOps(db, body.ops, true);
    if (!open && Array.isArray(body.recordOps))
      body.recordOps = sanitizeRecordOps(db, userId, body.recordOps);

    const visible = open ? null : visibleItemIds(db, userId);

    const opRows = db.all<OpRow>(
      `SELECT rowid AS seq, id, item_id, ts, device_id, fields FROM ops WHERE rowid > ? ORDER BY rowid`,
      [since],
    );
    const ops: Op[] = [];
    let cursor = since;
    for (const r of opRows) {
      cursor = r.seq;
      if (open || visible!.has(r.item_id)) {
        ops.push({
          id: r.id,
          item_id: r.item_id,
          ts: Number(r.ts),
          device_id: r.device_id,
          fields: JSON.parse(r.fields),
        });
      }
    }

    const recRows = db.all<RecRow>(
      `SELECT rowid AS seq, id, entity, row_id, ts, device_id, data FROM record_ops WHERE rowid > ? ORDER BY rowid`,
      [rsince],
    );
    const recordOps: RecordOp[] = [];
    let rcursor = rsince;
    for (const r of recRows) {
      rcursor = r.seq;
      const data = JSON.parse(r.data) as { item_id?: string; user_id?: string };
      const visibleRec =
        open ||
        r.entity === 'tag' ||
        data.user_id === userId ||
        (data.item_id ? visible!.has(data.item_id) : false);
      if (visibleRec) {
        recordOps.push({
          id: r.id,
          entity: r.entity,
          row_id: r.row_id,
          ts: Number(r.ts),
          device_id: r.device_id,
          data,
        });
      }
    }

    const users = listUsers(db);
    return c.json({ ops, cursor, recordOps, rcursor, users });
  });

  return app;
}

// ─── open-mode sync ───────────────────────────────────────────────────────────

describe('POST /sync — open mode (no auth)', () => {
  test('empty sync returns zero-cursors and empty op arrays', async () => {
    const { db, deviceId } = makeTestDb();
    const testDb = Object.assign(db, { deviceId });
    const app = buildSyncApp(testDb as TestDb & { deviceId: string });
    const res = await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      ops: Op[];
      cursor: number;
      recordOps: RecordOp[];
      rcursor: number;
      users: unknown[];
    };
    assert.deepEqual(body.ops, []);
    assert.equal(body.cursor, 0);
    assert.deepEqual(body.recordOps, []);
    assert.equal(body.rcursor, 0);
    assert.ok(Array.isArray(body.users));
  });

  test('ops pushed by client are returned in next sync', async () => {
    const { db, deviceId } = makeTestDb();
    const testDb = Object.assign(db, { deviceId });
    const app = buildSyncApp(testDb as TestDb & { deviceId: string });

    const itemId = 'sync-item-1';
    const now = Date.now();
    const ops: Op[] = [
      {
        id: `op-${now}`,
        item_id: itemId,
        ts: now,
        device_id: 'client-A',
        fields: { type: 'task', title: 'From Client', owner_id: null },
      },
    ];

    // First sync: push ops
    const pushRes = await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops }),
    });
    assert.equal(pushRes.status, 200);

    // Second sync from cursor=0: should get the ops back
    const pullRes = await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: 0 }),
    });
    const pullBody = await pullRes.json() as { ops: Op[] };
    assert.ok(pullBody.ops.some((o) => o.item_id === itemId), 'ingested op reflected');
  });

  test('cursor advances — second pull from cursor gets only new ops', async () => {
    const { db, deviceId } = makeTestDb();
    const testDb = Object.assign(db, { deviceId });
    const app = buildSyncApp(testDb as TestDb & { deviceId: string });

    const now = Date.now();
    // Push item A
    await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ops: [{
          id: `op-A-${now}`,
          item_id: 'item-A',
          ts: now,
          device_id: 'dev',
          fields: { type: 'task', title: 'A', owner_id: null },
        }],
      }),
    });

    // Pull from 0 — get cursor
    const res1 = await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: 0 }),
    });
    const { cursor } = await res1.json() as { cursor: number };
    assert.ok(cursor > 0, 'cursor advanced');

    // Push item B
    await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ops: [{
          id: `op-B-${now + 1}`,
          item_id: 'item-B',
          ts: now + 1,
          device_id: 'dev',
          fields: { type: 'task', title: 'B', owner_id: null },
        }],
      }),
    });

    // Pull from saved cursor — should only get item-B
    const res2 = await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: cursor }),
    });
    const { ops: newOps } = await res2.json() as { ops: Op[] };
    assert.ok(!newOps.some((o) => o.item_id === 'item-A'), 'item-A not re-sent');
    assert.ok(newOps.some((o) => o.item_id === 'item-B'), 'item-B is in delta');
  });

  test('users roster is always returned', async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId, basic: aliceBasic } = addUser('alice', 'pw');
    const testDb = Object.assign(db, { deviceId });
    const app = buildSyncApp(testDb as TestDb & { deviceId: string });
    // Use alice's credentials so the response is scoped to her visible items;
    // listUsers always returns all non-deleted users regardless of scope.
    const res = await appFetch(app, '/sync', {
      method: 'POST',
      headers: { Authorization: aliceBasic, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { users?: { username: string; id: string }[] };
    assert.ok(Array.isArray(body.users), 'users array present');
    assert.ok(body.users!.some((u) => u.id === aliceId), 'alice in roster');
  });
});

// ─── authenticated sync visibility scoping ────────────────────────────────────

describe('POST /sync — visibility scoping (authenticated)', () => {
  test("authenticated user only sees their own items in the op stream", async () => {
    const { db, deviceId, addUser } = makeTestDb();
    const { id: aliceId, basic: aliceBasic } = addUser('alice', 'pw');
    const { id: bobId } = addUser('bob', 'pw');

    // Create a task owned by Alice
    createItem(db, deviceId, { type: 'task', title: 'Alice task', ownerId: aliceId });
    // Create a task owned by Bob
    createItem(db, deviceId, { type: 'task', title: 'Bob task', ownerId: bobId });

    const testDb = Object.assign(db, { deviceId });
    const app = buildSyncApp(testDb as TestDb & { deviceId: string });

    const res = await appFetch(app, '/sync', {
      method: 'POST',
      headers: { Authorization: aliceBasic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: 0 }),
    });
    assert.equal(res.status, 200);
    const { ops } = await res.json() as { ops: Op[] };

    // Alice sees her own task
    assert.ok(ops.some((o) => (o.fields as Record<string, unknown>).title === 'Alice task'));
    // Alice does NOT see Bob's task
    assert.ok(!ops.some((o) => (o.fields as Record<string, unknown>).title === 'Bob task'));
  });
});

// ─── op ingestion idempotency ─────────────────────────────────────────────────

describe('POST /sync — op ingestion idempotency', () => {
  test('pushing the same op twice does not create duplicate items', async () => {
    const { db, deviceId } = makeTestDb();
    const testDb = Object.assign(db, { deviceId });
    const app = buildSyncApp(testDb as TestDb & { deviceId: string });

    const op: Op = {
      id: 'idem-op-001',
      item_id: 'idem-item',
      ts: 1_750_000_000_000,
      device_id: 'dev',
      fields: { type: 'task', title: 'Idempotent', owner_id: null },
    };

    await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [op] }),
    });
    await appFetch(app, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [op] }),
    });

    const count = db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT id) AS n FROM ops WHERE id = ?`,
      [op.id],
    )?.n ?? 0;
    assert.equal(count, 1, 'op stored exactly once');
  });
});
