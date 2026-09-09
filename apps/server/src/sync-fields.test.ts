import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { filterOpsByShape, filterRecordOpsByShape, type ShapeReject } from './sync-fields';
import type { Op, RecordOp } from '@carbon/core';

describe('filterOpsByShape', () => {
  const validOp: Op = {
    id: 'op-1',
    item_id: 'item-1',
    ts: 1_700_000_000_000,
    device_id: 'dev-1',
    fields: { title: 'test' },
  };

  test('passes through valid ops', () => {
    const result = filterOpsByShape([validOp]);
    assert.equal(result.ops.length, 1);
    assert.equal(result.rejected.length, 0);
  });

  test('rejects op with missing item_id', () => {
    const bad = { ...validOp, item_id: undefined } as unknown as Op;
    const result = filterOpsByShape([bad]);
    assert.equal(result.ops.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].kind, 'op');
  });

  test('rejects op with missing id', () => {
    const bad = { ...validOp, id: undefined } as unknown as Op;
    const result = filterOpsByShape([bad]);
    assert.equal(result.rejected.length, 1);
  });

  test('rejects op with missing ts', () => {
    const bad = { ...validOp, ts: undefined } as unknown as Op;
    const result = filterOpsByShape([bad]);
    assert.equal(result.rejected.length, 1);
  });

  test('rejects op with missing device_id', () => {
    const bad = { ...validOp, device_id: undefined } as unknown as Op;
    const result = filterOpsByShape([bad]);
    assert.equal(result.rejected.length, 1);
  });

  test('mixed valid and invalid: only valid ops kept', () => {
    const bad = { ...validOp, ts: undefined } as unknown as Op;
    const result = filterOpsByShape([validOp, bad]);
    assert.equal(result.ops.length, 1);
    assert.equal(result.ops[0].id, 'op-1');
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].index, 1);
  });

  test('rejected entry carries its id when available', () => {
    const bad = { ...validOp, ts: undefined, id: 'op-bad' } as unknown as Op;
    const result = filterOpsByShape([bad]);
    assert.equal(result.rejected[0].id, 'op-bad');
  });
});

describe('filterRecordOpsByShape', () => {
  const validRec: RecordOp = {
    id: 'rec-1',
    entity: 'share',
    row_id: 'item-1:user-1',
    ts: 1_700_000_000_000,
    device_id: 'dev-1',
    data: {
      id: 'item-1:user-1', item_id: 'item-1', user_id: 'user-1', permission: 'read',
      created_at: '2026-09-09T00:00:00.000Z', updated_at: '2026-09-09T00:00:00.000Z', deleted: false,
    },
  };

  test('passes through valid record ops', () => {
    const result = filterRecordOpsByShape([validRec]);
    assert.equal(result.ops.length, 1);
    assert.equal(result.rejected.length, 0);
  });

  test('rejects record op with missing id', () => {
    const bad = { ...validRec, id: undefined } as unknown as RecordOp;
    const result = filterRecordOpsByShape([bad]);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].kind, 'recordOp');
  });

  test('rejects record op with missing entity', () => {
    const bad = { ...validRec, entity: undefined } as unknown as RecordOp;
    const result = filterRecordOpsByShape([bad]);
    assert.equal(result.rejected.length, 1);
  });

  test('rejects record op with missing row_id', () => {
    const bad = { ...validRec, row_id: undefined } as unknown as RecordOp;
    const result = filterRecordOpsByShape([bad]);
    assert.equal(result.rejected.length, 1);
  });

  test('rejects record op with missing ts', () => {
    const bad = { ...validRec, ts: undefined } as unknown as RecordOp;
    const result = filterRecordOpsByShape([bad]);
    assert.equal(result.rejected.length, 1);
  });

  test('record op with missing device_id is rejected', () => {
    const noDevice = { ...validRec, device_id: undefined } as unknown as RecordOp;
    const result = filterRecordOpsByShape([noDevice]);
    assert.equal(result.ops.length, 0);
    assert.match(result.rejected[0].reason, /device_id/);
  });

  test('rejects record op with missing data', () => {
    const bad = { ...validRec, data: undefined } as unknown as RecordOp;
    const result = filterRecordOpsByShape([bad]);
    assert.equal(result.rejected.length, 1);
  });
});
