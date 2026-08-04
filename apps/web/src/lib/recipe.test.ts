import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  CONVENTIONS,
  RECIPE_TEMPLATE,
  parseServes,
  scaleProse,
  scaleRecipe,
  splitRecipe,
} from './recipe';
import type { CupConvention, RecipeIssue, ScaleOptions, UnitMode } from './recipe';

const ONE: ScaleOptions = { factor: 1, units: 'original', convention: 'au' };

function opts(factor: number, extra: Partial<ScaleOptions> = {}): ScaleOptions {
  return { ...ONE, factor, ...extra };
}

/** Scale a single ingredient line inside a minimal, valid recipe. */
function ing(line: string, factor = 1, extra: Partial<ScaleOptions> = {}): string {
  const md = `## Ingredients\nServes: 4\n${line}\n`;
  return scaleRecipe(md, opts(factor, extra)).text.split('\n')[2]!;
}

function prose(text: string, factor = 1, extra: Partial<ScaleOptions> = {}): string {
  return scaleProse(text, opts(factor, extra)).text;
}

function issuesFor(body: string, factor = 1): RecipeIssue[] {
  return scaleRecipe(`## Ingredients\n${body}\n`, opts(factor)).issues;
}

// ─── splitRecipe ──────────────────────────────────────────────────────────────

describe('splitRecipe()', () => {
  test('splits at `## Ingredients`', () => {
    const r = splitRecipe('intro\n\n## Ingredients\n* 1 cup flour\n');
    assert.equal(r.head, 'intro\n\n');
    assert.equal(r.heading, '## Ingredients\n');
    assert.equal(r.body, '* 1 cup flour\n');
    assert.equal(r.tail, '');
  });

  test('keeps `###` ingredient groups inside the section', () => {
    const md = '## Ingredients\nServes: 4\n\n### Marinade\n* 1 cup curd\n\n### To coat\n* 2 tbsp rice flour\n';
    const r = splitRecipe(md);
    assert.equal(r.body, md.slice('## Ingredients\n'.length));
    assert.equal(r.tail, '');
  });

  test('ends the section at a `## Notes` heading', () => {
    const r = splitRecipe('## Ingredients\n* 1 cup flour\n\n## Notes\n* keeps 3 days\n');
    assert.equal(r.body, '* 1 cup flour\n\n');
    assert.equal(r.tail, '## Notes\n* keeps 3 days\n');
  });

  test('ends the section at any heading of its own level or above', () => {
    const r = splitRecipe('## Ingredients\n* 1 cup flour\n## Procedure\n1. mix\n');
    assert.equal(r.body, '* 1 cup flour\n');
    assert.equal(r.tail, '## Procedure\n1. mix\n');
    const deeper = splitRecipe('### Ingredients\n* 1 cup flour\n## Notes\n* x\n');
    assert.equal(deeper.body, '* 1 cup flour\n');
    assert.equal(deeper.tail, '## Notes\n* x\n');
  });

  test('a deeper Notes heading still ends the section', () => {
    // `# Ingredients` + `## Notes` is a level mismatch, but the author plainly means
    // two sections; the notes must not land among the ingredients.
    const r = splitRecipe('# Ingredients\n* 1 cup flour\n## Notes\n* x\n');
    assert.equal(r.body, '* 1 cup flour\n');
    assert.equal(r.tail, '## Notes\n* x\n');
  });

  test('a heading inside a code fence does not end the section', () => {
    const md = '## Ingredients\n* 1 cup flour\n\n```\n## Notes\n```\n';
    const r = splitRecipe(md);
    assert.equal(r.body, md.slice('## Ingredients\n'.length));
    assert.equal(r.tail, '');
  });

  test('seven hashes is not a section-ending heading', () => {
    const r = splitRecipe('## Ingredients\n* 1 cup flour\n#######Notes\nx\n');
    assert.equal(r.body, '* 1 cup flour\n#######Notes\nx\n');
    assert.equal(r.tail, '');
  });

  test('accepts hashes with no following space', () => {
    const r = splitRecipe('a\n###Ingredients\nb\n');
    assert.equal(r.heading, '###Ingredients\n');
    assert.equal(r.body, 'b\n');
  });

  test('is case-insensitive', () => {
    assert.equal(splitRecipe('## INGREDIENTS\nb').heading, '## INGREDIENTS\n');
    assert.equal(splitRecipe('# ingredients\nb').heading, '# ingredients\n');
    assert.equal(splitRecipe('###### Ingredients\nb').heading, '###### Ingredients\n');
  });

  test('tolerates surrounding whitespace in the heading text', () => {
    assert.equal(splitRecipe('##   Ingredients   \nb').heading, '##   Ingredients   \n');
  });

  test('seven hashes is not a heading', () => {
    assert.equal(splitRecipe('#######Ingredients\nb').heading, null);
  });

  test('a heading with trailing words is not a match', () => {
    assert.equal(splitRecipe('## Ingredients list\nb').heading, null);
  });

  test('absent section returns the whole input as head', () => {
    const r = splitRecipe('just a note\n');
    assert.equal(r.head, 'just a note\n');
    assert.equal(r.heading, null);
    assert.equal(r.body, '');
  });

  test('heading at the very start leaves an empty head', () => {
    const r = splitRecipe('## Ingredients\nbody');
    assert.equal(r.head, '');
    assert.equal(r.heading, '## Ingredients\n');
    assert.equal(r.body, 'body');
  });

  test('heading at the very end has no trailing newline and an empty body', () => {
    const r = splitRecipe('head\n## Ingredients');
    assert.equal(r.head, 'head\n');
    assert.equal(r.heading, '## Ingredients');
    assert.equal(r.body, '');
  });

  test('only the first Ingredients heading splits; a second one ends the section', () => {
    const r = splitRecipe('a\n## Ingredients\nb\n## Ingredients\nc\n');
    assert.equal(r.head, 'a\n');
    assert.equal(r.heading, '## Ingredients\n');
    assert.equal(r.body, 'b\n');
    assert.equal(r.tail, '## Ingredients\nc\n');
  });

  test('head + heading + body + tail is lossless for every shape', () => {
    const inputs = [
      '',
      '\n',
      'just a note',
      'just a note\n',
      '## Ingredients',
      '## Ingredients\n',
      '## Ingredients\nbody',
      'head\n## Ingredients\nbody\n',
      'head\n###INGREDIENTS\nbody',
      'a\n## Ingredients\nb\n## Ingredients\nc',
      '#######Ingredients\nnope',
      '## Ingredients\n### Group\n* 1 cup flour\n## Notes\n* note\n',
      '## Ingredients\n## Notes',
      '## Ingredients\n\n## Notes\n',
      RECIPE_TEMPLATE,
    ];
    for (const input of inputs) {
      const r = splitRecipe(input);
      assert.equal(r.head + (r.heading ?? '') + r.body + r.tail, input, JSON.stringify(input));
    }
  });
});

// ─── parseServes ──────────────────────────────────────────────────────────────

