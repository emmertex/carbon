import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  isSquareConfigured,
  squareClientConfig,
  planVariationId,
  planForVariation,
  verifyWebhookSignature,
} from './square';

describe('isSquareConfigured', () => {
  test('checks env configuration', () => {
    // Module reads env at load time, so this test verifies the function exists
    // and returns a boolean based on current env state
    const configured = isSquareConfigured();
    assert.ok(typeof configured === 'boolean');
  });
});

describe('squareClientConfig', () => {
  test('returns config object', () => {
    const cfg = squareClientConfig();
    assert.ok(typeof cfg === 'object');
    assert.ok('appId' in cfg);
    assert.ok('locationId' in cfg);
    assert.ok('environment' in cfg);
  });
});

describe('planVariationId / planForVariation', () => {
  test('planVariationId returns string or undefined', () => {
    const id = planVariationId('q3m');
    assert.ok(id === undefined || typeof id === 'string');
  });

  test('planForVariation returns string or undefined', () => {
    const plan = planForVariation('some-variation-id');
    assert.ok(plan === undefined || typeof plan === 'string');
  });
});

describe('verifyWebhookSignature', () => {
  test('returns false when not configured or bad signature', () => {
    assert.equal(verifyWebhookSignature('body', 'wrong-sig'), false);
  });

  test('returns false for undefined signature', () => {
    assert.equal(verifyWebhookSignature('body', undefined), false);
  });
});
