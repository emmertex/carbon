import { CONVENTIONS, type CupConvention } from './recipe';

/**
 * The prompt a user copies into an agentic browser (Chrome + the Claude extension, or
 * similar) sitting on a recipe page. Its job is to get back Markdown that pastes
 * straight into a Carbon recipe note and scales with zero issues.
 *
 * Every rule here exists because `recipe.ts` depends on it, so the two must not drift:
 *
 * - Amounts must LEAD the ingredient line. The parser reads a leading amount on a
 *   bullet; "flour, 2 cups" parses as no amount at all.
 * - Only the units in the table below are convertible. `oz`, `fl oz`, `lb`, `pint`,
 *   `quart` and `stick` are recognised but deliberately not converted — they pass
 *   through unscaled and raise `unknown-unit`, which is what puts the Optimise banner
 *   on screen. Asking for metric up front is what makes the import clean.
 * - Bare `t`, `T`, `c` and `C` are rejected as too ambiguous to guess at, so the prompt
 *   asks for spelled-out or standard abbreviations.
 * - `Serves: N` is what the servings pills multiply against.
 * - Group and stage headings must be `###`. A `##` heading *closes* the ingredient
 *   section (see `splitRecipe`), so a group written as `## Marinade` would move the
 *   rest of the ingredients out of the ingredients column entirely.
 *
 * `recipePrompt.test.ts` runs the worked example below through `scaleRecipe` and fails
 * if it does not parse cleanly — that test is the guard against this drifting.
 */
export function buildRecipeImportPrompt(convention: CupConvention): string {
  const c = CONVENTIONS[convention];
  return `Read the recipe on this page and rewrite it as Markdown I can paste into my recipe app.

Use the recipe on the page only. Ignore navigation, ads, comments, ratings, "related
recipes", and any other recipe that is not the main one. If the page has no recipe, say
so instead of inventing one.

Return ONLY the Markdown — no commentary before or after, and no code fences.

Use exactly this structure, including the headings, spelled and ordered as shown:

## <recipe title>

## Procedure

### <stage name>

1. <first step of that stage>
2. <second step of that stage>

### <next stage name>

1. <first step of that stage>

## Ingredients
Serves: <whole number>

### <group name>

* <amount> <unit> <ingredient>
* <amount> <unit> <ingredient>

### <next group name>

* <amount> <unit> <ingredient>

## Notes

* <note or tip the recipe gives>
* <another note>

Rules that matter — the app parses this text, so it is strict:

1. The amount must come FIRST on each ingredient line, before the unit and the name.
   Write "* 2 cups flour", never "* flour, 2 cups" or "* flour (2 cups)".
2. Use ONLY these units, spelled exactly like this:
   tsp, tbsp, cup, mL, L, g, kg
   Convert everything else to them. Ounces, pounds, sticks, pints and quarts must NOT
   appear — convert to g, kg or mL. Do not use single-letter abbreviations (t, T, c).
3. Assume ${c.cup} mL per cup, ${c.tbsp} mL per tablespoon, ${c.tsp} mL per teaspoon.
   Keep cup/tbsp/tsp as cup/tbsp/tsp — do not turn them into mL yourself.
4. Amounts may be whole numbers, decimals, or fractions (1/2, 1 1/2, ½, 1½). A range is
   fine: "2-3 cups". An ingredient with no real quantity is fine too: "* butter, to taste".
5. Temperatures in °C, oven times in minutes, tin and pan sizes in cm.
6. Every ingredient and every step from the page must appear exactly once. Do not merge,
   drop, reorder or invent any. Keep the wording of the steps close to the original.
7. Put the serving count the page states in "Serves:". If it gives a range, use the lower
   number. If it states none, infer a sensible whole number. Keep the "Serves:" line
   directly under "## Ingredients", above the first group.
8. If the page groups its ingredients ("For the marinade", "To coat", "For the sauce"),
   keep every group, in page order, as a "### <group name>" heading with that group's
   bullets under it. Use the page's own names, minus any trailing colon. If the page has
   one flat list, emit the bullets with no group heading at all.
9. Do the same for the method: if the page names its stages, keep them as
   "### <stage name>" under "## Procedure", each stage numbered from 1 again. A single
   flat method stays one numbered list with no stage headings.
10. Group and stage headings MUST use three hashes ("###"), never two. Only the four
    section headings above use two hashes.
11. Put the recipe's notes, tips and substitution advice under "## Notes" at the end, one
    bullet each, and nowhere else — never folded into the steps. Omit the whole "## Notes"
    heading if the page gives none. Notes from the comments section do not count.
12. Never invent structure: no group, stage or note that is not on the page.

Worked example of the shape and unit style expected:

## Buttermilk Pancakes

## Procedure

### Batter

1. Whisk the flour, sugar and salt together in a large bowl.
2. Beat in the buttermilk and melted butter until just combined.
3. Rest the batter for 10 minutes.

### Cook

1. Cook 1/4 cup of batter per pancake for 2 minutes a side, until golden.
2. Hold the cooked pancakes in a 120 C oven while you finish the rest.

## Ingredients
Serves: 4

### Batter

* 2 cups plain flour
* 2 tbsp caster sugar
* 1 tsp salt
* 500 mL buttermilk
* 60 g butter, melted
* 2 eggs

### To serve

* 125 mL maple syrup
* butter, to taste

## Notes

* Resting lets the flour hydrate; the batter thickens as it sits, so loosen it with a
  splash of milk if it stops spreading.
* No buttermilk? Sour 500 mL milk with 1 tbsp lemon juice and stand it for 10 minutes.`;
}
