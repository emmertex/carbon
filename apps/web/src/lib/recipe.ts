/**
 * Recipe parsing and scaling for note bodies. Pure and dependency-free (no DOM,
 * no @carbon/core) so it behaves identically in the editor and under `node --test`.
 *
 * The constraint that shapes everything here is reversibility: someone who
 * doubles a recipe and then halves it must get their own text back. Two rules
 * fall out of that. (1) A span whose value did not move is left in the author's
 * own spelling — the rewriter never re-punctuates `1 1/2` into `1½` on a pass
 * that changed nothing. That no-op is decided structurally (the scaled value
 * equals the source value), never by inspecting the factor. (2) Unit stepping
 * only ever goes *down* (cup → tbsp → tsp); promoting would have to round into a
 * coarser unit and could not be undone.
 *
 * What is guaranteed exactly is the factor-1 identity, for every input. A ×2 then
 * ×0.5 round trip returns the original whenever both renderings were exact; where
 * a rendering has to round (`235 g` for 237 g, `Serves: 2` for 1.5) the discarded
 * precision is gone and the trip back cannot invent it. Callers should therefore
 * always scale from the author's original text, never from their own output.
 */

export type NoteMode = 'notes' | 'recipe';
export type UnitMode = 'original' | 'mlCups' | 'mlAll';
export type CupConvention = 'au' | 'us' | 'metric';

export type UnitKind = 'spoon' | 'cup' | 'metricVolume' | 'metricMass' | 'unknown';

export interface ScaleOptions {
  factor: number;
  units: UnitMode;
  convention: CupConvention;
}

export type IssueReason =
  | 'no-ingredients-section'
  | 'no-serves-line'
  | 'unknown-unit'
  | 'unparseable-amount'
  | 'invalid-factor';

export interface RecipeIssue {
  line: string;
  reason: IssueReason;
}

export interface ScaleResult {
  text: string;
  issues: RecipeIssue[];
}

/** Digits or a vulgar fraction — i.e. the author wrote *some* quantity on this line. */
const HAS_QUANTITY_RE = /[\d¼-¾⅐-⅞]/;

/**
 * The subset of `issues` worth interrupting the user over.
 *
 * `unparseable-amount` fires on any bullet with no derivable leading amount, and
 * "salt to taste" / "a pinch of pepper" appear in practically every real recipe. Left
 * in, a banner keyed on `issues.length` would be permanently lit and stop meaning
 * anything. A line carrying no quantity at all has nothing to scale, so it is not a
 * defect — but one that *does* carry a numeral we failed to read ("2-inch piece of
 * ginger") is exactly what Optimise fixes, so it stays. `unknown-unit` always counts:
 * a real measurement we recognise but cannot convert is the case this exists for.
 *
 * Kept here rather than in the view so the reporting rule has one definition and can
 * be tested against real parser output.
 */
export function actionableIssues(issues: RecipeIssue[]): RecipeIssue[] {
  return issues.filter(
    (i) => i.reason !== 'unparseable-amount' || HAS_QUANTITY_RE.test(i.line),
  );
}

/** Split at the first `## Ingredients` heading, and again where that section ends.
 *  Lossless: head + heading + body + tail re-concatenates to the input exactly.
 *  `heading === null` => no section found. */
export interface RecipeSplit {
  head: string;
  heading: string | null;
  /** The ingredient list, including any `### <group>` sub-headings within it. */
  body: string;
  /** Everything from the heading that closed the ingredient list onwards — a
   *  `## Notes` section, or a Procedure the author put after the ingredients.
   *  '' when the list runs to the end of the document. */
  tail: string;
}

interface Conversion {
  cup: number;
  tbsp: number;
  tsp: number;
}

/** Millilitres per spoon/cup unit. AU is the default; a US cup is smaller and a
 *  "metric" cup pairs the 250 mL cup with the 15 mL international tablespoon. */
export const CONVENTIONS: Record<CupConvention, Conversion> = {
  au: { cup: 250, tbsp: 20, tsp: 5 },
  us: { cup: 240, tbsp: 15, tsp: 5 },
  metric: { cup: 250, tbsp: 15, tsp: 5 },
};

/** The first heading is deliberately empty — the user types the recipe title into it. */
export const RECIPE_TEMPLATE = '## \n\n## Procedure\n\n## Ingredients\nServes: 4\n\n* .\n';

/** Trailing spaces stripped per line, blank runs collapsed, no leading/trailing blanks.
 *  Enough to compare "did the user actually write anything" without caring about the
 *  whitespace an editor round-trip introduces or removes. */