describe('parseServes()', () => {
  test('finds an integer count', () => {
    assert.deepEqual(parseServes('Serves: 4\n* 1 cup flour\n'), { value: 4, line: 'Serves: 4' });
  });

  test('finds a decimal count', () => {
    assert.equal(parseServes('Serves: 2.5\n')?.value, 2.5);
  });

  test('is case-insensitive and tolerates spacing', () => {
    const r = parseServes('  serves :   6  \n');
    assert.equal(r?.value, 6);
    assert.equal(r?.line, '  serves :   6  ', 'line is returned verbatim');
  });

  test('returns null when absent', () => {
    assert.equal(parseServes('* 1 cup flour\n'), null);
    assert.equal(parseServes('Serves plenty\n'), null);
  });
});

// ─── Number forms ─────────────────────────────────────────────────────────────

describe('number forms', () => {
  test('decimal', () => assert.equal(ing('* 1.5 cups flour', 2), '* 3 cups flour'));
  test('ascii fraction', () => assert.equal(ing('* 1/2 cup flour', 2), '* 1 cup flour'));
  test('mixed ascii fraction', () => assert.equal(ing('* 1 1/2 cups flour', 2), '* 3 cups flour'));
  test('unicode vulgar fraction', () => assert.equal(ing('* ½ cup flour', 2), '* 1 cup flour'));
  test('glued mixed unicode', () => assert.equal(ing('* 1½ cups flour', 2), '* 3 cups flour'));
  test('integer', () => assert.equal(ing('* 2 cups flour', 3), '* 6 cups flour'));

  test('every vulgar glyph parses', () => {
    assert.equal(ing('* ⅓ cup water', 3), '* 1 cup water');
    assert.equal(ing('* ⅔ cup water', 3), '* 2 cups water');
    assert.equal(ing('* ¼ cup water', 4), '* 1 cup water');
    assert.equal(ing('* ¾ cup water', 4), '* 3 cups water');
    assert.equal(ing('* ⅛ cup water', 8), '* 1 cup water');
    assert.equal(ing('* ⅜ cup water', 8), '* 3 cups water');
    assert.equal(ing('* ⅝ cup water', 8), '* 5 cups water');
    assert.equal(ing('* ⅞ cup water', 8), '* 7 cups water');
  });

  test('hyphen range keeps its separator', () => {
    assert.equal(ing('* 2-3 cups flour', 2), '* 4-6 cups flour');
  });

  test('en dash range keeps its separator', () => {
    assert.equal(ing('* 2–3 cups flour', 2), '* 4–6 cups flour');
  });

  test('"to" range keeps its separator', () => {
    assert.equal(ing('* 2 to 3 cups flour', 2), '* 4 to 6 cups flour');
  });

  test('a range pluralises off its upper endpoint', () => {
    assert.equal(ing('* 2-4 cups flour', 0.5), '* 1-2 cups flour');
  });

  test('a range of mixed fractions scales both ends', () => {
    assert.equal(ing('* 1 1/2 to 2 1/2 cups flour', 2), '* 3 to 5 cups flour');
  });
});

// ─── Unit aliases ─────────────────────────────────────────────────────────────

describe('unit aliases', () => {
  // ×0.33 is the discriminator throughout: a recognised spoon snaps to ⅓,
  // an unrecognised word leaves a bare count of 0.33.
  test('tsp family', () => {
    assert.equal(ing('* 1 tsp salt', 0.33), '* ⅓ tsp salt');
    assert.equal(ing('* 1 tsps salt', 0.33), '* ⅓ tsps salt');
    assert.equal(ing('* 1 teaspoon salt', 0.33), '* ⅓ teaspoon salt');
    // The alias family is preserved but the plural follows the *result*, so the
    // author's `teaspoons` comes back singular below 1.
    assert.equal(ing('* 1 teaspoons salt', 0.33), '* ⅓ teaspoon salt');
    assert.equal(ing('* 1 teaspoon salt', 3), '* 3 teaspoons salt');
  });

  test('tbsp family', () => {
    assert.equal(ing('* 1 tbsp oil', 0.5), '* ½ tbsp oil');
    assert.equal(ing('* 1 tbsps oil', 0.5), '* ½ tbsps oil');
    assert.equal(ing('* 1 tbs oil', 0.5), '* ½ tbs oil');
    assert.equal(ing('* 1 tablespoon oil', 0.5), '* ½ tablespoon oil');
    assert.equal(ing('* 2 tablespoons oil', 0.5), '* 1 tablespoon oil');
  });

  test('cup family', () => {
    assert.equal(ing('* 1 cup milk', 2), '* 2 cups milk');
    assert.equal(ing('* 2 cups milk', 0.5), '* 1 cup milk');
  });

  test('millilitre family', () => {
    assert.equal(ing('* 100 ml water', 2), '* 200 ml water');
    assert.equal(ing('* 100 mL water', 2), '* 200 mL water');
    assert.equal(ing('* 1 millilitre water', 2), '* 2 millilitres water');
    assert.equal(ing('* 1 milliliter water', 2), '* 2 milliliters water');
    assert.equal(ing('* 2 millilitres water', 0.5), '* 1 millilitre water');
  });

  test('litre family', () => {
    assert.equal(ing('* 2 L stock', 0.5), '* 1 L stock');
    assert.equal(ing('* 2 l stock', 0.5), '* 1 l stock');
    assert.equal(ing('* 1 litre stock', 2), '* 2 litres stock');
    assert.equal(ing('* 1 liter stock', 2), '* 2 liters stock');
  });

  test('gram family', () => {
    assert.equal(ing('* 100 g flour', 2), '* 200 g flour');
    assert.equal(ing('* 1 gram salt', 2), '* 2 grams salt');
    assert.equal(ing('* 2 grams salt', 0.5), '* 1 gram salt');
  });

  test('kilogram family', () => {
    assert.equal(ing('* 1 kg flour', 2), '* 2 kg flour');
    assert.equal(ing('* 1 kilogram flour', 2), '* 2 kilograms flour');
  });

  test('a unit glued to the number still matches', () => {
    assert.equal(ing('* 250g flour', 2), '* 500 g flour');
  });

  test('abbreviations are never pluralised', () => {
    assert.equal(ing('* 1 tsp salt', 4), '* 4 tsp salt');
    assert.equal(ing('* 1 g salt', 4), '* 4 g salt');
    assert.equal(ing('* 1 kg flour', 4), '* 4 kg flour');
  });

  test('a fraction below 1 stays singular', () => {
    assert.equal(ing('* 1 cup milk', 0.5), '* ½ cup milk');
    assert.equal(ing('* 2 grams salt', 0.25), '* 0.5 gram salt');
  });

  test('spelled-out units keep the authors capitalisation', () => {
    assert.equal(ing('* 1 Cup milk', 2), '* 2 Cups milk');
    assert.equal(ing('* 1 CUP milk', 2), '* 2 CUPS milk');
  });

  test('bare t/T/c/C are deliberately rejected', () => {
    assert.equal(ing('* 1 c salt', 0.33), '* 0.33 c salt');
    assert.equal(ing('* 1 C salt', 0.33), '* 0.33 C salt');
    assert.equal(ing('* 1 t salt', 0.33), '* 0.33 t salt');
    assert.equal(ing('* 1 T salt', 0.33), '* 0.33 T salt');
  });

  test('units only match at a word boundary', () => {
    // `g` must not eat the front of `grammes`/`gravy`, nor `l` the front of `large`.
    assert.equal(ing('* 1 grammes cheese', 0.33), '* 0.33 grammes cheese');
    assert.equal(ing('* 1 gravy boat', 0.33), '* 0.33 gravy boat');
    assert.equal(ing('* 2 large eggs', 0.33), '* 0.66 large eggs');
    assert.equal(ing('* 1 loaf bread', 0.33), '* 0.33 loaf bread');
    assert.equal(ing('* 1 cupcake', 0.33), '* 0.33 cupcake');
  });
});

