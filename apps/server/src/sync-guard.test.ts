import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate, createItem, createUser, shareItem, type Op, type RecordOp } from '@carbon/core';
import { openDb } from './sqlite';
import { sanitizeOps, sanitizeRecordOps, SYNC_SKEW_MS } from './sync-guard';

const DEV = 'd';
const NOW = 1_750_000_000_000;

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

const op = (over: Partial<Op> & { item_id: string }): Op => ({
  id: `op-${Math.round(Math.random() * 1e9)}`,
  ts: NOW,
  device_id: 'dev',
  fields: {},
  ...over,
});
const rec = (over: Partial<RecordOp> & { entity: string }): RecordOp => ({
  id: `r-${Math.round(Math.random() * 1e9)}`,
  row_id: 'row',
  ts: NOW,
  device_id: 'dev',
  data: {},
  ...over,
});

test('sanitizeOps clamps a far-future timestamp to now + skew', () => {
  const d = db();
  const [out] = sanitizeOps(d, 'alice', [op({ item_id: 'new1', ts: NOW + 1e12, fields: { type: 'task' } })], NOW);
  assert.ok(out!.ts <= NOW + SYNC_SKEW_MS);
});

test('sanitizeOps forces ownership of a brand-new item to the caller', () => {
  const d = db();
  const [out] = sanitizeOps(
    d,
    'alice',
    [op({ item_id: 'new2', fields: { type: 'task', owner_id: 'victim', title: 'x' } })],
    NOW,
  );
  assert.equal(out!.fields.owner_id, 'alice');
});

test('sanitizeOps drops a write to another user’s item with no share', () => {
  const d = db();
  createItem(d, DEV, { title: 'alices', ownerId: 'alice' });
  const alices = d.get<{ id: string }>("SELECT id FROM items WHERE owner_id = 'alice'")!;
  const out = sanitizeOps(d, 'bob', [op({ item_id: alices.id, fields: { title: 'hijack' } })], NOW);
  assert.equal(out.length, 0, 'no write access → op dropped');
});

test('sanitizeOps keeps a write to a shared item but strips an ownership grab', () => {
  const d = db();
  const it = createItem(d, DEV, { title: 'alices', ownerId: 'alice' });
  shareItem(d, DEV, it.id, 'bob', 'write');
  const [out] = sanitizeOps(
    d,
    'bob',
    [op({ item_id: it.id, fields: { title: 'edit', owner_id: 'bob' } })],
    NOW,
  );
  assert.equal(out!.fields.title, 'edit', 'legit edit kept');
  assert.equal('owner_id' in out!.fields, false, 'ownership grab stripped');
});

test('sanitizeOps does not strip sys_kind (non-identity marker passes through)', () => {
  const d = db();
  const [out] = sanitizeOps(
    d,
    'alice',
    [op({ item_id: 'sys1', fields: { type: 'task', title: 'offer', sys_kind: 'federation_offer' } })],
    NOW,
  );
  assert.equal(out!.fields.sys_kind, 'federation_offer', 'sys_kind survives sanitization');
});

test('sanitizeRecordOps forces comment author to the caller', () => {
  const d = db();
  const it = createItem(d, DEV, { title: 't', ownerId: 'bob' });
  const [out] = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'comment', data: { item_id: it.id, author_id: 'alice', body: 'hi' } })],
    NOW,
  );
  assert.equal((out!.data as { author_id: string }).author_id, 'bob');
});

test('sanitizeRecordOps drops a share for an item the caller cannot write', () => {
  const d = db();
  const it = createItem(d, DEV, { title: 't', ownerId: 'alice' });
  const out = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'share', data: { item_id: it.id, user_id: 'bob', permission: 'write' } })],
    NOW,
  );
  assert.equal(out.length, 0);
});

test('sanitizeRecordOps keeps an item_dep link when the caller can write both endpoints', () => {
  const d = db();
  const a = createItem(d, DEV, { title: 'a', ownerId: 'bob' });
  const b = createItem(d, DEV, { title: 'b', ownerId: 'bob' });
  const [out] = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'item_dep', data: { pred_id: a.id, succ_id: b.id, deleted: false } })],
    NOW,
  );
  assert.equal((out!.data as { pred_id: string }).pred_id, a.id, 'op kept');
});

test('sanitizeRecordOps drops an item_dep link when the caller lacks write access to one endpoint', () => {
  const d = db();
  const a = createItem(d, DEV, { title: 'a', ownerId: 'bob' });
  const b = createItem(d, DEV, { title: 'b', ownerId: 'alice' }); // bob has no access here
  const out = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'item_dep', data: { pred_id: a.id, succ_id: b.id, deleted: false } })],
    NOW,
  );
  assert.equal(out.length, 0, 'no write access to succ → op dropped');
});

test('sanitizeRecordOps drops a comment against an item the caller cannot see', () => {
  const d = db();
  const it = createItem(d, DEV, { title: 't', ownerId: 'alice' });
  const out = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'comment', data: { item_id: it.id, author_id: 'bob', body: 'hi' } })],
    NOW,
  );
  assert.equal(out.length, 0, 'no read access → comment dropped');
});

test('sanitizeRecordOps keeps a comment on an item the caller has read-only access to', () => {
  const d = db();
  const it = createItem(d, DEV, { title: 't', ownerId: 'alice' });
  shareItem(d, DEV, it.id, 'bob', 'read');
  const [out] = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'comment', data: { item_id: it.id, author_id: 'mallory', body: 'hi' } })],
    NOW,
  );
  assert.equal((out!.data as { author_id: string }).author_id, 'bob', 'read access is enough to comment');
});

test('sanitizeRecordOps drops an item_tag/attachment op with a missing item_id', () => {
  const d = db();
  const out = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'item_tag', data: { tag_id: 'tag1' } })],
    NOW,
  );
  assert.equal(out.length, 0, 'malformed op (no item_id) fails closed, not open');
});

test('sanitizeRecordOps forces per-user rows (timelog) to the caller and drops user rows', () => {
  const d = db();
  const it = createItem(d, DEV, { title: 't', ownerId: 'bob' });
  const [tl] = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'timelog', data: { item_id: it.id, user_id: 'someone-else' } })],
    NOW,
  );
  assert.equal((tl!.data as { user_id: string }).user_id, 'bob');

  const users = sanitizeRecordOps(
    d,
    'bob',
    [rec({ entity: 'user', data: { id: 'mallory', role: 'admin' } })],
    NOW,
  );
  assert.equal(users.length, 0, 'client-pushed user rows are dropped (no role escalation)');
});
