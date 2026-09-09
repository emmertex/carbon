import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { abbreviateTagPath } from './tagLabel';

describe('abbreviateTagPath', () => {
  test('top-level tag unchanged', () => {
    assert.equal(abbreviateTagPath('important'), 'important');
  });

  test('two levels abbreviates ancestor', () => {
    assert.equal(abbreviateTagPath('Shopping:Coles'), 'S:Coles');
  });

  test('three levels abbreviates ancestors', () => {
    assert.equal(abbreviateTagPath('Shopping:Coles:FreshGoods'), 'S:C:FreshGoods');
  });
});