// ─── Spoon / cup rounding ─────────────────────────────────────────────────────

describe('spoon and cup rounding', () => {
  test('a clean result at or above 1/4 stays in its unit', () => {
    assert.equal(ing('* 2 cups flour', 0.5), '* 1 cup flour');
    assert.equal(ing('* 1 tbsp oil', 0.5), '* ½ tbsp oil');
    assert.equal(ing('* 1 tbsp oil', 0.25), '* ¼ tbsp oil');
  });

  test('tsp is terminal and emits the best available snap', () => {
    assert.equal(ing('* 1 tsp salt', 0.33), '* ⅓ tsp salt');
  });

  test('snapping to 1 carries into the integer part', () => {
    assert.equal(ing('* 1 cup flour', 2.99), '* 3 cups flour');
    assert.equal(ing('* 1 cup flour', 0.99), '* 1 cup flour');
  });

  test('an unclean result steps down a rung', () => {
    // 0.4 cup is 0.025 away from 3/8 — further than 1/64 — so it becomes 5 tbsp.
    assert.equal(ing('* 1 cup flour', 0.4), '* 5 tbsp flour');
  });

  test('a clean result below 1/4 still steps down', () => {
    assert.equal(ing('* 1 tbsp oil', 0.125), '* ½ tsp oil');
  });

  test('1 cup ×0.125 lands on 6¼ tsp under AU', () => {
    // The source plan's worked example claimed 1½ tbsp here. Following the rule
    // instead: 1/8 cup is clean but under 1/4, so it steps to 31.25/20 = 1.5625
    // tbsp, whose 0.5625 fraction sits exactly halfway between ½ and ⅝ and is
    // therefore not clean, so it steps again to 31.25/5 = 6.25 tsp = 6¼.
    assert.equal(ing('* 1 cup flour', 0.125), '* 6¼ tsp flour');
  });

  test('1 cup ×0.125 differs by convention', () => {
    assert.equal(ing('* 1 cup flour', 0.125, { convention: 'us' }), '* 2 tbsp flour');
    // Metric: 31.25 mL ≈ 2.08 tbsp, so half-tsp resolution applies and the
    // exact midpoint between 6 and 6½ resolves downward.
    assert.equal(ing('* 1 cup flour', 0.125, { convention: 'metric' }), '* 6 tsp flour');
  });

  test('1 cup ×0.4 differs by convention', () => {
    assert.equal(ing('* 1 cup flour', 0.4, { convention: 'au' }), '* 5 tbsp flour');
    // US: 6.4 tbsp is past the ½-tbsp band, so it stays as a clean tablespoon
    // rather than cascading to an uncountable tsp pile.
    assert.equal(ing('* 1 cup flour', 0.4, { convention: 'us' }), '* 6½ tbsp flour');
    // Metric lands on exactly 6⅔ tbsp, but past 5 tbsp the half-tbsp band wins.
    assert.equal(ing('* 1 cup flour', 0.4, { convention: 'metric' }), '* 6½ tbsp flour');
  });

  test('½ cup is the same under every convention', () => {
    for (const convention of ['au', 'us', 'metric'] as CupConvention[]) {
      assert.equal(ing('* 1 cup milk', 0.5, { convention }), '* ½ cup milk', convention);
    }
  });

  test('units never step up', () => {
    // An AU cup is 12.5 tbsp, so promoting 8 tbsp to 2/3 cup would lose 6 mL.
    assert.equal(ing('* 16 tbsp butter', 0.5), '* 8 tbsp butter');
    assert.equal(ing('* 12 tsp salt', 0.5), '* 6 tsp salt');
  });
});

// ─── Metric rounding ──────────────────────────────────────────────────────────

describe('metric rounding', () => {
  test('below 10 keeps one decimal', () => {
    assert.equal(ing('* 19 g yeast', 0.5), '* 9.5 g yeast');
  });

  test('10 to 99 rounds to a whole number', () => {
    assert.equal(ing('* 21 g yeast', 2), '* 42 g yeast');
    assert.equal(ing('* 85 g butter', 0.5), '* 43 g butter');
  });

  test('100 and above rounds to the nearest 5', () => {
    assert.equal(ing('* 474 g flour', 0.5), '* 235 g flour');
    assert.equal(ing('* 250 mL milk', 0.5), '* 125 mL milk');
    assert.equal(ing('* 200 g flour', 1.5), '* 300 g flour');
  });

  test('trailing .0 is stripped', () => {
    assert.equal(ing('* 6 g salt', 0.5), '* 3 g salt');
  });

  test('metric never uses fractions', () => {
    assert.equal(ing('* 100 g flour', 1 / 3), '* 33 g flour');
  });
});

// ─── Counts ───────────────────────────────────────────────────────────────────

describe('counts with no unit', () => {
  test('rounds to at most 2 decimals', () => {
    assert.equal(ing('* 2 eggs', 1.5), '* 3 eggs');
    assert.equal(ing('* 3 eggs', 0.5), '* 1.5 eggs');
    assert.equal(ing('* 1 onion, diced', 1 / 3), '* 0.33 onion, diced');
  });

  test('trailing zeros are stripped', () => {
    assert.equal(ing('* 2 eggs', 2), '* 4 eggs');
  });

  test('a count range scales both ends', () => {
    assert.equal(ing('* 2-3 eggs', 2), '* 4-6 eggs');
  });
});

// ─── Unit conversion ──────────────────────────────────────────────────────────

describe('unit conversion', () => {
  test('mlCups converts cups only', () => {
    assert.equal(ing('* 2 cups milk', 1, { units: 'mlCups' }), '* 500 mL milk');
    assert.equal(ing('* 2 cups milk', 0.5, { units: 'mlCups' }), '* 250 mL milk');
    assert.equal(ing('* 1 tbsp oil', 2, { units: 'mlCups' }), '* 2 tbsp oil');
    assert.equal(ing('* 1 tsp salt', 2, { units: 'mlCups' }), '* 2 tsp salt');
  });

  test('mlAll converts cups and spoons', () => {
    assert.equal(ing('* 1 tbsp oil', 1, { units: 'mlAll' }), '* 20 mL oil');
    assert.equal(ing('* 1 tsp salt', 1, { units: 'mlAll' }), '* 5 mL salt');
    assert.equal(ing('* 2 cups milk', 1, { units: 'mlAll' }), '* 500 mL milk');
  });

  test('conversion follows the active convention', () => {
    assert.equal(ing('* 2 cups milk', 1, { units: 'mlCups', convention: 'us' }), '* 480 mL milk');
    assert.equal(ing('* 2 cups milk', 1, { units: 'mlCups', convention: 'metric' }), '* 500 mL milk');
    assert.equal(ing('* 1 tbsp oil', 1, { units: 'mlAll', convention: 'us' }), '* 15 mL oil');
  });

  test('conversion happens after scaling', () => {
    assert.equal(ing('* 1 cup milk', 3, { units: 'mlCups' }), '* 750 mL milk');
  });

  test('neither mode touches metric units', () => {
    for (const units of ['mlCups', 'mlAll'] as UnitMode[]) {
      assert.equal(ing('* 250 g flour', 2, { units }), '* 500 g flour', units);
      assert.equal(ing('* 100 mL water', 2, { units }), '* 200 mL water', units);
      assert.equal(ing('* 1 L stock', 2, { units }), '* 2 L stock', units);
      assert.equal(ing('* 1 kg flour', 2, { units }), '* 2 kg flour', units);
    }
  });

  test('unknown units survive conversion untouched', () => {
    assert.equal(ing('* 4 oz butter', 2, { units: 'mlAll' }), '* 4 oz butter');
  });

  test('converted output never promotes mL to L', () => {
    assert.equal(ing('* 8 cups stock', 1, { units: 'mlCups' }), '* 2000 mL stock');
  });
});

