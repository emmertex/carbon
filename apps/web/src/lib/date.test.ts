import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMinutes,
  formatDuration,
  fromDateInput,
  toDateInput,
  combineDateTime,
  isAllDay,
  formatDue,
} from './date';

describe('formatMinutes', () => {
  test('less than an hour', () => {
    assert.equal(formatMinutes(15), '15m');
    assert.equal(formatMinutes(59), '59m');
  });

  test('exactly one hour', () => {
    assert.equal(formatMinutes(60), '1h');
  });

  test('more than one hour with remainder', () => {
    assert.equal(formatMinutes(90), '1h 30m');
  });
});

describe('formatDuration', () => {
  test('seconds only', () => {
    assert.equal(formatDuration(45000), '45s');
  });

  test('minutes and seconds', () => {
    assert.equal(formatDuration(120000), '2m 00s');
  });
});

describe('fromDateInput/toDateInput', () => {
  test('round-trip valid date', () => {
    const iso = fromDateInput('2024-01-15');
    assert.ok(iso !== null);
    assert.equal(toDateInput(iso), '2024-01-15');
  });
});

describe('combineDateTime', () => {
  test('date only produces all-day due', () => {
    const iso = combineDateTime('2024-01-15', '');
    assert.ok(iso !== null);
    assert.ok(isAllDay(iso));
  });
});

describe('formatDue', () => {
  test('includes time for non-all-day', () => {
    const iso = combineDateTime('2024-01-15', '10:00');
    const label = formatDue(iso);
    assert.ok(label.includes('10:00'));
  });
});
