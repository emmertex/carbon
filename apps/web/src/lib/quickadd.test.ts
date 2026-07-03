import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { parseQuickAdd, parsePriorityWord } from './quickadd';
import type { User } from '@carbon/core';

// Minimal user stubs — only username and id are used by parseQuickAdd.
function user(username: string, id = username): User {
  return {
    id,
    username,
    display_name: null,
    role: 'member',
    is_bot: false,
    avatar_color: null,
    avatar_initial: null,
    plan_startup_min: null,
    plan_default_estimate_min: null,
    is_remote: false,
    home_server: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted: false,
  };
}

// ─── parsePriorityWord ────────────────────────────────────────────────────────

describe('parsePriorityWord()', () => {
  test('recognises numeric shortcuts', () => {
    assert.equal(parsePriorityWord('0'), 0);
    assert.equal(parsePriorityWord('1'), 1);
    assert.equal(parsePriorityWord('2'), 2);
    assert.equal(parsePriorityWord('3'), 3);
  });

  test('recognises word aliases', () => {
    assert.equal(parsePriorityWord('none'), 0);
    assert.equal(parsePriorityWord('low'), 1);
    assert.equal(parsePriorityWord('med'), 2);
    assert.equal(parsePriorityWord('medium'), 2);
    assert.equal(parsePriorityWord('high'), 3);
  });

  test('is case-insensitive', () => {
    assert.equal(parsePriorityWord('HIGH'), 3);
    assert.equal(parsePriorityWord('Med'), 2);
  });

  test('returns undefined for unknown words', () => {
    assert.equal(parsePriorityWord('urgent'), undefined);
    assert.equal(parsePriorityWord(''), undefined);
    assert.equal(parsePriorityWord('4'), undefined);
  });
});

// ─── parseQuickAdd ────────────────────────────────────────────────────────────

describe('parseQuickAdd()', () => {
  const roster: User[] = [user('alice'), user('bob')];

  test('plain text with no tokens is the title', () => {
    const r = parseQuickAdd('Buy milk', roster);
    assert.equal(r.title, 'Buy milk');
    assert.deepEqual(r.tagNames, []);
    assert.deepEqual(r.assigneeIds, []);
    assert.equal(r.priority, undefined);
  });

  test('#tag token is extracted into tagNames', () => {
    const r = parseQuickAdd('Review #work', roster);
    assert.equal(r.title, 'Review');
    assert.deepEqual(r.tagNames, ['work']);
  });

  test('multiple #tags are all extracted', () => {
    const r = parseQuickAdd('Task #home #errands', roster);
    assert.deepEqual(r.tagNames, ['home', 'errands']);
    assert.equal(r.title, 'Task');
  });

  test('duplicate #tags are deduplicated (case-insensitive)', () => {
    const r = parseQuickAdd('#Home do something #home', roster);
    assert.equal(r.tagNames.length, 1);
  });

  test('@known-user token extracted into assigneeIds', () => {
    const r = parseQuickAdd('Follow up @alice', roster);
    assert.equal(r.title, 'Follow up');
    assert.deepEqual(r.assigneeIds, ['alice']);
  });

  test('@unknown-user kept in title as literal text', () => {
    const r = parseQuickAdd('Talk to @charlie', roster);
    assert.ok(r.title.includes('@charlie'), 'unknown user preserved in title');
    assert.deepEqual(r.assigneeIds, []);
  });

  test('@user lookup is case-insensitive', () => {
    const r = parseQuickAdd('Ping @ALICE', roster);
    assert.deepEqual(r.assigneeIds, ['alice']);
    assert.ok(!r.title.includes('@ALICE'));
  });

  test('!priority token sets the priority', () => {
    const r = parseQuickAdd('Urgent task !high', roster);
    assert.equal(r.title, 'Urgent task');
    assert.equal(r.priority, 3);
  });

  test('!low sets priority 1', () => {
    assert.equal(parseQuickAdd('Something !low', roster).priority, 1);
  });

  test('!unknown-priority is kept as literal text', () => {
    const r = parseQuickAdd('!urgent do this', roster);
    assert.ok(r.title.includes('!urgent'), 'unknown priority word kept in title');
    assert.equal(r.priority, undefined);
  });

  test('combined tokens: title + tag + assignee + priority', () => {
    const r = parseQuickAdd('Write report #work @bob !med', roster);
    assert.equal(r.title, 'Write report');
    assert.deepEqual(r.tagNames, ['work']);
    assert.deepEqual(r.assigneeIds, ['bob']);
    assert.equal(r.priority, 2);
  });

  test('empty string produces empty title', () => {
    const r = parseQuickAdd('', roster);
    assert.equal(r.title, '');
  });

  test('only tokens produce empty title', () => {
    const r = parseQuickAdd('#tag !high', roster);
    assert.equal(r.title, '');
    assert.deepEqual(r.tagNames, ['tag']);
    assert.equal(r.priority, 3);
  });
});
