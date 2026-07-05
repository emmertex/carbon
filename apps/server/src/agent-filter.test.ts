/**
 * Unit tests for agent-filter.ts's JSON-fallback extraction helper.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { extractJsonObject } from './agent-filter';

describe('extractJsonObject', () => {
  test('extracts a simple balanced object', () => {
    const out = extractJsonObject('sure, here you go: {"expr":{"type":"cond","cond":{"kind":"flagged"}}} thanks');
    assert.deepEqual(out, { expr: { type: 'cond', cond: { kind: 'flagged' } } });
  });

  test('a string value containing braces does not mis-extract the JSON', () => {
    // titleContains text "{not json}" has a brace pair inside a string literal — naive
    // depth-counting would close the object one character early and fail to parse.
    const text = '{"expr":{"type":"cond","cond":{"kind":"titleContains","text":"{not json}"}}}';
    const out = extractJsonObject(text) as { expr: { cond: { text: string } } };
    assert.equal(out.expr.cond.text, '{not json}');
  });

  test('an escaped quote inside a string does not end the string early', () => {
    const text = String.raw`{"expr":{"type":"cond","cond":{"kind":"titleContains","text":"say \"hi\" {done}"}}}`;
    const out = extractJsonObject(text) as { expr: { cond: { text: string } } };
    assert.equal(out.expr.cond.text, 'say "hi" {done}');
  });

  test('no opening brace → null', () => {
    assert.equal(extractJsonObject('no json here'), null);
  });

  test('unbalanced braces → null', () => {
    assert.equal(extractJsonObject('{"a": 1'), null);
  });
});