// ─── Prose ────────────────────────────────────────────────────────────────────

describe('scaleProse()', () => {
  test('scales a number followed by a whitelisted unit', () => {
    assert.equal(prose('Pour in 1 cup of stock.', 2), 'Pour in 2 cups of stock.');
    assert.equal(prose('Whisk 2 tsp of salt in.', 0.5), 'Whisk 1 tsp of salt in.');
  });

  test('leaves temperatures, times and tin sizes alone', () => {
    const text = 'Bake at 180 °C for 30 minutes in a 20 cm tin, or 350F.';
    assert.equal(prose(text, 2), text);
  });

  test('leaves bare numbers alone', () => {
    assert.equal(prose('Repeat 3 times, then rest 2 more.', 2), 'Repeat 3 times, then rest 2 more.');
  });

  test('does not touch a fenced code block', () => {
    const md = 'Heat 1 cup.\n\n```\nadd 1 cup\n```\n\nStir 1 cup.\n';
    assert.equal(prose(md, 2), 'Heat 2 cups.\n\n```\nadd 1 cup\n```\n\nStir 2 cups.\n');
  });

  test('an unterminated fence protects the rest of the document', () => {
    const md = 'Heat 1 cup.\n\n```\nadd 1 cup\n';
    assert.equal(prose(md, 2), 'Heat 2 cups.\n\n```\nadd 1 cup\n');
  });

  test('does not touch an inline code span', () => {
    assert.equal(
      prose('Type `1 cup` exactly, then add 1 cup.', 2),
      'Type `1 cup` exactly, then add 2 cups.',
    );
  });

  test('does not touch a link or image target, but does scale its text', () => {
    // Sanity check: the same target text scales fine when it is not a link.
    assert.equal(prose('chart-2cups.png', 2), 'chart-4 cups.png');
    assert.equal(prose('See [2 cups](chart-2cups.png).', 2), 'See [4 cups](chart-2cups.png).');
    assert.equal(prose('![1 cup](img-2cups.png)', 2), '![2 cups](img-2cups.png)');
  });

  test('applies unit conversion for consistency with ingredients', () => {
    assert.equal(prose('Add 1 cup water.', 1, { units: 'mlCups' }), 'Add 250 mL water.');
    assert.equal(prose('Add 1 tbsp oil.', 1, { units: 'mlAll' }), 'Add 20 mL oil.');
  });

  test('never reports issues', () => {
    assert.deepEqual(scaleProse('* salt to taste\n4 oz butter', opts(2)).issues, []);
  });

  test('factor 1 is a no-op', () => {
    const md = 'Add 1 1/2 cups flour and 2 tsp salt.';
    assert.equal(prose(md, 1), md);
  });
});

// ─── Issues ───────────────────────────────────────────────────────────────────

describe('issue reporting', () => {
  test('a recognised-but-unconvertible unit is reported and passed through', () => {
    assert.deepEqual(issuesFor('Serves: 4\n* 4 oz butter'), [
      { line: '* 4 oz butter', reason: 'unknown-unit' },
    ]);
    assert.equal(ing('* 4 oz butter', 2), '* 4 oz butter');
  });

  test('every unconvertible alias is recognised', () => {
    for (const unit of ['oz', 'fl oz', 'lb', 'lbs', 'pound', 'pounds', 'pint', 'pints', 'quart', 'quarts', 'stick', 'sticks']) {
      const line = `* 2 ${unit} butter`;
      assert.deepEqual(issuesFor(`Serves: 4\n${line}`), [{ line, reason: 'unknown-unit' }], unit);
      assert.equal(ing(line, 2), line, unit);
    }
  });

  test('a bullet with no derivable amount is reported', () => {
    assert.deepEqual(issuesFor('Serves: 4\n* salt to taste'), [
      { line: '* salt to taste', reason: 'unparseable-amount' },
    ]);
  });

  test('blank bullets and the template placeholder are not reported', () => {
    assert.deepEqual(issuesFor('Serves: 4\n* .\n* \n*\n\nMix well.'), []);
  });

  test('a missing Serves line is reported once', () => {
    assert.deepEqual(issuesFor('* 1 cup flour'), [{ line: '', reason: 'no-serves-line' }]);
  });

  test('a missing Ingredients section is reported once', () => {
    const r = scaleRecipe('Just a note with 1 cup of stock.', opts(2));
    assert.deepEqual(r.issues, [{ line: '', reason: 'no-ingredients-section' }]);
    assert.equal(r.text, 'Just a note with 2 cups of stock.', 'the whole note is still prose-scaled');
  });

  test('issues are independent of the factor', () => {
    const body = 'Serves: 4\n* 4 oz butter\n* salt to taste';
    assert.deepEqual(issuesFor(body, 1), issuesFor(body, 2));
    assert.deepEqual(issuesFor(body, 1), issuesFor(body, 0.5));
    assert.equal(issuesFor(body, 1).length, 2);
  });

  test('non-bullet prose in the ingredients body is not reported', () => {
    assert.deepEqual(issuesFor('Serves: 4\n\nUse the good butter.\n\n### Sauce\n* 1 cup cream'), []);
  });
});

// ─── Serves rewriting ─────────────────────────────────────────────────────────

