/**
 * Recipe tidy-up: hand the model a note's Markdown, get a normalised version back.
 *
 * A single-shot LLM call with no tools — the whole answer IS the payload, so nothing is
 * parsed or executed; the client diffs it against the note and the user accepts or discards.
 * That makes the blast radius of a bad completion zero, which is why it can run on the
 * host-shared model. Token usage is billed under `recipe_optimise`.
 */
import {
  chatLLM,
  recordAgentUsage,
  type FullAgentRow,
  type ChatMsg,
} from './agents';
import type { AgentApiDeps } from './agent-ops';

/** Cup/tablespoon sizes differ by region and the model can't know which the user cooks by.
 *  Duplicated from the client's picker on purpose — the server never imports from apps/web. */
export type MeasureConvention = 'au' | 'us' | 'metric';

const CUP_ML: Record<MeasureConvention, { cup: number; tbsp: number }> = {
  au: { cup: 250, tbsp: 20 },
  us: { cup: 240, tbsp: 15 },
  metric: { cup: 250, tbsp: 15 },
};

/** Exported test-only: the section/sub-heading contract here has to match what the
 *  client's `splitRecipe` can place, and nothing else in this file would catch drift. */
export function buildSystem(convention: MeasureConvention): string {
  const { cup, tbsp } = CUP_ML[convention];
  return `You reorganise and normalise cooking recipes written in Markdown. Return ONLY the
rewritten Markdown — no commentary, no code fences.

Preserve exactly:
- the recipe's title heading
- every ingredient and every step (never invent, drop, or merge them)
- the recipe's own parts: ingredient groups (marinade, coating, sauce) and named method
  stages, in the same order, as "###" sub-headings
- every note, tip and substitution, under a "## Notes" section at the end
- any Markdown images, links, and tables

Structure the output as:
## <title>

## Procedure

### <stage name>            <- only if the recipe names its stages
<numbered steps, restarting at 1 in each stage>

## Ingredients
Serves: <N>

### <group name>            <- only if the recipe groups its ingredients
* <amount> <unit> <ingredient>

## Notes                    <- only if the recipe has notes or tips
* <note>

Sub-headings inside a section MUST be "###". A "##" heading ends the section, so an
ingredient group written as "## Marinade" breaks the ingredient list in half.
Add no group, stage or note the recipe does not already have: a flat method stays one
numbered list, and a recipe with no notes gets no Notes heading.

Convert EVERY measurement to metric:
- weights -> g or kg
- volumes -> mL or L, EXCEPT cup/tablespoon/teaspoon, which you keep as they are
- temperatures -> degrees Celsius (e.g. 350F -> 175 C)
- lengths -> cm
Use this cup standard where a conversion is unavoidable: ${cup} mL per cup,
${tbsp} mL per tablespoon, 5 mL per teaspoon.
If the recipe states no serving count, infer a sensible one and write it in Serves:.`;
}

/** Peel one whole-reply code fence off, for models that wrap the answer despite being told
 *  not to. Only when the fence encloses the ENTIRE reply and nothing else is fenced — a
 *  recipe with its own code block must survive untouched. Exported test-only. */
export function stripCodeFence(text: string): string {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return text.trim();
  const fences = lines.filter((l) => l.trimStart().startsWith('```')).length;
  if (fences !== 2) return text.trim();
  if (!/^```(markdown|md)?\s*$/i.test(lines[0].trim())) return text.trim();
  if (lines[lines.length - 1].trim() !== '```') return text.trim();
  return lines.slice(1, -1).join('\n').trim();
}

/** Generation budget for a whole-recipe rewrite. Deliberately generous: this is one long
 *  single-shot completion, not an interactive turn, and a self-hosted reasoning model can
 *  spend minutes on it. The per-user hourly cap, not this timeout, is what bounds cost. */
export const RECIPE_TIMEOUT_MS = 300_000;

export interface RecipeOptimiseResult {
  text: string;
  usage: { input: number; output: number };
}

/** Run the rewrite. Returns the model's Markdown verbatim (fence stripped); the caller
 *  decides what an empty result means. */
export async function runRecipeOptimise(
  deps: AgentApiDeps,
  agent: FullAgentRow,
  userId: string,
  body: string,
  allowPrivate: boolean,
  convention: MeasureConvention = 'au',
): Promise<RecipeOptimiseResult> {
  void userId; // signature parity with the other runners; the rewrite reads no user state
  const messages: ChatMsg[] = [
    { role: 'system', content: buildSystem(convention) },
    { role: 'user', content: body },
  ];
  // Low temperature: this is a reformat, not a creative task. A full recipe easily outruns
  // the 1024-token default, hence the raised cap — and emitting up to 4096 tokens is the
  // slowest thing any agent path does here. A local reasoning model thinks for a long
  // while before the first token, so this gets a budget well above the shared LLM default;
  // cutting it off mid-reasoning is indistinguishable, from the client, from the model
  // failing outright.
  const r = await chatLLM(agent, messages, [], allowPrivate, {
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: RECIPE_TIMEOUT_MS,
  });
  recordAgentUsage(deps.db, agent.id, r.usage, agent.model || '(default)', 'recipe_optimise');
  return { text: stripCodeFence(r.text), usage: r.usage };
}
