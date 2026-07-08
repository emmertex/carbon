/**
 * Natural-language → advanced filter expression.
 *
 * A single-shot LLM call: the model is given the FilterExpr grammar plus the user's
 * tags and projects (name → id), and must return the tree via one `build_filter`
 * tool call. The client validates the JSON before applying it, so a malformed or
 * partial result fails safe. Token usage is billed under `filter_build`.
 */
import { listTags, getProjects } from '@carbon/core';
import {
  chatLLM,
  recordAgentUsage,
  formatNow,
  type FullAgentRow,
  type ChatMsg,
  type ToolDef,
} from './agents';
import type { AgentApiDeps } from './agent-ops';

const MAX_LISTED = 120; // bound the prompt size on big workspaces

const BUILD_TOOL: ToolDef = {
  name: 'build_filter',
  description: 'Return the filter as a nested boolean expression (the FilterExpr tree).',
  parameters: {
    type: 'object',
    properties: { expr: { type: 'object', description: 'the FilterExpr JSON tree' } },
    required: ['expr'],
  },
};

const GRAMMAR = `type FilterExpr =
 | { type:'and', children: FilterExpr[] }
 | { type:'or', children: FilterExpr[] }
 | { type:'not', child: FilterExpr }
 | { type:'cond', cond: Condition }
type Condition =
 | {kind:'flagged'}
 | {kind:'completed'}
 | {kind:'priority', op:'eq'|'gte'|'lte', value:0|1|2|3}   // 3=High 2=Medium 1=Low 0=None
 | {kind:'dueWithinDays', days:number}   // due on/before now+days, includes overdue. "today"->0, "tomorrow"/"within a day"->1, "this week"->7
 | {kind:'dueAfterDays', days:number}
 | {kind:'noDueDate'}
 | {kind:'overdue'}
 | {kind:'deferred'}
 | {kind:'blocked'}
 | {kind:'onHold'}
 | {kind:'hasTag', tagId:string}
 | {kind:'inProject', projectId:string}
 | {kind:'titleContains', text:string}
 | {kind:'noteContains', text:string}`;

function buildSystem(
  tags: { id: string; name: string }[],
  projects: { id: string; title: string }[],
  now: Date,
  timezone?: string | null,
): string {
  const tagLines = tags.length
    ? tags.map((t) => `  ${t.name} -> ${t.id}`).join('\n')
    : '  (none)';
  const projLines = projects.length
    ? projects.map((p) => `  ${p.title || 'Untitled'} -> ${p.id}`).join('\n')
    : '  (none)';
  return `You convert a user's natural-language description into a Carbon task filter, expressed as a \
nested boolean JSON tree. Call build_filter exactly once with {expr: <the tree>}. Do not write prose.

Grammar (TypeScript):
${GRAMMAR}

Rules:
- Mirror the user's boolean logic with and/or/not; nest groups for parentheses.
- "high priority" -> priority gte 3; "at least medium" -> priority gte 2.
- Resolve tag/project NAMES to the ids listed below. If a referenced tag/project isn't listed, \
fall back to {kind:'titleContains', text:"..."} or omit it.
- Relative dates use dueWithinDays/dueAfterDays (in days from now).

Available tags (name -> id):
${tagLines}

Available projects (name -> id):
${projLines}

Current date and time: ${formatNow(now, timezone)}. "Today" means the user's local calendar day in \
that zone, not UTC.

Example — "due within 1 day, or due within 2 days and high priority, or flagged; but not tagged OnHold":
{"type":"and","children":[
 {"type":"or","children":[
   {"type":"cond","cond":{"kind":"dueWithinDays","days":1}},
   {"type":"and","children":[{"type":"cond","cond":{"kind":"dueWithinDays","days":2}},{"type":"cond","cond":{"kind":"priority","op":"gte","value":3}}]},
   {"type":"cond","cond":{"kind":"flagged"}}
 ]},
 {"type":"not","child":{"type":"cond","cond":{"kind":"hasTag","tagId":"<the OnHold tag id>"}}}
]}`;
}

/** Find the first balanced JSON object in a string (fallback when no native tool call).
 *  Tracks whether we're inside a quoted string (respecting backslash escapes) so a brace
 *  inside a string value (e.g. a titleContains text) doesn't throw off the depth count.
 *  Exported test-only. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface FilterCommandResult {
  expr: unknown | null;
  usage: { input: number; output: number };
}

/** Run the NL→filter conversion. Returns the raw expr (validated by the caller). */
export async function runFilterCommand(
  deps: AgentApiDeps,
  agent: FullAgentRow,
  userId: string,
  text: string,
  allowPrivate: boolean,
  now: Date = new Date(),
  timezone?: string | null,
): Promise<FilterCommandResult> {
  const tags = listTags(deps.db)
    .filter((t) => !t.deleted)
    .slice(0, MAX_LISTED)
    .map((t) => ({ id: t.id, name: t.name }));
  const projects = getProjects(deps.db)
    .slice(0, MAX_LISTED)
    .map((p) => ({ id: p.id, title: p.title }));

  const messages: ChatMsg[] = [
    { role: 'system', content: buildSystem(tags, projects, now, timezone) },
    { role: 'user', content: text },
  ];
  // Deterministic structured output — same low-temperature/low-effort tuning as the command loop.
  const r = await chatLLM(agent, messages, [BUILD_TOOL], allowPrivate, { temperature: 0.2, reasoningEffort: 'low' });
  recordAgentUsage(deps.db, agent.id, r.usage, agent.model || '(default)', 'filter_build');

  const call = r.toolCalls.find((c) => c.name === 'build_filter');
  let expr: unknown | null = (call?.args as { expr?: unknown } | undefined)?.expr ?? null;
  // Weak/local models may emit the tree as JSON text instead of a tool call.
  if (expr == null) {
    const parsed = extractJsonObject(r.text) as { expr?: unknown } | null;
    expr = parsed && typeof parsed === 'object' && 'expr' in parsed ? parsed.expr : parsed;
  }
  return { expr, usage: r.usage };
}
