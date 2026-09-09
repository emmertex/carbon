import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEmailConfigured } from './email';

// email.ts reads env at module load. Test that the function exists and returns a boolean.
test('isEmailConfigured returns a boolean', () => {
  const result = isEmailConfigured();
  assert.ok(typeof result === 'boolean');
});
