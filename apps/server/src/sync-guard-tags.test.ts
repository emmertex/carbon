import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { migrate, type RecordOp } from '@carbon/core';
import { openDb } from './sqlite';

/**
 * Per-workspace tag-store cap (A2). Tags are shared vocabulary and the sync pull re-sends
 * the full tag set to every client, so an unbounded tag store grows the response without
 * bound. A malicious push could otherwise mint 10k new tags per sync. The cap (set here to
 * 2 via env before loading sync-guard) must let the first N new tags through and drop the
 * rest — while existing-tag updates always pass.
 */
process.env.TAGS_MAX_PER_WORKSPACE = '2';

const NOW = 1_750_000_000_000;
function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}
const tagOp = (tagId: string, name: string): RecordOp => ({
  id: `r-${tagId}-${Math.round(Math.random() * 1e9)}`,
  entity: 'tag',
  row_id: tagId,
  ts: NOW,
  device_id: 'dev',
  data: { id: tagId, name, color: null, status: 'active', sort_order: 0, created_at: '', updated_at: '', deleted: false },
});

describe('sanitizeRecordOps — tag store cap', () => {
  test('new-tag creates beyond the cap are dropped; within it are kept', async () => {
    const { sanitizeRecordOps, TAGS_MAX_PER_WORKSPACE } = await import('./sync-guard');
    assert.equal(TAGS_MAX_PER_WORKSPACE, 2, 'env cap must take effect');
    const d = db();
    const out = sanitizeRecordOps(
      d,
      'alice',
      [tagOp('t1', 'one'), tagOp('t2', 'two'), tagOp('t3', 'three'), tagOp('t4', 'four')],
      NOW,
    );
    const kept = out.filter((o) => o.entity === 'tag').map((o) => o.row_id).sort();
    assert.deepEqual(kept, ['t1', 't2'], `expected the first ${2} tags kept, got ${kept}`);
  });

  test('updates to EXISTING tags are never dropped by the cap', async () => {
    const { sanitizeRecordOps } = await import('./sync-guard');
    const d = db();
    // Seed two existing tags (fills the cap) via the record_ops log.
    d.run(
      `INSERT INTO record_ops (id, entity, row_id, ts, device_id, data, synced) VALUES (?,?,?,?,?,?,?)`,
      ['seed-1', 'tag', 't1', String(NOW), 'dev', JSON.stringify({ id: 't1', name: 'one' }), 1],
    );
    d.run(
      `INSERT INTO record_ops (id, entity, row_id, ts, device_id, data, synced) VALUES (?,?,?,?,?,?,?)`,
      ['seed-2', 'tag', 't2', String(NOW), 'dev', JSON.stringify({ id: 't2', name: 'two' }), 1],
    );
    // An update to t1 (existing) must pass even though the cap is full.
    const up = { ...tagOp('t1', 'one-renamed') };
    const out = sanitizeRecordOps(d, 'alice', [up], NOW);
    assert.equal(out.length, 1, 'existing-tag update must not be dropped by the cap');
    assert.equal(out[0].row_id, 't1');
  });

  test('non-tag record ops are untouched by the cap', async () => {
    const { sanitizeRecordOps } = await import('./sync-guard');
    const { createItem } = await import('@carbon/core');
    const d = db();
    // Alice owns the item, so a share of it is authorized.
    const it = createItem(d, 'd', { title: 'it', ownerId: 'alice' });
    const share: RecordOp = {
      id: `r-${Math.round(Math.random() * 1e9)}`,
      entity: 'share',
      row_id: `s:${it.id}:bob`,
      ts: NOW,
      device_id: 'dev',
      data: { item_id: it.id, user_id: 'bob', permission: 'read' },
    };
    const out = sanitizeRecordOps(d, 'alice', [share], NOW);
    // A legitimate owner share is authorized; the cap only touches new-tag creates.
    assert.ok(out.some((o) => o.entity === 'share'), 'share op must pass through');
  });
});