function normalizeBody(md: string): string {
  return md
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * True when a recipe note is still the freshly-seeded template — nothing typed yet.
 *
 * Compared after normalising rather than by string equality on purpose: the template's
 * title heading is `'## '` *with* a trailing space, and a pass through the rich editor
 * may strip it. An exact match would then quietly report "not blank" for a note the
 * user has not touched.
 */
export function isBlankRecipe(md: string): boolean {
  const body = normalizeBody(md);
  return body === '' || body === normalizeBody(RECIPE_TEMPLATE);
}

/** A factor that is not a positive finite number is not a scaling request. Zero,
 *  negative, NaN and Infinity all arrive from UI input (`Number('')` is 0,
 *  `Number('x')` is NaN) and every one of them writes garbage into the document,
 *  irreversibly, so they are rejected once here instead of degrading differently
 *  in each rounding branch. */
function usableFactor(factor: number): boolean {
  return Number.isFinite(factor) && factor > 0;
}

// ─── Units ────────────────────────────────────────────────────────────────────

type UnitId = 'tsp' | 'tbsp' | 'cup' | 'ml' | 'l' | 'g' | 'kg';
type SpoonUnit = 'cup' | 'tbsp' | 'tsp';

interface UnitDef {
  id: UnitId;
  kind: UnitKind;
  /** null for abbreviations: they are echoed verbatim and never pluralised. */
  spelled: { one: string; many: string } | null;
  /** Grams / millilitres per unit. Metric rounding precision follows the *real*
   *  magnitude, not the decimal one: 0.25 kg has to round like 250 g, otherwise
   *  one decimal place means 100 g of slack. */
  perBase: number;
}

const UNIT_MAP = new Map<string, UnitDef>();

function defineUnit(
  id: UnitId,
  kind: UnitKind,
  abbreviations: string[],
  spellings: Array<[string, string]>,
  perBase = 1,
): void {
  for (const a of abbreviations) UNIT_MAP.set(a, { id, kind, spelled: null, perBase });
  for (const [one, many] of spellings) {
    const spelled = { one, many };
    UNIT_MAP.set(one, { id, kind, spelled, perBase });
    UNIT_MAP.set(many, { id, kind, spelled, perBase });
  }
}

defineUnit('tsp', 'spoon', ['tsp', 'tsps'], [['teaspoon', 'teaspoons']]);
defineUnit('tbsp', 'spoon', ['tbsp', 'tbsps', 'tbs'], [['tablespoon', 'tablespoons']]);
defineUnit('cup', 'cup', [], [['cup', 'cups']]);
defineUnit('ml', 'metricVolume', ['ml'], [
  ['millilitre', 'millilitres'],
  ['milliliter', 'milliliters'],
]);
defineUnit(
  'l',
  'metricVolume',
  ['l'],
  [
    ['litre', 'litres'],
    ['liter', 'liters'],
  ],
  1000,
);
defineUnit('g', 'metricMass', ['g'], [['gram', 'grams']]);
defineUnit('kg', 'metricMass', ['kg'], [['kilogram', 'kilograms']], 1000);

/** Units we recognise well enough to name but deliberately refuse to convert:
 *  imperial mass/volume has no honest fraction-preserving mapping onto the
 *  metric kitchen, so we pass the text through and raise an `unknown-unit` issue. */
const UNCONVERTED = [
  'fl oz',
  'oz',
  'lb',
  'lbs',
  'pound',
  'pounds',
  'pint',
  'pints',
  'quart',
  'quarts',
  'stick',
  'sticks',
];

// Longest alias first so `tablespoons` wins over `tablespoon`, and `litre` over
// the bare `l`. The trailing lookahead is the word boundary that keeps `g` from
// eating the start of `gravy` and `l` the start of `large`.
function alternation(keys: string[]): string {
  return `(?:${[...keys].sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9])`;
}

const CONVERTIBLE_UNIT_SRC = alternation([...UNIT_MAP.keys()]);
const ANY_UNIT_SRC = alternation([...UNIT_MAP.keys(), ...UNCONVERTED]);

// ─── Numbers ──────────────────────────────────────────────────────────────────

/** Horizontal whitespace, for use inside a character class. U+00A0 is in here
 *  because word processors, iOS and most recipe sites emit a non-breaking space
 *  between an amount and its unit; without it the unit is invisible to the
 *  tokenizer and the amount silently scales as a bare count. */
const WS = ' \\t\\u00a0';

const VULGAR: Record<string, number> = {
  '½': 1 / 2,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅕': 1 / 5,
  '⅖': 2 / 5,
  '⅗': 3 / 5,
  '⅘': 4 / 5,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅐': 1 / 7,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
  '⅑': 1 / 9,
  '⅒': 1 / 10,
};

// Derived from the table so the two can never drift apart. Fifths, sixths and the
// rest are here because a fraction-substituting editor draws from the whole
// Unicode Number Forms block, not just the halves and quarters we can re-render.
const VULGAR_CLASS = `[${Object.keys(VULGAR).join('')}]`;

// Order matters: `1 1/2` must be tried before the bare `1`, and `1½` before `1`.
// The unicode mixed number is accepted glued (`1½`) *and* spaced (`1 ½`) — the
// spaced form is what auto-substitution and pasted web recipes produce, and
// tokenising it as a bare `1` mis-scales the amount without any warning.
const NUM_SRC =
  `(?:\\d+[${WS}]+\\d+\\/\\d+` +
  `|\\d+[${WS}]*${VULGAR_CLASS}` +
  `|\\d+\\/\\d+` +
  `|${VULGAR_CLASS}` +
  `|\\d+(?:\\.\\d+)?)`;
const SEP_SRC = `(?:[${WS}]*[-–][${WS}]*|[${WS}]+to[${WS}]+)`;
const AMOUNT_SRC = `(?:${NUM_SRC}${SEP_SRC}${NUM_SRC}|${NUM_SRC})`;

const MIXED_ASCII_RE = new RegExp(`^(\\d+)[${WS}]+(\\d+)\\/(\\d+)$`);
const MIXED_VULGAR_RE = new RegExp(`^(\\d+)[${WS}]*(${VULGAR_CLASS})$`);
const ASCII_FRACTION_RE = /^(\d+)\/(\d+)$/;
const RANGE_RE = new RegExp(`^(${NUM_SRC})(${SEP_SRC})(${NUM_SRC})$`, 'i');

function parseNumber(text: string): number {
  const s = text.trim();
  const mixed = MIXED_ASCII_RE.exec(s);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const glued = MIXED_VULGAR_RE.exec(s);
  if (glued) return Number(glued[1]) + VULGAR[glued[2]!]!;
  const frac = ASCII_FRACTION_RE.exec(s);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const vulgar = VULGAR[s];
  if (vulgar !== undefined) return vulgar;
  return Number(s);
}

interface ParsedAmount {
  values: number[];
  /** Verbatim range separator (`-`, `–`, ` to `), or '' for a single value. */
  separator: string;
}

function parseAmount(text: string): ParsedAmount {
  const range = RANGE_RE.exec(text);
  if (range) {
    return { values: [parseNumber(range[1]!), parseNumber(range[3]!)], separator: range[2]! };
  }
  return { values: [parseNumber(text)], separator: '' };
}

/** Endpoints, or null when the token is number-*shaped* but is not a number:
 *  `0/0` is NaN and `1/0` is Infinity. Callers treat null as "no amount here".
 *  Scaling them would slip past the structural no-op guard (`NaN !== NaN`) and
 *  print `NaN` into the user's document on a pass that changed nothing. */
function amountValues(text: string): number[] | null {
  const { values } = parseAmount(text);
  return values.every((v) => Number.isFinite(v)) ? values : null;
}

// ─── Rounding ─────────────────────────────────────────────────────────────────

const EPS = 1e-9;

type Fraction = { v: number; glyph: string };

const FRACTIONS: Fraction[] = [
  { v: 0, glyph: '' },
  { v: 1 / 8, glyph: '⅛' },
  { v: 1 / 4, glyph: '¼' },
  { v: 1 / 3, glyph: '⅓' },
  { v: 3 / 8, glyph: '⅜' },
  { v: 1 / 2, glyph: '½' },
  { v: 5 / 8, glyph: '⅝' },
  { v: 2 / 3, glyph: '⅔' },
  { v: 3 / 4, glyph: '¾' },
  { v: 7 / 8, glyph: '⅞' },
  { v: 1, glyph: '' },
];

function isNear(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

/** Drop the odd eighths (⅛, ⅜, ⅝, ⅞) — quarters and thirds remain. */
const FRACTIONS_QUARTER: Fraction[] = FRACTIONS.filter(
  (f) => !isNear(f.v, 1 / 8) && !isNear(f.v, 3 / 8) && !isNear(f.v, 5 / 8) && !isNear(f.v, 7 / 8),
);

/** Halves only — used past 2 tbsp (½ tsp) and past 5 tbsp (½ tbsp). */
const FRACTIONS_HALF: Fraction[] = FRACTIONS.filter(
  (f) => f.v === 0 || f.v === 1 || isNear(f.v, 1 / 2),
);

/** Half a 1/32 step. Anything further from a standard fraction than this is a
 *  number a cook cannot measure, and is worth stepping down a unit for. */
const CLEAN_TOLERANCE = 1 / 64;

/** Half-up rounding that binary representation cannot defeat. `0.7 * 1.5` is
 *  1.0499999999999998, and `Math.round(10.499999999999998)` is 10 — a cook doing
 *  it on paper gets 1.1, so the nudge makes the code agree with the docstring. */
function roundHalfUp(x: number): number {
  const nudge = EPS * Math.max(1, Math.abs(x));
  return x < 0 ? -Math.floor(-x + 0.5 + nudge) : Math.floor(x + 0.5 + nudge);
}

interface Snapped {
  value: number;
  text: string;
  clean: boolean;
}

/** Snap the fractional part to the nearest kitchen fraction. Snapping to 1
 *  carries into the integer part, so 2.99 becomes a plain 3. A value exactly
 *  midway between two members resolves *downward* (the scan keeps the first
 *  index on equality) — the gaps between members are uneven, so there is no
 *  neutral choice, and a consistent direction keeps the result deterministic. */
function snap(value: number, fractions: readonly Fraction[] = FRACTIONS): Snapped {
  const whole = Math.floor(value + EPS);
  const frac = value - whole;
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < fractions.length; i++) {
    const delta = Math.abs(frac - fractions[i]!.v);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  const member = fractions[best]!;
  const carried = member.v === 1;
  const integer = whole + (carried ? 1 : 0);
  const glyph = carried ? '' : member.glyph;
  return {
    value: integer + (carried ? 0 : member.v),
    text: integer > 0 ? `${integer}${glyph}` : glyph || '0',
    clean: bestDelta <= CLEAN_TOLERANCE + EPS,
  };
}

function trimNumber(value: number, decimals: number): string {
  let s = value.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** A positive amount must never render as `0`: that silently deletes the salt,
 *  the yeast or the vanilla and no issue is raised to say so. Below the smallest
 *  glyph we can draw, fall back to a decimal — it is honest, and it survives the
 *  round trip (`0.06 tsp` ×4 snaps straight back to `¼ tsp`), which rounding up
 *  to `⅛ tsp` would not. */
function tinyDecimal(value: number): { value: number; text: string } {
  for (let d = 2; d <= 6; d++) {
    const r = Number(value.toFixed(d));
    if (r !== 0) return { value: r, text: trimNumber(r, d) };
  }
  return { value, text: String(value) };
}

function snapRung(count: number, fractions: readonly Fraction[] = FRACTIONS): Snapped {
  const s = snap(count, fractions);
  if (s.value !== 0 || !(count > 0)) return s;
  const t = tinyDecimal(count);
  return { value: t.value, text: t.text, clean: true };
}

/**
 * Spoon amounts coarsen as they grow: ⅛ tsp is fine for a pinch, but
 * `9⅜ tsp` is not a measurement anyone can make. Thresholds are in tablespoons
 * of absolute volume under the active convention.
 *
 *   ≤1 tbsp  → ⅛ tsp (full fraction set)
 *   ≤2 tbsp  → ¼ tsp
 *   ≤3 tbsp  → ½ tsp (tbsp keeps eighths so ½ tsp is still expressible)
 *   ≤5 tbsp  → ¼ tbsp
 *   >5 tbsp  → ½ tbsp
 *
 * Cups keep the full set — an eighth of a cup is still a real measuring-cup mark.
 */
function spoonFractions(count: number, unit: SpoonUnit, conv: Conversion): readonly Fraction[] {
  if (unit === 'cup') return FRACTIONS;
  const tbsp = (count * conv[unit]) / conv.tbsp;
  if (tbsp > 5) return FRACTIONS_HALF;
  if (tbsp > 3) return FRACTIONS_QUARTER;
  if (tbsp > 2) return unit === 'tsp' ? FRACTIONS_HALF : FRACTIONS;
  if (tbsp > 1) return unit === 'tsp' ? FRACTIONS_QUARTER : FRACTIONS;
  return FRACTIONS;
}

/** Snap a spoon/cup count with magnitude-aware resolution. A coarsened set is
 *  always treated as clean: the whole point of dropping ⅛ is to accept the
 *  nearest coarser mark rather than step down into an uncountable tsp pile. */
function snapSpoon(count: number, unit: SpoonUnit, conv: Conversion): Snapped {
  const fractions = spoonFractions(count, unit, conv);
  const s = snapRung(count, fractions);
  if (fractions !== FRACTIONS) return { ...s, clean: true };
  return s;
}

const RUNGS: SpoonUnit[] = ['cup', 'tbsp', 'tsp'];

/** Stepping down is a kindness only while the finer unit stays countable. Past
 *  this many spoons the cook is far better served by an approximate fraction of
 *  the coarser unit: `3⅓ cups` (+1%) beats an exact but unusable `158⅜ tsp`.
 *  The threshold sits above the ~19 tsp that a fifth of a US cup legitimately
 *  produces and below the ~26 tbsp that scaling a multi-cup amount produces. */
const MAX_STEPPED_COUNT = 24;

/** Snap in the source unit; if the result is unmeasurable or smaller than a
 *  quarter, drop to the next finer unit and try again. Never the reverse: with
 *  an AU cup at 250 mL and a tbsp at 20 mL, promoting `8 tbsp` to `2/3 cup`
 *  would silently lose 6 mL. */
function roundStepping(
  value: number,
  unit: SpoonUnit,
  conv: Conversion,
): Snapped & { unit: SpoonUnit } {
  if (!(value > 0)) return { value: 0, text: '0', clean: true, unit };
  const ml = value * conv[unit];
  let idx = RUNGS.indexOf(unit);
  for (;;) {
    const rung = RUNGS[idx]!;
    const result = snapSpoon(ml / conv[rung], rung, conv);
    if (idx === RUNGS.length - 1) return { ...result, unit: rung };
    if (result.clean && result.value >= 1 / 4) return { ...result, unit: rung };
    // An unclean fraction of a *large* amount is a rounding error of no
    // consequence; stepping down for it cascades to the terminal rung.
    if (result.value >= 1 / 4 && ml / conv[RUNGS[idx + 1]!] > MAX_STEPPED_COUNT) {
      return { ...result, unit: rung };
    }
    idx++;
  }
}

/** Metric amounts stay decimal — a cook reads `235 g`, never `234⅞ g`. Precision
 *  tracks magnitude *in base units*: tenths under 10, whole numbers to 99, then
 *  steps of 5. `perBase` is what keeps kg and L honest — banding 0.25 kg as a
 *  bare `0.3` is a 20% error, and 0.025 kg would round away to nothing. */
function roundMetric(value: number, perBase = 1): { value: number; text: string } {
  const base = value * perBase;
  const magnitude = Math.abs(base);
  let rounded: number;
  let decimals: number;
  if (magnitude < 10) {
    rounded = roundHalfUp(base * 10) / 10;
    decimals = 1;
  } else if (magnitude < 100) {
    rounded = roundHalfUp(base);
    decimals = 0;
  } else {
    rounded = roundHalfUp(base / 5) * 5;
    decimals = 0;
  }
  if (rounded === 0 && value !== 0) return tinyDecimal(value);
  const r = rounded / perBase;
  return { value: r, text: trimNumber(r, decimals + Math.max(0, Math.round(Math.log10(perBase)))) };
}

function roundCount(value: number): { value: number; text: string } {
  const r = roundHalfUp(value * 100) / 100;
  if (r === 0 && value !== 0) return tinyDecimal(value);
  return { value: r, text: trimNumber(r, 2) };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function applyCase(sample: string, out: string): string {
  if (sample !== sample.toLowerCase() && sample === sample.toUpperCase()) return out.toUpperCase();
  if (/^[A-Z]/.test(sample)) return out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

function unitLabel(unit: UnitDef, sourceText: string, value: number): string {
  if (!unit.spelled) return sourceText;
  return applyCase(sourceText, value > 1 ? unit.spelled.many : unit.spelled.one);
}

function convertsToMl(unit: UnitDef, units: UnitMode): boolean {
  if (unit.id === 'cup') return units !== 'original';
  if (unit.kind === 'spoon') return units === 'mlAll';
  return false;
}

/**
 * Rewrite one amount+unit span. Returns `src` untouched whenever nothing would
 * change — that no-op is what makes a factor-1 pass byte-for-byte identical,
 * without the function ever inspecting `factor` itself.
 */
function rewriteSpan(src: string, amountText: string, unitText: string, opts: ScaleOptions): string {
  const unit = unitText ? UNIT_MAP.get(unitText.toLowerCase()) ?? null : null;
  const { values, separator } = parseAmount(amountText);
  if (!values.every((v) => Number.isFinite(v))) return src;
  const conv = CONVENTIONS[opts.convention];
  const toMl = unit !== null && convertsToMl(unit, opts.units);
  const scaled = values.map((v) => v * opts.factor);
  if (!toMl && scaled.every((v, i) => v === values[i])) return src;

  let texts: string[];
  let label: string;

  if (!unit) {
    const rounded = scaled.map(roundCount);
    texts = rounded.map((r) => r.text);
    label = '';
  } else if (toMl) {
    const perUnit = conv[unit.id as SpoonUnit];
    const rounded = scaled.map((v) => roundMetric(v * perUnit));
    texts = rounded.map((r) => r.text);
    label = 'mL';
  } else if (unit.kind === 'cup' || unit.kind === 'spoon') {
    const source = unit.id as SpoonUnit;
    const stepped = scaled.map((v) => roundStepping(v, source, conv));
    // A range must carry a single label, so both ends settle on the finer rung.
    const target = RUNGS[Math.max(...stepped.map((r) => RUNGS.indexOf(r.unit)))]!;
    const finals = stepped.map((r, i) =>
      r.unit === target ? r : snapSpoon((scaled[i]! * conv[source]) / conv[target], target, conv),
    );
    texts = finals.map((r) => r.text);
    const peak = Math.max(...finals.map((r) => r.value));
    label = target === source ? unitLabel(unit, unitText, peak) : target;
  } else {
    const rounded = scaled.map((v) => roundMetric(v, unit.perBase));
    texts = rounded.map((r) => r.text);
    label = unitLabel(unit, unitText, Math.max(...rounded.map((r) => r.value)));
  }

  const out = texts.join(separator) + (label ? ` ${label}` : '');
  return out === src ? src : out;
}

// ─── Markdown regions we must not touch ───────────────────────────────────────

type Range = [number, number];

function overlaps(ranges: Range[], start: number, end: number): boolean {
  return ranges.some(([a, b]) => start < b && end > a);
}

function containedIn(ranges: Range[], start: number, end: number): boolean {
  return ranges.some(([a, b]) => start >= a && end <= b);
}

interface DocLine {
  start: number;
  end: number;
  text: string;
  /** Inside (or itself part of) a fenced code block. */
  fenced: boolean;
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** Line offsets plus fenced-code state, computed once per pass and shared by
 *  every scanner in this file — the section split, the Serves line and the
 *  ingredient rewriter have to agree about what is code, or one of them rewrites
 *  a sample recipe while another protects the real one.
 *
 *  Per CommonMark a closing fence carries no info string and repeats the opening
 *  marker, so ```` ```js ```` inside an open block is ordinary content and a
 *  ``` cannot close a ~~~ block. */
function scanLines(md: string): DocLine[] {
  const lines: DocLine[] = [];
  let open: { char: string; len: number } | null = null;
  let i = 0;
  for (;;) {
    const nl = md.indexOf('\n', i);
    const end = nl === -1 ? md.length : nl;
    const text = md.slice(i, end);
    const fence = FENCE_RE.exec(text);
    let fenced = open !== null;
    if (fence) {
      const marker = fence[1]!;
      if (open === null) {
        open = { char: marker[0]!, len: marker.length };
        fenced = true;
      } else if (marker[0] === open.char && marker.length >= open.len && fence[2]!.trim() === '') {
        open = null;
        fenced = true;
      }
    }
    lines.push({ start: i, end, text, fenced });
    if (nl === -1) break;
    i = nl + 1;
  }
  return lines;
}

/** Walk to the `)` that closes `md[open]`, allowing balanced pairs inside.
 *  Wikipedia-style `..._(disambiguation)` targets are common, and stopping at the
 *  first `)` leaves the tail of the URL exposed to the rewriter. */
function closingParen(md: string, open: number): number {
  let depth = 0;
  for (let i = open; i < md.length; i++) {
    const c = md[i];
    if (c === '\n') return -1;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const REF_DEF_RE = /^[ \t]*\[[^\]\n]*\]:[ \t]*(\S+)/;
const AUTOLINK_RE = /<[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*>|<[^<>\s@]+@[^<>\s]+>/g;

/** Fenced blocks, inline code spans and every form of link/image *target*. Link
 *  text is ordinary prose and is deliberately left scannable. Getting a target
 *  wrong is worse than a wrong number: the rewriter emits `4 cups` where the
 *  source said `2cups`, and the injected space breaks the URL outright. */
function protectedRanges(md: string, lines: DocLine[] = scanLines(md)): Range[] {
  const ranges: Range[] = [];
  let runStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.fenced) {
      if (runStart < 0) runStart = lines[i]!.start;
      continue;
    }
    if (runStart >= 0) {
      ranges.push([runStart, lines[i - 1]!.end]);
      runStart = -1;
    }
  }
  if (runStart >= 0) ranges.push([runStart, md.length]);

  for (const m of md.matchAll(/(`+)[^`]*\1/g)) {
    if (!overlaps(ranges, m.index, m.index + m[0].length)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  // Every `](` on a line that also has a `[` opens a destination — scanning for
  // the delimiter rather than for the whole link is what catches the outer target
  // of a nested `[![alt](img)](target)`, whose inner match would otherwise have
  // advanced the cursor past it.
  for (let at = md.indexOf(']('); at !== -1; at = md.indexOf('](', at + 1)) {
    const lineStart = md.lastIndexOf('\n', at) + 1;
    if (md.lastIndexOf('[', at) < lineStart) continue;
    const open = at + 1;
    const close = closingParen(md, open);
    if (close !== -1 && !overlaps(ranges, open, close + 1)) ranges.push([open, close + 1]);
  }
  // Reference definitions (`[id]: url`) have no parentheses at all, and autolinks
  // (`<https://…>`) have no brackets; both are still link targets.
  for (const line of lines) {
    if (line.fenced) continue;
    const m = REF_DEF_RE.exec(line.text);
    if (!m) continue;
    const at = line.start + m[0].length - m[1]!.length;
    if (!overlaps(ranges, at, at + m[1]!.length)) ranges.push([at, at + m[1]!.length]);
  }
  for (const m of md.matchAll(AUTOLINK_RE)) {
    if (!overlaps(ranges, m.index, m.index + m[0].length)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

// ─── splitRecipe / parseServes ────────────────────────────────────────────────

// `\r?` so a CRLF document still finds its section: without it the whole file
// falls down the "no ingredients section" path, Serves is never scaled and no
// diagnostics are produced, while the prose pass still changes the quantities.
const INGREDIENTS_HEADING_RE = /^[ \t]*(#{1,6})[ \t]*ingredients[ \t]*\r?$/i;

/** Any ATX heading, capturing its level. As permissive about the missing space as
 *  the matcher above (`###Notes` counts), and just as strict about seven hashes. */
const ATX_HEADING_RE = /^[ \t]*(#{1,6})(?!#)/;

/** A Notes heading closes the ingredient list at *any* level. Level alone is not
 *  enough: an author who writes `# Ingredients` then `## Notes` means two sections,
 *  and swallowing their notes into the ingredients column — where every bullet is
 *  also scanned for amounts to scale — is exactly what this prevents. */
const NOTES_HEADING_RE = /^[ \t]*#{1,6}[ \t]*notes[ \t]*\r?$/i;

/**
 * Offset where the ingredient list ends: the start of the first heading after it
 * that is not one of its own groups, or the end of the document.
 *
 * Sub-headings *are* part of the list — `### Marinade` / `### To coat` is how a
 * recipe with parts is written, and each group's bullets scale like any other. A
 * heading at the list's own level or above is a new section of the recipe.
 */
function ingredientsEnd(md: string, lines: DocLine[], from: number, level: number): number {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    // A heading inside a code fence is a sample, not this document's structure.
    if (line.fenced) continue;
    const m = ATX_HEADING_RE.exec(line.text);
    if (!m) continue;
    if (m[1]!.length <= level || NOTES_HEADING_RE.test(line.text)) return line.start;
  }
  return md.length;
}

export function splitRecipe(md: string): RecipeSplit {
  const lines = scanLines(md);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.fenced) continue;
    const m = INGREDIENTS_HEADING_RE.exec(line.text);
    if (!m) continue;
    const after = line.end < md.length ? line.end + 1 : md.length;
    const end = ingredientsEnd(md, lines, i + 1, m[1]!.length);
    return {
      head: md.slice(0, line.start),
      heading: md.slice(line.start, after),
      body: md.slice(after, end),
      tail: md.slice(end),
    };
  }
  return { head: md, heading: null, body: '', tail: '' };
}

const SERVES_NUM_SRC = `\\d+(?:\\.\\d+)?`;
// `Serves: 4-6` is an extremely common idiom, and scaling only the first number
// produces a descending range — worse than leaving the line alone.
const SERVES_AMOUNT_SRC = `${SERVES_NUM_SRC}(?:${SEP_SRC}${SERVES_NUM_SRC})?`;
const SERVES_RE = new RegExp(
  `^[${WS}]*(?:[*+-][${WS}]+)?serves[${WS}]*:[${WS}]*(${SERVES_AMOUNT_SRC})`,
  'i',
);
const SERVES_RANGE_RE = new RegExp(`^(${SERVES_NUM_SRC})(${SEP_SRC})(${SERVES_NUM_SRC})$`, 'i');

function parseServesAmount(text: string): ParsedAmount {
  const m = SERVES_RANGE_RE.exec(text);
  if (m) return { values: [Number(m[1]), Number(m[3])], separator: m[2]! };
  return { values: [Number(text)], separator: '' };
}

/** Find the Serves line, ignoring any that is quoted inside a code fence — one
 *  in a sample block would otherwise both suppress the `no-serves-line` issue
 *  and get rewritten. A range is anchored on its lower bound, the count the
 *  recipe is actually written for; `rewriteServes` scales both ends. */
export function parseServes(ingredients: string): { value: number; line: string } | null {
  const lines = scanLines(ingredients);
  const skip = protectedRanges(ingredients, lines);
  for (const line of lines) {
    if (containedIn(skip, line.start, line.end)) continue;
    const m = SERVES_RE.exec(line.text);
    if (m) return { value: parseServesAmount(m[1]!).values[0]!, line: line.text };
  }
  return null;
}

function formatServes(value: number): string {
  const rounded = Math.round(value);
  // A recipe that scales down to "serves 0" is nonsense; show the fraction.
  return rounded === 0 ? value.toFixed(1) : String(rounded);
}

function rewriteServes(body: string, factor: number): string {
  const lines = scanLines(body);
  const skip = protectedRanges(body, lines);
  for (const line of lines) {
    if (containedIn(skip, line.start, line.end)) continue;
    const m = SERVES_RE.exec(line.text);
    if (!m) continue;
    const src = m[1]!;
    const { values, separator } = parseServesAmount(src);
    const scaled = values.map((v) => v * factor);
    // Same structural no-op as rewriteSpan: a pass that moves nothing must not
    // re-render the count, or `Serves: 2.5` becomes `Serves: 3` at factor 1.
    if (scaled.every((v, i) => v === values[i])) return body;
    const text = scaled.map(formatServes).join(separator);
    if (text === src) return body;
    const at = line.start + m[0].length - src.length;
    return body.slice(0, at) + text + body.slice(at + src.length);
  }
  return body;
}

// ─── Prose ────────────────────────────────────────────────────────────────────

// A number must be followed by a whitelisted unit to be prose-scalable, which is
// why `180 °C`, `30 minutes`, `20 cm`, `350F` and bare counts are never touched.
// `/` joins `.` in the lookbehind so the tail of a malformed compound fraction
// (`1 1/2/3`) is not picked up as an amount of its own.
const PROSE_RE = new RegExp(
  `(?<![A-Za-z0-9./])(${AMOUNT_SRC})[${WS}]?(${CONVERTIBLE_UNIT_SRC})`,
  'gi',
);

interface SpanScan {
  text: string;
  /** At least one real, unprotected amount+unit span was recognised. */
  found: boolean;
}

/** Rewrite every amount+unit span in `md[from, to)`. Offsets are absolute so a
 *  caller can scan part of a line and still test the shared protected ranges —
 *  and so the lookbehind still sees the character before `from`. */
function rewriteSpans(
  md: string,
  from: number,
  to: number,
  skip: Range[],
  opts: ScaleOptions,
): SpanScan {
  PROSE_RE.lastIndex = from;
  let out = '';
  let last = from;
  let found = false;
  for (let m = PROSE_RE.exec(md); m !== null; m = PROSE_RE.exec(md)) {
    const start = m.index;
    const end = start + m[0].length;
    if (end > to) break;
    if (overlaps(skip, start, end)) continue;
    if (amountValues(m[1]!) === null) continue;
    found = true;
    const replacement = rewriteSpan(m[0], m[1]!, m[2]!, opts);
    if (replacement === m[0]) continue;
    out += md.slice(last, start) + replacement;
    last = end;
  }
  return { text: out + md.slice(last, to), found };
}

function rewriteProse(md: string, opts: ScaleOptions): string {
  if (md === '') return md;
  return rewriteSpans(md, 0, md.length, protectedRanges(md), opts).text;
}

export function scaleProse(md: string, opts: ScaleOptions): ScaleResult {
  if (!usableFactor(opts.factor)) {
    return { text: md, issues: [{ line: '', reason: 'invalid-factor' }] };
  }
  return { text: rewriteProse(md, opts), issues: [] };
}

// ─── Ingredient lines ─────────────────────────────────────────────────────────

const LIST_MARKER_RE = new RegExp(`^([${WS}]*(?:[*+-]|\\d+\\.)[${WS}]+)`);
// The `(?!…)` escape hatch admits a unitless count (`2 eggs`), but it must not
// admit a number that is really part of a hyphenated dimension (`2-inch piece`,
// `9-inch tin`) or a prefix of a malformed fraction (`1 1/2/3`, where the amount
// alternatives would otherwise backtrack to the leading `1` and scale that alone,
// splicing arithmetic garbage in front of the orphaned remainder). Those are not
// quantities; prose scanning already refuses them, and the line is reported
// `unparseable-amount` instead of being half-rewritten.
const COUNT_TAIL_SRC = `(?![A-Za-z0-9/\\-–]|[${WS}]*[\\d/])`;
const LINE_AMOUNT_RE = new RegExp(
  `^(${AMOUNT_SRC})(?:[${WS}]*(${ANY_UNIT_SRC})|${COUNT_TAIL_SRC})`,
  'i',
);
/** The template's `* .` placeholder, and any bullet the user has not filled in. */
const PLACEHOLDER_RE = /^[.…\s]*$/;

/**
 * Rewrite one line of the ingredients body. The leading amount is handled first
 * (it is the one that may be a bare count), then the rest of the line goes
 * through the same span scanner prose uses, so a dual-unit parenthetical
 * (`1 cup (250 mL)`), a repeated-unit range (`1 cup to 2 cups`) and a bolded
 * quantity (`**2 cups**`) all stay consistent with the amount beside them.
 */
function rewriteIngredientLine(
  md: string,
  line: DocLine,
  skip: Range[],
  opts: ScaleOptions,
  issues: RecipeIssue[],
): string {
  // Only a *wholly* protected line (fenced code) is skipped outright. Testing the
  // whole line against the protected ranges would let one backticked note or one
  // link anywhere on the line freeze the amount at the start of it — silently,
  // since the line would never reach the issue reporting below.
  if (containedIn(skip, line.start, line.end)) return line.text;

  const marker = LIST_MARKER_RE.exec(line.text);
  const offset = marker ? marker[0].length : 0;
  const rest = line.text.slice(offset);
  const isBullet = marker !== null;
  if (isBullet && PLACEHOLDER_RE.test(rest)) return line.text;

  let head = '';
  let consumed = 0;
  let found = false;
  const m = LINE_AMOUNT_RE.exec(rest);
  if (m) {
    const start = line.start + offset;
    const end = start + m[0].length;
    const unitText = m[2] ?? '';
    const protectedHead = overlaps(skip, start, end);
    if (!protectedHead && amountValues(m[1]!) !== null) {
      found = true;
      consumed = m[0].length;
      if (unitText && !UNIT_MAP.has(unitText.toLowerCase())) {
        if (isBullet) issues.push({ line: line.text, reason: 'unknown-unit' });
        head = m[0];
      } else {
        head = rewriteSpan(m[0], m[1]!, unitText, opts);
      }
    }
  }

  const tail = rewriteSpans(md, line.start + offset + consumed, line.end, skip, opts);
  if (tail.found) found = true;
  // Nothing scalable on the line. Stay quiet if part of it is protected — the
  // author chose to freeze that text — otherwise say so.
  if (isBullet && !found && !overlaps(skip, line.start, line.end)) {
    issues.push({ line: line.text, reason: 'unparseable-amount' });
  }
  return line.text.slice(0, offset) + head + tail.text;
}

function rewriteIngredients(body: string, opts: ScaleOptions, issues: RecipeIssue[]): string {
  const lines = scanLines(body);
  const skip = protectedRanges(body, lines);
  return lines.map((line) => rewriteIngredientLine(body, line, skip, opts, issues)).join('\n');
}

// ─── scaleRecipe ──────────────────────────────────────────────────────────────

export function scaleRecipe(md: string, opts: ScaleOptions): ScaleResult {
  if (!usableFactor(opts.factor)) {
    return { text: md, issues: [{ line: '', reason: 'invalid-factor' }] };
  }
  const issues: RecipeIssue[] = [];
  const split = splitRecipe(md);
  const head = rewriteProse(split.head, opts);
  if (split.heading === null) {
    issues.push({ line: '', reason: 'no-ingredients-section' });
    return { text: head, issues };
  }
  const serves = parseServes(split.body);
  if (!serves) issues.push({ line: '', reason: 'no-serves-line' });
  let body = rewriteIngredients(split.body, opts, issues);
  if (serves) body = rewriteServes(body, opts.factor);
  // Whatever follows the list (`## Notes`, tips, a trailing method) is prose: its
  // amounts scale with the recipe, but a note is not an ingredient line, so nothing
  // there is reported as unparseable and no `Serves:` in it is mistaken for the real one.
  const tail = rewriteProse(split.tail, opts);
  return { text: head + split.heading + body + tail, issues };
}
