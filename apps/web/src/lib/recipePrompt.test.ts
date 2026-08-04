/**
 * The import prompt tells a browser agent how to shape a recipe for this app. Its value
 * depends entirely on the shape it asks for being the shape recipe.ts can actually read,
 * so these tests parse the prompt's own worked example rather than trusting the prose.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { buildRecipeImportPrompt } from './recipePrompt';
import {
  actionableIssues,
  scaleRecipe,
  splitRecipe,
  parseServes,
  isBlankRecipe,
  RECIPE_TEMPLATE,
  CONVENTIONS,
  type CupConvention,
} from './recipe';

const CONVENTION_IDS: CupConvention[] = ['au', 'us', 'metric'];

/** Pull the worked example back out of the prompt — the last `## ` block onwards. */
function workedExample(prompt: string): string {
  const i = prompt.lastIndexOf('## Buttermilk Pancakes');
  assert.ok(i > 0, 'prompt should contain the worked example');
  return prompt.slice(i);
}

describe('buildRecipeImportPrompt', () => {
  test('states the active convention’s millilitre values', () => {
    for (const id of CONVENTION_IDS) {
      const p = buildRecipeImportPrompt(id);
      const { cup, tbsp, tsp } = CONVENTIONS[id];
      assert.match(p, new RegExp(`${cup} mL per cup`));
      assert.match(p, new RegExp(`${tbsp} mL per tablespoon`));
      assert.match(p, new RegExp(`${tsp} mL per teaspoon`));
    }
  });

  test('asks only for units the scaler can convert', () => {
    const p = buildRecipeImportPrompt('au');
    // The units line is the contract; a unit the parser flags must not be requested.
    assert.match(p, /tsp, tbsp, cup, mL, L, g, kg/);
    for (const banned of ['ounce', 'pound', 'stick', 'pint', 'quart']) {
      // They may appear only in the "convert away from these" instruction, never as
      // something to emit. Assert they are named in the negative sentence.
      if (p.includes(banned)) {
        assert.match(p, /must NOT\n?\s*appear|Convert everything else/, `${banned} must be forbidden, not requested`);
      }
    }
  });

  test('forbids code fences and commentary', () => {
    const p = buildRecipeImportPrompt('au');
    assert.match(p, /ONLY the Markdown/);
    assert.match(p, /no code fences/);
  });

  test('asks for the four section headings and nothing deeper at that level', () => {
    const p = buildRecipeImportPrompt('au');
    // `##` closes the ingredient list, so the set of `##` headings the prompt asks for
    // IS the set of sections splitRecipe can place. Groups and stages must be `###`.
    assert.match(p, /^## Notes$/m);
    assert.match(p, /^### <group name>$/m);
    assert.match(p, /^### <stage name>$/m);
    assert.match(p, /MUST use three hashes/);
  });

  test('asks for the page’s own groups, stages and notes without inventing any', () => {
    const p = buildRecipeImportPrompt('au');
    assert.match(p, /If the page has\n\s*one flat list, emit the bullets with no group heading at all\./);
    assert.match(p, /Omit the whole "## Notes"\n\s*heading if the page gives none\./);
    assert.match(p, /Never invent structure/);
  });
});

describe('the worked example is valid Carbon recipe markdown', () => {
  const example = workedExample(buildRecipeImportPrompt('au'));

  test('splits into an Ingredients section', () => {
    const s = splitRecipe(example);
    assert.notEqual(s.heading, null);
    assert.equal(s.head + s.heading + s.body + s.tail, example, 'split must be lossless');
  });

  test('the example’s parts land in the right region of the split', () => {
    const s = splitRecipe(example);
    // Stage headings belong to the procedure, group headings to the ingredients, and
    // the notes to neither — a group written `## Batter` instead of `### Batter` would
    // cut the ingredient list in half here, which is why the prompt is strict about it.
    assert.match(s.head, /## Procedure\n\n### Batter\n/);
    assert.match(s.head, /### Cook\n/);
    assert.match(s.body, /^Serves: 4\n/);
    assert.match(s.body, /### Batter\n/);
    assert.match(s.body, /### To serve\n/);
    assert.doesNotMatch(s.body, /Notes/, 'notes must not sit in the ingredients column');
    assert.match(s.tail, /^## Notes\n/);
    assert.match(s.tail, /No buttermilk\?/);
  });

  test('has a Serves line the pills can multiply', () => {
    const s = splitRecipe(example);
    const serves = parseServes(s.body);
    assert.equal(serves?.value, 4);
  });

  test('raises no actionable issue — this is the whole point of the prompt', () => {
    // "salt to taste" carries no quantity, so the parser reports unparseable-amount and
    // actionableIssues drops it: there is nothing to scale and nothing for Optimise to
    // fix. Anything else surviving the filter would light the banner on a fresh import.
    for (const convention of CONVENTION_IDS) {
      const r = scaleRecipe(example, { factor: 1, units: 'original', convention });
      assert.deepEqual(
        actionableIssues(r.issues),
        [],
        `${convention}: expected a fully-derivable recipe, got ${JSON.stringify(r.issues)}`,
      );
      assert.deepEqual(
        r.issues.map((i) => i.reason),
        ['unparseable-amount'],
        `${convention}: only the quantity-free "to taste" line should be flagged`,
      );
    }
  });

  test('is byte-identical at factor 1', () => {
    const r = scaleRecipe(example, { factor: 1, units: 'original', convention: 'au' });
    assert.equal(r.text, example);
  });

  test('scales every amount correctly at ×2 (AU)', () => {
    const r = scaleRecipe(example, { factor: 2, units: 'original', convention: 'au' });
    assert.match(r.text, /Serves: 8/);
    assert.match(r.text, /\* 4 cups plain flour/);
    assert.match(r.text, /\* 4 tbsp caster sugar/);
    assert.match(r.text, /\* 2 tsp salt/);
    assert.match(r.text, /\* 1000 mL buttermilk/);
    assert.match(r.text, /\* 120 g butter, melted/);
    assert.match(r.text, /\* 4 eggs/);
    assert.match(r.text, /\* 250 mL maple syrup/);
    // A line with no quantity is left alone rather than mangled.
    assert.match(r.text, /\* butter, to taste/);
    // Prose amount scales (1/4 cup doubles, rendered as a unicode fraction); the cook
    // time carries no whitelisted unit and must not move.
    assert.match(r.text, /Cook ½ cup of batter per pancake for 2 minutes a side/);
    // Group and stage headings are structure, not text to rewrite.
    for (const heading of ['## Procedure', '### Batter', '### Cook', '### To serve', '## Notes']) {
      assert.ok(r.text.includes(`\n${heading}\n`), heading);
    }
    // A note is prose: its amounts follow the recipe, its oven time does not.
    assert.match(r.text, /Sour 1000 mL milk with 2 tbsp lemon juice and stand it for 10 minutes/);
  });

  test('halves cleanly too — no drift back from ×2', () => {
    const doubled = scaleRecipe(example, { factor: 2, units: 'original', convention: 'au' }).text;
    const back = scaleRecipe(example, { factor: 0.5, units: 'original', convention: 'au' }).text;
    assert.match(back, /\* 1 cup plain flour/);
    assert.match(back, /\* 1 tbsp caster sugar/);
    assert.match(back, /\* 250 mL buttermilk/);
    assert.match(back, /\* 30 g butter, melted/);
    assert.notEqual(doubled, back);
  });

  test('converts to mL on demand without touching mass', () => {
    const r = scaleRecipe(example, { factor: 1, units: 'mlCups', convention: 'au' });
    assert.match(r.text, /\* 500 mL plain flour/); // 2 cups AU
    assert.match(r.text, /\* 2 tbsp caster sugar/); // spoons untouched by mlCups
    assert.match(r.text, /\* 60 g butter, melted/); // mass never converted
  });
});

describe('actionableIssues', () => {
  const at = (line: string, reason: 'unparseable-amount' | 'unknown-unit') => ({ line, reason });

  test('drops quantity-free lines — they would light the banner on every real recipe', () => {
    const dropped = ['* salt to taste', '* a pinch of pepper', '* freshly ground black pepper'];
    assert.deepEqual(actionableIssues(dropped.map((l) => at(l, 'unparseable-amount'))), []);
  });

  test('keeps a line that carries a numeral we failed to read', () => {
    const kept = at('* 2-inch piece of ginger', 'unparseable-amount');
    assert.deepEqual(actionableIssues([kept]), [kept]);
    const vulgar = at('* ½-inch piece of ginger', 'unparseable-amount');
    assert.deepEqual(actionableIssues([vulgar]), [vulgar]);
  });

  test('always keeps unknown-unit — that is what Optimise is for', () => {
    const oz = at('* 4 oz butter', 'unknown-unit');
    assert.deepEqual(actionableIssues([oz]), [oz]);
  });

  test('keeps the structural issues, which carry no line', () => {
    for (const reason of ['no-ingredients-section', 'no-serves-line', 'invalid-factor'] as const) {
      assert.equal(actionableIssues([{ line: '', reason }]).length, 1, reason);
    }
  });
});

describe('isBlankRecipe', () => {
  test('the freshly-seeded template is blank', () => {
    assert.equal(isBlankRecipe(RECIPE_TEMPLATE), true);
  });

  test('an empty or whitespace-only body is blank', () => {
    for (const v of ['', '   ', '\n\n', '\t\n ']) assert.equal(isBlankRecipe(v), true);
  });

  test('survives an editor stripping the title heading’s trailing space', () => {
    // The template's first line is '## ' with a trailing space; Tiptap may drop it.
    // Exact string equality would call an untouched note "not blank".
    assert.equal(isBlankRecipe(RECIPE_TEMPLATE.replace('## \n', '##\n')), true);
  });

  test('survives blank-line and trailing-whitespace drift', () => {
    assert.equal(isBlankRecipe('\n' + RECIPE_TEMPLATE.replace(/\n\n/g, '\n\n\n') + '\n  '), true);
  });

  test('a typed title is no longer blank', () => {
    assert.equal(isBlankRecipe(RECIPE_TEMPLATE.replace('## \n', '## Brisket\n')), false);
  });

  test('a real ingredient is no longer blank', () => {
    assert.equal(isBlankRecipe(RECIPE_TEMPLATE.replace('* .', '* 2 cups flour')), false);
  });

  test('a pasted recipe is not blank', () => {
    assert.equal(isBlankRecipe(workedExample(buildRecipeImportPrompt('au'))), false);
  });
});