describe('Serves rewriting', () => {
  function serves(base: string, factor: number): string {
    const md = `## Ingredients\n${base}\n* 1 cup flour\n`;
    return scaleRecipe(md, opts(factor)).text.split('\n')[1]!;
  }

  test('scales to the target count', () => {
    assert.equal(serves('Serves: 4', 2), 'Serves: 8');
    assert.equal(serves('Serves: 4', 0.5), 'Serves: 2');
    assert.equal(serves('Serves: 3', 0.5), 'Serves: 2');
  });

  test('keeps one decimal rather than rounding to zero', () => {
    assert.equal(serves('Serves: 4', 0.1), 'Serves: 0.4');
  });

  test('preserves the rest of the line', () => {
    assert.equal(serves('Serves: 4 hungry people', 2), 'Serves: 8 hungry people');
  });

  test('is untouched at factor 1', () => {
    assert.equal(serves('Serves: 4', 1), 'Serves: 4');
  });

  test('a range scales both of its ends', () => {
    // Scaling only the first number produces a descending range — a result that
    // is not merely unscaled but self-contradictory.
    assert.equal(serves('Serves: 4-6', 2), 'Serves: 8-12');
    assert.equal(serves('Serves: 4 to 6', 2), 'Serves: 8 to 12');
    assert.equal(serves('Serves: 4–6', 0.5), 'Serves: 2–3');
    assert.equal(serves('Serves: 4-6 hungry people', 2), 'Serves: 8-12 hungry people');
  });

  test('a range is anchored on its lower bound', () => {
    assert.deepEqual(parseServes('Serves: 4-6\n'), { value: 4, line: 'Serves: 4-6' });
  });

  test('a count that does not move keeps the authors spelling', () => {
    // The rewriter must not re-render at factor 1: `Serves: 2.5` is a real
    // half-serving recipe and rounding it to 3 is silent data loss.
    assert.equal(serves('Serves: 2.5', 1), 'Serves: 2.5');
    assert.equal(serves('Serves: 4.0', 1), 'Serves: 4.0');
    assert.equal(serves('Serves: 04', 1), 'Serves: 04');
    assert.equal(serves('Serves: 0', 1), 'Serves: 0');
    assert.equal(serves('Serves: 4-6', 1), 'Serves: 4-6');
  });

  test('a half serving still scales', () => {
    assert.equal(serves('Serves: 2.5', 2), 'Serves: 5');
  });
});

// ─── Recipes with parts ───────────────────────────────────────────────────────

