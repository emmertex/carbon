import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { validateSyncBody } from './sync-validate';

const okOp = {
  id: 'op-1',
  item_id: 'item-1',
  ts: 1_700_000_000_000,
  device_id: 'dev-1',
  fields: { title: 'x' },
};
const okRec = {
  id: 'rec-1',
  entity: 'share',
  row_id: 'item-1',
  ts: 1_700_000_000_000,
  device_id: 'dev-1',
  data: { item_id: 'item-1', user_id: 'user-1' },
};

describe('validateSyncBody (A2 shape validation)', () => {
  test('accepts an empty object (pull-only)', () => {
    assert.equal(validateSyncBody({}), null);
  });

  test('accepts a well-formed push', () => {
    assert.equal(validateSyncBody({ since: 0, rsince: 0, ops: [okOp], recordOps: [okRec], need: ['item-1'] }), null);
  });

  test('rejects a non-object body', () => {
    assert.match(validateSyncBody(null)!, /object/);
    assert.match(validateSyncBody([])!, /object/);
    assert.match(validateSyncBody('x')!, /object/);
  });

  test('rejects bad cursors', () => {
    assert.match(validateSyncBody({ since: -1 })!, /since/);
    assert.match(validateSyncBody({ since: '0' })!, /since/);
    assert.match(validateSyncBody({ since: NaN })!, /since/);
    assert.match(validateSyncBody({ rsince: -5 })!, /rsince/);
  });

  test('rejects structurally bad ops', () => {
    assert.match(validateSyncBody({ ops: 'nope' })!, /ops must be an array/);
    assert.match(validateSyncBody({ ops: ['x'] })!, /ops\[0\] must be an object/);
    assert.match(validateSyncBody({ ops: [{ ...okOp, item_id: 123 }] })!, /item_id/);
    assert.match(validateSyncBody({ ops: [{ ...okOp, item_id: '' }] })!, /item_id/);
    assert.match(
      validateSyncBody({ ops: [{ ...okOp, item_id: 'x'.repeat(65) }] })!,
      /item_id/,
    );
    assert.match(validateSyncBody({ ops: [{ ...okOp, id: 7 }] })!, /op\.id|id must/);
    assert.match(validateSyncBody({ ops: [{ ...okOp, ts: 'now' }] })!, /ts/);
    assert.match(validateSyncBody({ ops: [{ ...okOp, ts: 1e18 }] })!, /ts/);
    assert.match(validateSyncBody({ ops: [{ ...okOp, fields: [] }] })!, /fields/);
    assert.match(
      validateSyncBody({ ops: [{ ...okOp, fields: { big: 'x'.repeat(2 * 1024 * 1024 + 1) } }] })!,
      /fields\.big/,
    );
    // ts is optional; fields is optional; id is optional
    assert.equal(validateSyncBody({ ops: [{ item_id: 'item-1' }] }), null);
  });

  test('rejects structurally bad recordOps', () => {
    assert.match(validateSyncBody({ recordOps: 5 })!, /recordOps must be an array/);
    assert.match(validateSyncBody({ recordOps: [{}] })!, /entity/);
    assert.match(validateSyncBody({ recordOps: [{ ...okRec, entity: '' }] })!, /entity/);
    assert.match(
      validateSyncBody({ recordOps: [{ ...okRec, entity: 'x'.repeat(33) }] })!,
      /entity/,
    );
    assert.match(validateSyncBody({ recordOps: [{ ...okRec, row_id: 9 }] })!, /row_id/);
    assert.match(validateSyncBody({ recordOps: [{ ...okRec, data: 'x' }] })!, /data/);
    // row_id is an opaque composite key (s:<uuid>:<uuid> = 2+36+1+36 = 75 chars
    // for two UUIDs), so it has its own, larger bound than the 64-char simple-id cap.
    const composite = `s:${'a'.repeat(36)}:${'b'.repeat(36)}`; // 75 chars
    assert.equal(composite.length, 75);
    assert.equal(validateSyncBody({ recordOps: [{ ...okRec, row_id: composite }] }), null);
    assert.match(validateSyncBody({ recordOps: [{ ...okRec, row_id: 'x'.repeat(129) }] })!, /row_id/);
  });

  test('rejects structurally bad need', () => {
    assert.match(validateSyncBody({ need: 'item-1' })!, /need must be an array/);
    assert.match(validateSyncBody({ need: [123] })!, /need\[0\]/);
    assert.match(validateSyncBody({ need: ['x'.repeat(65)] })!, /need\[0\]/);
  });

  test('reports the offending index for array entries', () => {
    assert.match(validateSyncBody({ ops: [okOp, { ...okOp, item_id: null }] })!, /ops\[1\]/);
  });
});
