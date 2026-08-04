import { useEffect, useMemo, useState } from 'react';
import { Pencil, Sparkles } from 'lucide-react';
import { getItem } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useStore } from '@/lib/store';
import { patchNoteMeta, readNoteMeta } from '@/lib/noteMeta';
import {
  actionableIssues,
  isBlankRecipe,
  parseServes,
  scaleRecipe,
  splitRecipe,
  type RecipeIssue,
  type UnitMode,
} from '@/lib/recipe';
import { buildRecipeImportPrompt } from '@/lib/recipePrompt';
import { cn } from '@/lib/cn';
import { Markdown } from './Markdown';
import { SegmentedControl, type SegmentOption } from './ui/SegmentedControl';
import { inputCls } from './ui/controls';
import { OptimisePreview } from './OptimisePreview';

type ServingsChoice = '0.5' | '1' | '2' | '4' | 'custom';

/** Pills are MULTIPLIERS over the recipe's own `Serves:` count; the resulting
 *  count is what gets persisted, so it survives an edit to the Serves line. */
const MULTIPLIERS: { id: ServingsChoice; label: string; value: number }[] = [
  { id: '0.5', label: '½', value: 0.5 },
  { id: '1', label: '1', value: 1 },
  { id: '2', label: '2', value: 2 },
  { id: '4', label: '4', value: 4 },
];

const SERVINGS_OPTIONS: SegmentOption<ServingsChoice>[] = [
  ...MULTIPLIERS.map((m) => ({ value: m.id, label: m.label })),
  { value: 'custom' as const, label: 'Custom' },
];

const UNIT_OPTIONS: SegmentOption<UnitMode>[] = [
  { value: 'original', label: 'Original', title: 'Leave cups and spoons as the author wrote them' },
  { value: 'mlCups', label: 'mL for cups', title: 'Convert cups to millilitres' },
  { value: 'mlAll', label: 'mL for all', title: 'Convert cups and spoons to millilitres' },
];

const actionBtn =
  'flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-muted hover:bg-surface-2 hover:text-text';

/** Metadata is parsed, not validated (see noteMeta.ts), so every read is a guard. */
function readUnits(v: unknown): UnitMode {
  return v === 'mlCups' || v === 'mlAll' ? v : 'original';
}

function readCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function formatCount(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function formatFactor(f: number): string {
  const r = Math.round(f * 1000) / 1000;
  if (r === 0.25) return '¼';
  if (r === 0.5) return '½';
  if (r === 0.75) return '¾';
  return String(r);
}

/** Quote an offending ingredient line back at the user, without its bullet. */
function sampleLine(line: string): string {
  const t = line.replace(/^[\s*+-]+/, '').replace(/^\d+\.\s*/, '').trim();
  return t.length > 48 ? t.slice(0, 47) + '…' : t;
}

function issueMessage(all: RecipeIssue[]): string | null {
  const issues = actionableIssues(all);
  if (issues.length === 0) return null;
  // Prefer an issue that can name a line — it is the one the user can act on.
  const quotable = issues.find((i) => i.line.trim() !== '');
  if (quotable) {
    const what =
      quotable.reason === 'unknown-unit'
        ? 'Some units can’t be converted'
        : 'Some amounts couldn’t be read';
    return `${what} (${sampleLine(quotable.line)}). Optimise this recipe to convert everything to metric.`;
  }
  if (issues.some((i) => i.reason === 'no-ingredients-section')) {
    return 'This note has no Ingredients section, so only the prose is scaled. Optimise this recipe to give it one.';
  }
  if (issues.some((i) => i.reason === 'no-serves-line')) {
    return 'This recipe has no Serves line, so the servings pills are a plain multiplier. Optimise this recipe to add one.';
  }
  return 'This recipe couldn’t be scaled cleanly. Optimise it to convert everything to metric.';
}

/**
 * Read view for a recipe note: procedure and ingredients side by side, with
 * servings and unit controls.
 *
 * Scaling is a pure render-time transform. The stored `body` is the only base —
 * every re-scale runs from it, never from the previous render — so ×2 then ×½
 * returns the original string, and there is no path from the scaled text into a
 * save. The only things this component persists are `{ servings, units }` (via
 * `patchNoteMeta`) and, when the user explicitly accepts an Optimise result, the
 * proposed markdown handed to `onReplace`. Editing is the Edit button, not a click
 * on the text — a stray click must not be able to open an editor over scaled text.
 */
export function RecipeView({
  id,
  body,
  onEdit,
  onReplace,
  className,
}: {
  /** Item id — used to persist servings/units via patchNoteMeta. */
  id: string;
  /** The stored, UNSCALED markdown. RecipeView never writes this. */
  body: string;
  /** User clicked Edit; the parent swaps RecipeView out for NoteEditor. */
  onEdit: () => void;
  /** User accepted an Optimise result; parent persists it via its commitNote path. */
  onReplace: (next: string) => void;
  className?: string;
}) {
  const convention = useStore((s) => s.uiPrefs.cupConvention);
  const nlEnabled = useStore((s) => s.nlEnabled);
  const meta = useQuery((db) => readNoteMeta(getItem(db, id) ?? { metadata: null }), [id]);

  // `customMode` is UI-only: it keeps the Custom pill selected while the typed
  // count happens to equal a multiplier (and while the field is momentarily blank).
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState<string | null>(null);
  const [optimising, setOptimising] = useState(false);

  useEffect(() => {
    setCustomMode(false);
    setCustomText(null);
    setOptimising(false);
  }, [id]);

  const stored = meta?.recipe;
  const units = readUnits(stored?.units);

  // Base is the recipe's own count, read from the UNSCALED body. No Serves line =>
  // base 1, which turns the pills into pure multipliers.
  const serves = useMemo(() => parseServes(splitRecipe(body).body), [body]);
  const base = readCount(serves?.value) ?? 1;
  const target = readCount(stored?.servings) ?? base;
  const factor = target / base;

  const scaled = useMemo(
    () => scaleRecipe(body, { factor, units, convention }),
    [body, factor, units, convention],
  );
  const split = useMemo(() => splitRecipe(scaled.text), [scaled.text]);

  // Still the seeded template — nothing written yet, so the import hint is welcome
  // rather than clutter.
  const blank = useMemo(() => isBlankRecipe(body), [body]);

  async function copyImportPrompt() {
    const prompt = buildRecipeImportPrompt(convention);
    try {
      await navigator.clipboard.writeText(prompt);
      useStore.getState().showToast({ message: 'Prompt copied — paste it on the recipe page' });
    } catch {
      // Insecure context (plain http on a LAN address) has no clipboard API.
      useStore.getState().showToast({ message: 'Copy failed — clipboard unavailable here' });
    }
  }

  const matched = MULTIPLIERS.find((m) => Math.abs(m.value * base - target) < 1e-9);
  const selection: ServingsChoice = customMode || !matched ? 'custom' : matched.id;
  const banner = nlEnabled ? issueMessage(scaled.issues) : null;

  function chooseServings(choice: ServingsChoice) {
    if (choice === 'custom') {
      setCustomMode(true);
      setCustomText(formatCount(target));
      return;
    }
    const m = MULTIPLIERS.find((x) => x.id === choice);
    if (!m) return;
    setCustomMode(false);
    setCustomText(null);
    patchNoteMeta(id, { recipe: { servings: base * m.value } });
  }

  function changeCustom(text: string) {
    setCustomText(text);
    const n = Number(text);
    // A blank or garbage entry keeps the last good count rather than sending a
    // factor scaleRecipe would have to reject.
    if (text.trim() === '' || !Number.isFinite(n) || n <= 0) return;
    patchNoteMeta(id, { recipe: { servings: n } });
  }

  const ingredients = split.body.trim() === '' ? null : split.body;
  const procedure = split.head.trim() === '' ? null : split.head;
  // `## Notes` and anything else after the ingredient list. It keeps its own heading,
  // so it reads as a section of the recipe rather than a continuation of the method.
  const tail = split.tail.trim() === '' ? null : split.tail;

  return (
    <>
      {/* `@container` sets container-type, which also makes this element the
          containing block for fixed-position descendants — so OptimisePreview's
          scrim is deliberately mounted outside it, or it would cover only this box. */}
      <div className={cn('@container', className)}>
        <div className="mb-3 flex items-center justify-end gap-1.5">
          {nlEnabled && (
            <button type="button" onClick={() => setOptimising(true)} className={actionBtn}>
              <Sparkles size={13} /> Optimise
            </button>
          )}
          <button type="button" onClick={onEdit} className={actionBtn}>
            <Pencil size={13} /> Edit
          </button>
        </div>

        {banner && (
          <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {banner}
          </div>
        )}

        {/* Only while the note is still the untouched template: the moment there is a
            recipe here, this is noise. Copies a prompt for an agentic browser sitting
            on a recipe page, which returns Markdown in exactly the shape below. */}
        {blank && (
          <div className="mb-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-text-muted">
            Starting from a recipe on the web?{' '}
            <button
              type="button"
              onClick={copyImportPrompt}
              className="font-medium text-accent underline underline-offset-2 hover:no-underline"
            >
              Copy browser-assistant prompt
            </button>
            {' '}— paste it to an assistant on the recipe’s page, then paste its answer here.
          </div>
        )}

        {/* DOM order: ingredients, then procedure. Column => ingredients on top.
            Row-reverse at >=672px => procedure left, ingredients right.

            The breakpoint is in PIXELS, not the `@2xl` (42rem) preset, because
            index.css scales the root font to 120% below a 1024px viewport to grow
            text and tap targets. A rem-based container query scales with it, so
            `@2xl` would mean 672px on desktop but 806px on precisely the compact
            screens it was meant to catch — a landscape phone at ~700px would stay
            stacked. Pixels keep the split tied to available width, which is what
            actually decides whether two columns fit. */}
        <div className="flex flex-col gap-5 @min-[672px]:flex-row-reverse @min-[672px]:items-start">
          <aside className="@min-[672px]:sticky @min-[672px]:top-4 @min-[672px]:w-72 @min-[672px]:shrink-0">
            <div className="rounded-xl border border-border bg-surface-2 p-3">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-text-muted">Servings</span>
                <span className="text-xs text-text-faint">
                  {serves ? `Serves ${formatCount(target)}` : `×${formatFactor(factor)}`}
                </span>
              </div>
              <SegmentedControl
                value={selection}
                onChange={chooseServings}
                options={SERVINGS_OPTIONS}
              />
              {selection === 'custom' && (
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="decimal"
                  aria-label="Servings"
                  value={customText ?? formatCount(target)}
                  onChange={(e) => changeCustom(e.target.value)}
                  className={cn(inputCls, 'mt-2 w-24')}
                />
              )}

              <span className="mb-1 mt-3 block text-xs font-medium text-text-muted">Units</span>
              <SegmentedControl
                value={units}
                onChange={(v) => patchNoteMeta(id, { recipe: { units: v } })}
                options={UNIT_OPTIONS}
              />

              {(factor !== 1 || units !== 'original') && (
                <p className="mt-2 text-xs text-text-faint">
                  {factor !== 1
                    ? `Showing ×${formatFactor(factor)} — the saved recipe is unchanged.`
                    : 'Showing converted units — the saved recipe is unchanged.'}
                </p>
              )}

              <div className="mt-3 border-t border-border pt-3">
                <span className="mb-1 block text-xs font-medium text-text-muted">Ingredients</span>
                {ingredients ? (
                  <Markdown>{ingredients}</Markdown>
                ) : (
                  <p className="text-sm text-text-faint">No ingredients section.</p>
                )}
              </div>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            {procedure && <Markdown>{procedure}</Markdown>}
            {tail && <Markdown className={procedure ? 'mt-4' : undefined}>{tail}</Markdown>}
            {!procedure && !tail && <p className="text-sm text-text-faint">Nothing here yet.</p>}
          </div>
        </div>
      </div>

      {optimising && (
        <OptimisePreview
          body={body}
          convention={convention}
          onCancel={() => setOptimising(false)}
          onReplace={(next) => {
            setOptimising(false);
            onReplace(next);
          }}
        />
      )}
    </>
  );
}
