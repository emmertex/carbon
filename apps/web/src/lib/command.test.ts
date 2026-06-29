import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { firstWordIsCommand } from './command';

const KW = ['can', 'add', 'check off', 'mark off', 'mark as'];

describe('firstWordIsCommand', () => {
  test('matches a single-word keyword at the start (case-insensitive)', () => {
    assert.equal(firstWordIsCommand('Add milk and eggs', KW), true);
    assert.equal(firstWordIsCommand('can you add bread', KW), true);
  });
  test('matches multi-word keywords', () => {
    assert.equal(firstWordIsCommand('check off milk', KW), true);
    assert.equal(firstWordIsCommand('Mark Off bread and milk', KW), true);
    assert.equal(firstWordIsCommand('mark as done the laundry', KW), true);
  });
  test('matches the bare keyword alone', () => {
    assert.equal(firstWordIsCommand('add', KW), true);
  });
  test('does not match a keyword as a prefix of a longer word', () => {
    assert.equal(firstWordIsCommand('added milk yesterday', KW), false);
    assert.equal(firstWordIsCommand('candle for the table', KW), false);
  });
  test('does not match when the keyword is not first', () => {
    assert.equal(firstWordIsCommand('buy and add milk', KW), false);
  });
  test('empty / whitespace is not a command', () => {
    assert.equal(firstWordIsCommand('   ', KW), false);
    assert.equal(firstWordIsCommand('add milk', []), false);
  });
});