describe('grouped ingredients and a Notes section', () => {
  const md = [
    '## Chicken 65',
    '',
    '## Procedure',
    '',
    '### Marination',
    '',
    '1. Mix the chicken with 4 tbsp curd and rest it 1 hour.',
    '',
    '### Temper',
    '',
    '1. Fry 2 sprigs of curry leaves until crisp.',
    '',
    '## Ingredients',
    'Serves: 4',
    '',
    '### Marination',
    '',
    '* 600 g chicken thigh',
    '* 4 tbsp curd',
    '',
    '### To coat',
    '',
    '* 4 tbsp cornflour',
    '* 2 tbsp rice flour',
    '',
    '## Notes',
    '',
    '* Bone-in chicken needs 4-6 hours of marination, not 1.',
    '* Use 2 tbsp curd in place of the egg white.',
    '',
  ].join('\n');

  test('is byte-identical at factor 1', () => {
    assert.equal(scaleRecipe(md, ONE).text, md);
  });

  test('scales each group and leaves the group headings alone', () => {
    const out = scaleRecipe(md, opts(2)).text;
    assert.match(out, /^### Marination$/m);
    assert.match(out, /^### To coat$/m);
    assert.match(out, /\* 1200 g chicken thigh/);
    assert.match(out, /\* 8 tbsp curd/);
    assert.match(out, /\* 8 tbsp cornflour/);
    assert.match(out, /\* 4 tbsp rice flour/);
    assert.match(out, /Serves: 8/);
  });

  test('reports nothing — group headings are not ingredient bullets, notes are not either', () => {
    assert.deepEqual(scaleRecipe(md, opts(2)).issues, []);
  });

  test('notes scale as prose, so their amounts track the servings', () => {
    const out = scaleRecipe(md, opts(2)).text;
    assert.match(out, /^## Notes$/m);
    // A whitelisted unit moves; the "4-6 hours" of marination is not a quantity.
    assert.match(out, /Use 4 tbsp curd in place of the egg white/);
    assert.match(out, /Bone-in chicken needs 4-6 hours of marination, not 1\./);
  });

  test('a Serves line inside Notes is neither the recipe’s count nor rewritten', () => {
    const note = '## Ingredients\n* 1 cup flour\n\n## Notes\n* Serves: 4 as a side.\n';
    const r = scaleRecipe(note, opts(2));
    assert.deepEqual(r.issues, [{ line: '', reason: 'no-serves-line' }]);
    assert.match(r.text, /\* Serves: 4 as a side\./);
    assert.match(r.text, /\* 2 cups flour/);
  });
});

// ─── Template ─────────────────────────────────────────────────────────────────

describe('RECIPE_TEMPLATE', () => {
  test('is the exact expected string', () => {
    assert.equal(RECIPE_TEMPLATE, '## \n\n## Procedure\n\n## Ingredients\nServes: 4\n\n* .\n');
  });

  test('is issue-free and stable at factor 1', () => {
    const r = scaleRecipe(RECIPE_TEMPLATE, ONE);
    assert.equal(r.text, RECIPE_TEMPLATE);
    assert.deepEqual(r.issues, []);
  });

  test('scales its Serves line', () => {
    assert.ok(scaleRecipe(RECIPE_TEMPLATE, opts(2)).text.includes('Serves: 8'));
  });
});

describe('CONVENTIONS', () => {
  test('holds the documented millilitre values', () => {
    assert.deepEqual(CONVENTIONS.au, { cup: 250, tbsp: 20, tsp: 5 });
    assert.deepEqual(CONVENTIONS.us, { cup: 240, tbsp: 15, tsp: 5 });
    assert.deepEqual(CONVENTIONS.metric, { cup: 250, tbsp: 15, tsp: 5 });
  });
});

// ─── Whole-document invariants ────────────────────────────────────────────────

// Deliberately messy: `1 1/2 tbsp` is a spelling the formatter would never emit,
// so it proves factor 1 leaves the author's own text alone rather than
// re-punctuating it to `1½ tbsp`.
const MESSY = [
  '# Pancakes',
  '',
  'Serves a crowd. Ready in 30 minutes.',
  '',
  '## Procedure',
  '',
  '1. Whisk 1½ cups flour with 2 tsp baking powder.',
  '2. Bake at 180 °C for 20 minutes.',
  '',
  '## Ingredients',
  'Serves: 4',
  '',
  '* 1½ cups plain flour',
  '* 2 tsp baking powder',
  '* 250 mL milk',
  '* 2 eggs',
  '* ½ tsp salt',
  '* 1 1/2 tbsp melted butter',
  '* 4 oz dark chocolate',
  '* salt to taste',
  '* .',
  '',
].join('\n');

// Canonical spellings only, so the formatter reproduces it exactly on the way back.
const CANONICAL = [
  '# Pancakes',
  '',
  '## Procedure',
  '',
  'Whisk 1½ cups flour into 250 mL milk.',
  '',
  '## Ingredients',
  'Serves: 4',
  '',
  '* 1½ cups plain flour',
  '* 2 tsp baking powder',
  '* 250 mL milk',
  '* 2 eggs',
  '* ½ tsp salt',
  '* 4 oz dark chocolate',
  '* .',
  '',
].join('\n');

describe('idempotence', () => {
  test('factor 1 returns a realistic recipe byte for byte', () => {
    assert.equal(scaleRecipe(MESSY, ONE).text, MESSY);
  });

  test('factor 1 is byte-exact for every convention', () => {
    for (const convention of ['au', 'us', 'metric'] as CupConvention[]) {
      assert.equal(scaleRecipe(MESSY, opts(1, { convention })).text, MESSY, convention);
    }
  });

  test('factor 1 is byte-exact for assorted inputs', () => {
    const inputs = [
      '',
      'plain note',
      RECIPE_TEMPLATE,
      CANONICAL,
      '## Ingredients\n* 2-3 cups flour\n',
      '## Ingredients\nServes: 4\n* 0.75 cup sugar\n',
      // Shapes that used to be rewritten, mangled or dropped on a no-op pass.
      '## Ingredients\nServes: 2.5\n* 1 ½ cups flour\n',
      '## Ingredients\nServes: 4-6\n* ⅙ tsp salt\n',
      '## Ingredients\nServes: 4\n* 1 cup flour\n',
      '## Ingredients\nServes: 4\n* 2-inch piece of ginger\n',
      '## Ingredients\nServes: 4\n* 1 1/2/3 cups flour\n',
      '## Ingredients\nServes: 4\n* 0/0 cups flour\n',
      '## Ingredients\nServes: 4\n* **2 cups** flour\n',
      '## Ingredients\nServes: 4\n| 2 cups | flour |\n',
      '## Ingredients\nServes: 4\n* 1 cup (250 mL) milk\n',
      '## Ingredients\nServes: 4\n* 2 cups flour `sifted`\n',
      '## Ingredients\r\nServes: 4\r\n* 2 cups flour\r\n',
      'Doc:\n\n```md\n## Ingredients\n* 1 cup flour\n```\n\n## Ingredients\nServes: 4\n* 2 cups flour\n',
      '[f]: http://e.com/c-2cups.png\n\n## Ingredients\nServes: 4\n* 1 cup flour\n',
    ];
    for (const input of inputs) {
      assert.equal(scaleRecipe(input, ONE).text, input, JSON.stringify(input));
      assert.equal(scaleProse(input, ONE).text, input, JSON.stringify(input));
    }
  });

  test('the factor-1 pass still runs the rewriter — conversion applies', () => {
    // Proves the invariant is structural, not a `factor === 1` short circuit.
    // Asserted whole-document: a substring check would pass even if the rest of
    // the note had been mangled.
    const r = scaleRecipe(CANONICAL, opts(1, { units: 'mlCups' }));
    assert.equal(
      r.text,
      [
        '# Pancakes',
        '',
        '## Procedure',
        '',
        'Whisk 375 mL flour into 250 mL milk.',
        '',
        '## Ingredients',
        'Serves: 4', // unchanged at factor 1
        '',
        '* 375 mL plain flour',
        '* 2 tsp baking powder', // spoons untouched by mlCups
        '* 250 mL milk',
        '* 2 eggs',
        '* ½ tsp salt',
        '* 4 oz dark chocolate',
        '* .',
        '',
      ].join('\n'),
    );
  });
});

describe('round trip', () => {
  test('×2 then ×0.5 returns the original document', () => {
    const doubled = scaleRecipe(CANONICAL, opts(2)).text;
    assert.equal(
      doubled,
      [
        '# Pancakes',
        '',
        '## Procedure',
        '',
        'Whisk 3 cups flour into 500 mL milk.',
        '',
        '## Ingredients',
        'Serves: 8',
        '',
        '* 3 cups plain flour',
        '* 4 tsp baking powder',
        '* 500 mL milk',
        '* 4 eggs',
        '* 1 tsp salt',
        '* 4 oz dark chocolate', // unknown units ride along unchanged
        '* .',
        '',
      ].join('\n'),
    );
    assert.equal(scaleRecipe(doubled, opts(0.5)).text, CANONICAL);
  });

  test('×3 then ×⅓ returns the original document', () => {
    const tripled = scaleRecipe(CANONICAL, opts(3)).text;
    assert.equal(scaleRecipe(tripled, opts(1 / 3)).text, CANONICAL);
  });

  test('a round trip is exact only where both renderings were exact', () => {
    // CANONICAL survives because every value in it happens to round exactly.
    // These do not, and the module cannot pretend otherwise — which is why the
    // documented contract is "scale from the original", not "re-scale output".
    const there = (line: string, f: number) => ing(line, f);
    assert.equal(there('* 2 eggs', 1 / 3), '* 0.67 eggs');
    assert.equal(ing('* 0.67 eggs', 3), '* 2.01 eggs', 'a rounded count cannot come back');
    assert.equal(there('* 474 g flour', 0.5), '* 235 g flour');
    assert.equal(ing('* 235 g flour', 2), '* 470 g flour', 'nearest-5 is lossy');
  });
});

// ─── Regressions ──────────────────────────────────────────────────────────────

describe('spaced unicode mixed numbers', () => {
  test('`1 ½` means one and a half, exactly like `1½`', () => {
    // What every editor that auto-substitutes fractions produces. Tokenised as a
    // bare `1` it scaled the integer only and left the glyph stranded.
    assert.equal(ing('* 1 ½ cups flour', 2), '* 3 cups flour');
    assert.equal(ing('* 1½ cups flour', 2), '* 3 cups flour');
    assert.equal(ing('* 1 ½ cups flour', 0.5), '* ¾ cup flour');
  });

  test('prose does not orphan the integer part', () => {
    assert.equal(prose('Add 1 ½ cups flour.', 2), 'Add 3 cups flour.');
  });

  test('a spaced range still scales both ends', () => {
    assert.equal(ing('* 1 ½ to 2 ½ cups flour', 2), '* 3 to 5 cups flour');
  });
});

describe('non-breaking space between amount and unit', () => {
  const NB = ' ';

  test('the unit is not invisible to the tokenizer', () => {
    assert.equal(ing(`* 1${NB}cup flour`, 0.5), '* ½ cup flour');
    assert.equal(ing(`* 1${NB}tbsp oil`, 0.125), '* ½ tsp oil');
    assert.equal(ing(`* 1${NB}cup milk`, 1, { units: 'mlAll' }), '* 250 mL milk');
  });

  test('it also separates a range', () => {
    assert.equal(ing(`* 2${NB}-${NB}3 cups flour`, 2), `* 4${NB}-${NB}6 cups flour`);
  });

  test('prose sees it too', () => {
    assert.equal(prose(`Pour in 1${NB}cup of stock.`, 2), 'Pour in 2 cups of stock.');
  });
});

describe('extra vulgar fractions', () => {
  test('fifths through tenths parse', () => {
    assert.equal(ing('* ⅙ tsp salt', 2), '* ⅓ tsp salt');
    assert.equal(ing('* ⅚ cup milk', 2), '* 1⅔ cups milk');
    assert.equal(ing('* ⅕ cup water', 5), '* 1 cup water');
    assert.equal(ing('* ⅘ cup water', 5), '* 4 cups water');
    assert.equal(ing('* ⅐ cup water', 7), '* 1 cup water');
    assert.equal(ing('* ⅑ cup water', 9), '* 1 cup water');
    assert.equal(ing('* ⅒ cup water', 10), '* 1 cup water');
  });

  test('they are no longer blamed on the author', () => {
    assert.deepEqual(issuesFor('Serves: 4\n* ⅙ tsp salt'), []);
  });
});

describe('protected spans inside an ingredient line', () => {
  test('an inline code note does not freeze the whole line', () => {
    assert.equal(ing('* 2 cups flour `sifted`', 2), '* 4 cups flour `sifted`');
    assert.deepEqual(issuesFor('Serves: 4\n* 2 cups flour `sifted`', 2), []);
  });

  test('a link or an image alongside the amount does not freeze it either', () => {
    assert.equal(ing('* 2 cups flour ([note](x.md))', 2), '* 4 cups flour ([note](x.md))');
    assert.equal(ing('* 2 cups ![i](p-2cups.png) flour', 2), '* 4 cups ![i](p-2cups.png) flour');
  });

  test('the ingredient path agrees with the prose path', () => {
    const line = '* 2 cups flour `sifted`';
    assert.equal(ing(line, 2), prose(line, 2));
  });

  test('an amount inside the code span itself is still left alone, and quietly', () => {
    assert.equal(ing('* `2 cups` flour', 2), '* `2 cups` flour');
    assert.deepEqual(issuesFor('Serves: 4\n* `2 cups` flour', 2), []);
  });

  test('a fenced block in the ingredients body is untouched and unreported', () => {
    const md = '## Ingredients\nServes: 4\n* 1 cup flour\n\n```\n* 1 cup sample\nsalt to taste\n```\n';
    const r = scaleRecipe(md, opts(2));
    assert.equal(
      r.text,
      '## Ingredients\nServes: 8\n* 2 cups flour\n\n```\n* 1 cup sample\nsalt to taste\n```\n',
    );
    assert.deepEqual(r.issues, []);
  });
});

describe('more than one amount on an ingredient line', () => {
  test('a dual-unit parenthetical is kept in step', () => {
    assert.equal(ing('* 1 cup (250 mL) milk', 2), '* 2 cups (500 mL) milk');
    assert.equal(ing('* 2 cups (500 g) flour', 2), '* 4 cups (1000 g) flour');
  });

  test('a range that repeats its unit scales both ends', () => {
    assert.equal(ing('* 1 cup to 2 cups flour', 2), '* 2 cups to 4 cups flour');
    assert.equal(ing('* 1 to 2 cups flour', 2), '* 2 to 4 cups flour');
  });

  test('several amounts on one line all move', () => {
    assert.equal(ing('* 2 eggs, 1 cup flour', 2), '* 4 eggs, 2 cups flour');
  });

  test('a bolded quantity is scaled, not reported as the authors mistake', () => {
    assert.equal(ing('* **2 cups** flour', 2), '* **4 cups** flour');
    assert.deepEqual(issuesFor('Serves: 4\n* **2 cups** flour', 2), []);
  });

  test('a table row of ingredients is scaled', () => {
    assert.equal(ing('| 2 cups | flour |', 2), '| 4 cups | flour |');
  });
});

describe('numbers that are not quantities', () => {
  test('a hyphenated dimension is left alone', () => {
    assert.equal(ing('* 2-inch piece of ginger', 2), '* 2-inch piece of ginger');
    assert.equal(ing('* 9-inch tin', 2), '* 9-inch tin');
    assert.equal(ing('* 2-cup measure', 2), '* 2-cup measure');
  });

  test('ingredients and prose agree about them', () => {
    assert.equal(prose('Use a 2-inch piece of ginger.', 2), 'Use a 2-inch piece of ginger.');
    assert.equal(ing('* 2-inch piece of ginger', 2), prose('* 2-inch piece of ginger', 2));
  });

  test('the line is reported rather than silently half-scaled', () => {
    assert.deepEqual(issuesFor('Serves: 4\n* 2-inch piece of ginger', 2), [
      { line: '* 2-inch piece of ginger', reason: 'unparseable-amount' },
    ]);
  });

  test('a real range is still a range', () => {
    assert.equal(ing('* 2-3 cups flour', 2), '* 4-6 cups flour');
    assert.equal(ing('* 2-3 eggs', 2), '* 4-6 eggs');
    assert.equal(ing('* 2 - 3 eggs', 2), '* 4 - 6 eggs');
  });

  test('a malformed compound fraction is left alone, not spliced', () => {
    assert.equal(ing('* 1 1/2/3 cups flour', 2), '* 1 1/2/3 cups flour');
    assert.equal(prose('Add 1 1/2/3 cups flour.', 2), 'Add 1 1/2/3 cups flour.');
    assert.deepEqual(issuesFor('Serves: 4\n* 1 1/2/3 cups flour', 2), [
      { line: '* 1 1/2/3 cups flour', reason: 'unparseable-amount' },
    ]);
  });

  test('a well-formed mixed fraction is unaffected by that rule', () => {
    assert.equal(ing('* 1 1/2 eggs', 2), '* 3 eggs');
    assert.equal(ing('* 1 1/2 cups flour', 2), '* 3 cups flour');
  });

  test('a zero denominator never reaches the renderer', () => {
    assert.equal(ing('* 0/0 cup flour', 1), '* 0/0 cup flour');
    assert.equal(ing('* 0/0 eggs', 1), '* 0/0 eggs');
    assert.equal(ing('* 1/0 cups flour', 2), '* 1/0 cups flour');
    assert.deepEqual(issuesFor('Serves: 4\n* 0/0 eggs', 2), [
      { line: '* 0/0 eggs', reason: 'unparseable-amount' },
    ]);
  });
});

describe('an amount is never rounded away to nothing', () => {
  test('a quartered quarter-teaspoon keeps a value', () => {
    // `0 tsp` deletes the salt with no issue raised; below ⅛ we print a decimal.
    assert.equal(ing('* 1/4 tsp salt', 0.25), '* 0.06 tsp salt');
    assert.equal(ing('* 1/8 tsp yeast', 0.5), '* 0.06 tsp yeast');
  });

  test('and the decimal survives the trip back', () => {
    assert.equal(ing('* 0.06 tsp salt', 4), '* ¼ tsp salt');
  });

  test('the same holds for metric and for bare counts', () => {
    assert.equal(ing('* 1 g salt', 0.01), '* 0.01 g salt');
    assert.equal(ing('* 3 eggs', 0.001), '* 0.003 eggs');
  });
});

describe('metric precision follows the unit, not the decimal point', () => {
  test('kilograms round to grams', () => {
    assert.equal(ing('* 1 kg flour', 0.25), '* 0.25 kg flour');
    assert.equal(ing('* 0.5 kg flour', 0.25), '* 0.125 kg flour');
    assert.equal(ing('* 0.1 kg butter', 0.25), '* 0.025 kg butter');
  });

  test('litres round to millilitres', () => {
    assert.equal(ing('* 1 L stock', 0.25), '* 0.25 L stock');
  });

  test('grams and millilitres keep their existing bands', () => {
    assert.equal(ing('* 1000 g flour', 0.25), '* 250 g flour');
    assert.equal(ing('* 1000 mL stock', 0.25), '* 250 mL stock');
  });

  test('kilograms round-trip', () => {
    assert.equal(ing('* 0.125 kg flour', 4), '* 0.5 kg flour');
  });

  test('rounding is half-up even when binary says otherwise', () => {
    assert.equal(ing('* 0.7 g yeast', 1.5), '* 1.1 g yeast'); // 1.05
    assert.equal(ing('* 1.4 g salt', 0.75), '* 1.1 g salt'); // 1.05
    assert.equal(ing('* 3.3 g agar', 1.5), '* 5 g agar'); // 4.95
    assert.equal(ing('* 85 g butter', 0.5), '* 43 g butter'); // 42.5
  });
});

describe('stepping down stops before the result is uncountable', () => {
  test('a large amount with an unclean fraction keeps its unit', () => {
    assert.equal(ing('* 3 cups flour', 1.1, { convention: 'us' }), '* 3⅓ cups flour');
    assert.equal(ing('* 3 cups flour', 1.1), '* 3⅓ cups flour');
    assert.equal(ing('* 6 cups stock', 1.1, { convention: 'us' }), '* 6⅝ cups stock');
    assert.equal(ing('* 2 cups flour', 1.05), '* 2⅛ cups flour');
  });

  test('small amounts still step down, large unclean spoons stay coarse', () => {
    assert.equal(ing('* 1 cup flour', 0.4), '* 5 tbsp flour');
    assert.equal(ing('* 1 cup flour', 0.125), '* 6¼ tsp flour');
    // Past 5 tbsp the ½-tbsp band keeps the result measurable.
    assert.equal(ing('* 1 cup flour', 0.4, { convention: 'us' }), '* 6½ tbsp flour');
  });
});

describe('spoon resolution coarsens with magnitude', () => {
  test('⅛ tsp remains available under a tablespoon', () => {
    assert.equal(ing('* 1 tsp salt', 0.5), '* ½ tsp salt');
    assert.equal(ing('* 1 tsp salt', 0.125), '* ⅛ tsp salt');
    assert.equal(ing('* 1 tsp salt', 0.375), '* ⅜ tsp salt');
  });

  test('past 1 tbsp, odd eighths of a teaspoon are dropped', () => {
    // 5.375 tsp AU = 1.34 tbsp → quarter-tsp band.
    assert.equal(ing('* 1 tsp salt', 5.375), '* 5⅓ tsp salt');
  });

  test('past 2 tbsp, teaspoon amounts snap to halves', () => {
    // 9.375 tsp AU = 2.34 tbsp → half-tsp band (the motivating case).
    assert.equal(ing('* 1 tsp salt', 9.375), '* 9½ tsp salt');
    assert.equal(ing('* 3⅛ tsp salt', 3), '* 9½ tsp salt');
  });

  test('past 3 tbsp, tablespoon amounts snap to quarters', () => {
    assert.equal(ing('* 1 tbsp oil', 3.125), '* 3 tbsp oil');
    assert.equal(ing('* 1 tbsp oil', 4.375), '* 4⅓ tbsp oil');
  });

  test('past 5 tbsp, tablespoon amounts snap to halves', () => {
    assert.equal(ing('* 1 tbsp oil', 6.375), '* 6½ tbsp oil');
    assert.equal(ing('* 1 tbsp oil', 7 + 1 / 3), '* 7½ tbsp oil');
  });
});

describe('snap() tie-breaking', () => {
  test('an exact midpoint resolves to the lower fraction', () => {
    // Deliberate and load-bearing (documented beside FRACTIONS): the direction
    // decides what an exactly-half value becomes.
    assert.equal(ing('* 1 tsp x', 0.1875), '* ⅛ tsp x');
    assert.equal(ing('* 1 tsp x', 0.5625), '* ½ tsp x');
    assert.equal(ing('* 1 tsp x', 0.8125), '* ¾ tsp x');
  });
});

describe('markdown structure', () => {
  test('an Ingredients heading inside a fence does not hijack the split', () => {
    const md =
      'Doc:\n\n```markdown\n## Ingredients\n* 1 cup flour\n```\n\n## Ingredients\nServes: 4\n* 2 cups flour\n';
    assert.equal(splitRecipe(md).head, 'Doc:\n\n```markdown\n## Ingredients\n* 1 cup flour\n```\n\n');
    const r = scaleRecipe(md, opts(2));
    assert.equal(
      r.text,
      'Doc:\n\n```markdown\n## Ingredients\n* 1 cup flour\n```\n\n## Ingredients\nServes: 8\n* 4 cups flour\n',
    );
    assert.deepEqual(r.issues, []);
  });

  test('a Serves line inside a fence is neither used nor rewritten', () => {
    const md = '## Ingredients\n```\nServes: 4\n```\n* 1 cup flour\n';
    const r = scaleRecipe(md, opts(2));
    assert.equal(r.text, '## Ingredients\n```\nServes: 4\n```\n* 2 cups flour\n');
    assert.deepEqual(r.issues, [{ line: '', reason: 'no-serves-line' }]);
  });

  test('a closing fence may not carry an info string', () => {
    assert.equal(
      prose('a 1 cup\n```\nc 1 cup\n```js\nstill code 1 cup\n```\nreal 1 cup\n', 2),
      'a 2 cups\n```\nc 1 cup\n```js\nstill code 1 cup\n```\nreal 2 cups\n',
    );
  });

  test('a ``` does not close a ~~~ block', () => {
    assert.equal(
      prose('~~~\n1 cup\n```\n1 cup\n~~~\n1 cup\n', 2),
      '~~~\n1 cup\n```\n1 cup\n~~~\n2 cups\n',
    );
  });

  test('a CRLF document finds its section', () => {
    const md = '# T\r\n\r\n## Ingredients\r\nServes: 4\r\n* 2 cups flour\r\n* 4 oz butter\r\n';
    assert.equal(splitRecipe(md).heading, '## Ingredients\r\n');
    const r = scaleRecipe(md, opts(2));
    assert.equal(
      r.text,
      '# T\r\n\r\n## Ingredients\r\nServes: 8\r\n* 4 cups flour\r\n* 4 oz butter\r\n',
    );
    assert.deepEqual(r.issues, [{ line: '* 4 oz butter\r', reason: 'unknown-unit' }]);
  });
});

describe('link targets of every form are protected', () => {
  // The rewriter injects a space before the unit, so touching a target does not
  // just misstate a number — it breaks the URL.
  test('reference definitions', () => {
    assert.equal(prose('[f]: http://e.com/c-2cups.png', 2), '[f]: http://e.com/c-2cups.png');
  });

  test('a destination containing balanced parentheses', () => {
    const md = 'See [x](http://e.com/a_(b)_2cups.png).';
    assert.equal(prose(md, 2), md);
  });

  test('the outer target of an image nested in a link', () => {
    assert.equal(
      prose('[![1 cup](i-2cups.png)](l-2cups.png)', 2),
      '[![2 cups](i-2cups.png)](l-2cups.png)',
    );
  });

  test('autolinks', () => {
    assert.equal(prose('<http://e.com/c-2cups.png>', 2), '<http://e.com/c-2cups.png>');
  });
});

describe('the factor must be a positive finite number', () => {
  const md = '## Ingredients\nServes: 4\n* 2 cups flour\n* 200 g sugar\n* 3 eggs\n';

  for (const factor of [0, -1, NaN, Infinity, -Infinity]) {
    test(`${factor} is refused rather than applied`, () => {
      // `Number('')` is 0 and `Number('x')` is NaN, so these arrive from any text
      // input. Each one used to write different garbage per unit kind.
      const r = scaleRecipe(md, opts(factor));
      assert.equal(r.text, md);
      assert.deepEqual(r.issues, [{ line: '', reason: 'invalid-factor' }]);
      const p = scaleProse('Add 1 cup water.', opts(factor));
      assert.equal(p.text, 'Add 1 cup water.');
      assert.deepEqual(p.issues, [{ line: '', reason: 'invalid-factor' }]);
    });
  }
});
