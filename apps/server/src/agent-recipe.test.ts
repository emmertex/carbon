/**
 * Unit tests for agent-recipe.ts's fence stripper and the timeout classifier that
 * decides whether a failed rewrite is reported as "we hung up" (504) or "the provider
 * errored" (502).
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { stripCodeFence, buildSystem, RECIPE_TIMEOUT_MS } from './agent-recipe';
import { isTimeoutError } from './agents';

describe('isTimeoutError', () => {
  test('the DOMException AbortSignal.timeout produces is a timeout', async () => {
    // Not a hand-built error: drive a real aborted await so the test keeps holding if
    // the runtime ever changes which error name it raises.
    const err = await new Promise<unknown>((resolve) => {
      const signal = AbortSignal.timeout(1);
      signal.addEventListener('abort', () => resolve(signal.reason));
    });
    assert.equal(isTimeoutError(err), true);
  });

  test('an explicit AbortController abort also counts', () => {
    const ac = new AbortController();
    ac.abort();
    assert.equal(isTimeoutError(ac.signal.reason), true);
  });

  test('an ordinary upstream failure does not', () => {
    assert.equal(isTimeoutError(new Error('POST https://api/…: 500 internal error')), false);
    assert.equal(isTimeoutError(new TypeError('fetch failed')), false);
  });

  test('non-Error values do not throw or match', () => {
    for (const v of [null, undefined, 'TimeoutError', { name: 'TimeoutError' }, 42]) {
      assert.equal(isTimeoutError(v), false);
    }
  });
});

describe('RECIPE_TIMEOUT_MS', () => {
  test('is well above the shared LLM budget — a rewrite is the slowest agent call', () => {
    // The bug this guards: at safeFetch's 15s default the request was cancelled while a
    // local reasoning model was still thinking, and surfaced as a provider error.
    assert.ok(RECIPE_TIMEOUT_MS >= 120_000, `expected a generous budget, got ${RECIPE_TIMEOUT_MS}`);
  });
});

describe('buildSystem', () => {
  const p = buildSystem('au');

  test('asks for the sections the client can split on, and no others at that level', () => {
    // The client cuts the ingredient list at the next `##` heading, so these four are
    // the only ones a rewrite may emit at that level.
    for (const section of ['## <title>', '## Procedure', '## Ingredients', '## Notes']) {
      assert.ok(p.includes(section), section);
    }
    assert.match(p, /^### <stage name>/m);
    assert.match(p, /^### <group name>/m);
    assert.match(p, /MUST be "###"/);
  });

  test('preserves notes and parts rather than inventing them', () => {
    assert.match(p, /every note, tip and substitution, under a "## Notes" section/);
    assert.match(p, /ingredient groups \(marinade, coating, sauce\)/);
    assert.match(p, /Add no group, stage or note the recipe does not already have/);
  });

  test('states the convention’s cup size', () => {
    assert.match(buildSystem('us'), /240 mL per cup/);
    assert.match(buildSystem('metric'), /15 mL per tablespoon/);
    assert.match(p, /250 mL per cup/);
  });
});

describe('stripCodeFence', () => {
  test('peels a fence wrapping the whole reply', () => {
    assert.equal(stripCodeFence('```markdown\n## Cake\n\n## Procedure\n```'), '## Cake\n\n## Procedure');
  });

  test('peels an unlabelled fence', () => {
    assert.equal(stripCodeFence('```\n## Cake\n```'), '## Cake');
  });

  test('leaves a recipe that contains its own code block alone', () => {
    // Four fence lines: the reply is not itself fenced, so touching it would corrupt it.
    const md = '## Cake\n\n```\nnotes\n```\n\n```\nmore\n```';
    assert.equal(stripCodeFence(md), md);
  });

  test('leaves an unfenced reply alone', () => {
    assert.equal(stripCodeFence('## Cake\n\n## Procedure'), '## Cake\n\n## Procedure');
  });
});
