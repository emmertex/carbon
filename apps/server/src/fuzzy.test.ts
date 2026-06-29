import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { normalize, tokens, scoreText, rankBy, bestMatch, ACCEPT } from './fuzzy';

describe('normalize', () => {
  test('lowercases, trims, collapses whitespace', () => {
    assert.equal(normalize('  Shopping   List '), 'shopping list');
  });
  test('drops apostrophes and punctuation but keeps colon', () => {
    assert.equal(normalize("Coles'"), 'coles');
    assert.equal(normalize('Shopping:Coles'), 'shopping:coles');
  });
  test('strips a leading "the"', () => {
    assert.equal(normalize('The Shopping List'), 'shopping list');
  });
});

describe('tokens', () => {
  test('splits on whitespace and colon', () => {
    assert.deepEqual(tokens('Shopping:Coles Fresh'), ['shopping', 'coles', 'fresh']);
  });
});

describe('scoreText bands', () => {
  test('exact beats prefix beats substring beats token-overlap', () => {
    const exact = scoreText('shopping', 'shopping')!;
    const prefix = scoreText('shop', 'shopping')!;
    const substring = scoreText('ppin', 'shopping')!;
    const token = scoreText('milk eggs', 'eggs and bread')!;
    assert.equal(exact.reason, 'exact');
    assert.ok(exact.score > prefix.score, 'exact > prefix');
    assert.ok(prefix.score > substring.score, 'prefix > substring');
    assert.ok(substring.score > token.score, 'substring > token-overlap');
  });

  test('order-independent multi-word via token overlap', () => {
    const s = scoreText('eggs milk', 'milk eggs')!;
    assert.ok(s.score >= ACCEPT, 'reordered words still confident');
  });

  test('typo tolerated via fuzzy band', () => {
    const s = scoreText('shoping list', 'shopping list');
    assert.ok(s && s.score >= ACCEPT, 'single-typo phrase resolves confidently');
  });

  test('single typo keyword matches a multi-word name', () => {
    const s = scoreText('shoping', 'shopping list');
    assert.ok(s && s.score >= ACCEPT, '"shoping" resolves "shopping list"');
  });

  test('returns null for unrelated strings', () => {
    assert.equal(scoreText('xyzzy', 'shopping'), null);
  });
});

describe('tag leaf matching (via multiple keyFns)', () => {
  const tags = [{ name: 'Shopping:Coles' }, { name: 'Work:Email' }];
  test('"coles" resolves to the path whose leaf matches', () => {
    const m = bestMatch('coles', tags, [(t) => t.name, (t) => t.name.split(':').pop()!]);
    assert.equal(m.matched?.item.name, 'Shopping:Coles');
  });
});

describe('bestMatch confidence', () => {
  const lists = [{ name: 'Shopping List' }, { name: 'Reading List' }];

  test('confident single hit', () => {
    const m = bestMatch('shopping', lists, [(l) => l.name]);
    assert.equal(m.matched?.item.name, 'Shopping List');
    assert.equal(m.reason, null);
  });

  test('no match below the floor returns null', () => {
    const m = bestMatch('groceries xyz', lists, [(l) => l.name]);
    assert.equal(m.matched, null);
    assert.equal(m.reason, 'no_match');
  });

  test('ambiguous when two candidates tie closely', () => {
    const ties = [{ name: 'Coles Eastland' }, { name: 'Coles Camberwell' }];
    const m = bestMatch('coles', ties, [(t) => t.name]);
    assert.equal(m.matched, null);
    assert.equal(m.reason, 'ambiguous');
  });
});

describe('rankBy', () => {
  test('sorts by score desc and honours limit', () => {
    const items = [{ n: 'milk' }, { n: 'milkshake' }, { n: 'soy milk' }, { n: 'bread' }];
    const ranked = rankBy('milk', items, [(i) => i.n], { limit: 2 });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].item.n, 'milk');
  });
});
