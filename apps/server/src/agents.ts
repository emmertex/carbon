import {
  type Db,
  getItem,
  getUser,
  listComments,
  addComment,
  setCompleted,
  createUser,
} from '@carbon/core';
import { EndpointError, safeFetch } from './safe-fetch';

// Endpoint reachability/validation problems are surfaced via EndpointError (the
// shared SSRF guard in ./safe-fetch); `describeAgentError` classifies it for the
// task comment.

/** A non-2xx response from the upstream provider; carries status + body for the log. */
class LLMHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${status}: ${detail}`);
  }
}

// openai/anthropic: Carbon calls the LLM directly and posts the reply.
// webhook: Carbon notifies an agentic framework (Hermes/OpenClaw) which acts back
//   via the Carbon REST API using its own token.
export type AgentKind = 'openai' | 'anthropic' | 'webhook';

export interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  kind: AgentKind;
  endpoint: string | null;
  model: string | null;
  system_prompt: string | null;
  enabled: boolean;
}

export function ensureAgentTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      endpoint      TEXT,
      api_key       TEXT,
      model         TEXT,
      system_prompt TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL
    );
  `);
}

// ----- token usage tracking + NL-command settings ---------------------------

/** Per-call LLM token usage, for the Settings usage readout. Server-only, never synced. */
export function ensureAgentUsageTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_usage (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      ts            TEXT NOT NULL,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      model         TEXT,
      request_kind  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_usage_kind ON agent_usage(request_kind);
  `);
}

export type UsageKind = 'comment_reply' | 'nl_command' | 'telegram_command' | 'filter_build';

export function recordAgentUsage(
  db: Db,
  agentId: string,
  usage: { input?: number; output?: number },
  model: string,
  kind: UsageKind,
): void {
  db.run(
    `INSERT INTO agent_usage (id, agent_id, ts, input_tokens, output_tokens, model, request_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      agentId,
      new Date().toISOString(),
      usage.input ?? 0,
      usage.output ?? 0,
      model,
      kind,
    ],
  );
}

export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/** Aggregate token totals overall and per request kind (for Settings). */
export function getAgentUsage(db: Db): { total: UsageTotals; byKind: Record<string, UsageTotals> } {
  const rows = db.all<{ request_kind: string; calls: number; inp: number; outp: number }>(
    `SELECT request_kind,
            COUNT(*) AS calls,
            COALESCE(SUM(input_tokens),0) AS inp,
            COALESCE(SUM(output_tokens),0) AS outp
     FROM agent_usage GROUP BY request_kind`,
  );
  const total: UsageTotals = { calls: 0, input_tokens: 0, output_tokens: 0 };
  const byKind: Record<string, UsageTotals> = {};
  for (const r of rows) {
    const t = { calls: Number(r.calls), input_tokens: Number(r.inp), output_tokens: Number(r.outp) };
    byKind[r.request_kind] = t;
    total.calls += t.calls;
    total.input_tokens += t.input_tokens;
    total.output_tokens += t.output_tokens;
  }
  return { total, byKind };
}

// NL-command settings live in the shared `meta` k/v table (same pattern as push/vapid).
function getMeta(db: Db, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null;
}
function setMeta(db: Db, key: string, value: string): void {
  db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** First-word keywords (case-insensitive) that route an Add-box entry to the LLM. */
export const DEFAULT_NL_KEYWORDS = ['can', 'add', 'remind', 'check off', 'mark off', 'mark as'];

export interface NlSettings {
  agentId: string | null;
  keywords: string[];
  enabled: boolean;
}

export function getNlSettings(db: Db): NlSettings {
  const agentId = getMeta(db, 'nl_agent_id') || null;
  let keywords = DEFAULT_NL_KEYWORDS;
  const raw = getMeta(db, 'nl_keywords');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === 'string');
    } catch {
      /* keep defaults */
    }
  }
  // Enabled only when explicitly on AND an agent is configured.
  const enabled = getMeta(db, 'nl_enabled') === '1' && !!agentId;
  return { agentId, keywords, enabled };
}

export function setNlSettings(
  db: Db,
  patch: { agentId?: string | null; keywords?: string[]; enabled?: boolean },
): void {
  if ('agentId' in patch) setMeta(db, 'nl_agent_id', patch.agentId ?? '');
  if (patch.keywords) setMeta(db, 'nl_keywords', JSON.stringify(patch.keywords));
  if ('enabled' in patch) setMeta(db, 'nl_enabled', patch.enabled ? '1' : '0');
}

export interface FullAgentRow extends AgentRow {
  api_key: string | null;
}

function mapRow(r: {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  api_key: string | null;
  model: string | null;
  system_prompt: string | null;
  enabled: number;
}): FullAgentRow {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    kind: r.kind as AgentKind,
    endpoint: r.endpoint,
    api_key: r.api_key,
    model: r.model,
    system_prompt: r.system_prompt,
    enabled: !!r.enabled,
  };
}

/** Public projection (no api_key). */
export function listAgents(db: Db): AgentRow[] {
  return db
    .all<Parameters<typeof mapRow>[0]>('SELECT * FROM agents ORDER BY created_at')
    .map(mapRow)
    .map(({ api_key: _k, ...rest }) => rest);
}

export function getAgent(db: Db, id: string): FullAgentRow | undefined {
  const r = db.get<Parameters<typeof mapRow>[0]>('SELECT * FROM agents WHERE id = ?', [id]);
  return r ? mapRow(r) : undefined;
}

/** The (enabled) agent driven by a given bot user, if any. */
export function getAgentForUser(db: Db, userId: string): FullAgentRow | undefined {
  const r = db.get<Parameters<typeof mapRow>[0]>(
    'SELECT * FROM agents WHERE user_id = ? AND enabled = 1',
    [userId],
  );
  return r ? mapRow(r) : undefined;
}

export interface CreateAgentInput {
  name: string;
  username: string;
  kind: AgentKind;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
}

export function createAgent(db: Db, input: CreateAgentInput): AgentRow {
  const user = createUser(db, { username: input.username, displayName: input.name, isBot: true });
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO agents (id, user_id, name, kind, endpoint, api_key, model, system_prompt, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      id,
      user.id,
      input.name,
      input.kind,
      input.endpoint ?? null,
      input.apiKey ?? null,
      input.model ?? null,
      input.systemPrompt ?? null,
      new Date().toISOString(),
    ],
  );
  return getAgent(db, id)!;
}

export function updateAgent(
  db: Db,
  id: string,
  patch: Partial<{
    kind: AgentKind;
    endpoint: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    enabled: boolean;
  }>,
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const map: Record<string, string> = {
    kind: 'kind',
    endpoint: 'endpoint',
    apiKey: 'api_key',
    model: 'model',
    systemPrompt: 'system_prompt',
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      sets.push(`${col} = ?`);
      vals.push((patch as Record<string, string>)[k] ?? null);
    }
  }
  if ('enabled' in patch) {
    sets.push('enabled = ?');
    vals.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, vals);
}

export function deleteAgent(db: Db, id: string): void {
  db.run('DELETE FROM agents WHERE id = ?', [id]);
  // Otherwise every deleted agent leaves its accumulated usage-log rows orphaned,
  // keyed by an agent_id nothing references anymore.
  db.run('DELETE FROM agent_usage WHERE agent_id = ?', [id]);
}

// ----- LLM provider call ----------------------------------------------------

function snippet(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Render "now" for the LLM prompt with the weekday name, an explicit UTC offset and IANA
 * zone name, so relative dates ("tomorrow night") resolve in the user's local time rather
 * than the server's (Carbon's server process runs in UTC; the client's zone is often
 * different). The weekday is spelled out because models cannot reliably derive it from a
 * date — "every Tuesday" was landing on Saturdays when the model guessed the weekday wrong.
 * Falls back to a plainly-labelled UTC instant when no (or an invalid) zone is known.
 */
export function formatNow(now: Date, timezone?: string | null): string {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      const local = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
      const offsetPart = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'longOffset',
      })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName')?.value;
      const offset = offsetPart?.replace('GMT', '') || '+00:00';
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now);
      return `${weekday} ${local}${offset === '' ? '+00:00' : offset} (${timezone})`;
    } catch {
      /* invalid zone name — fall through to the UTC form below */
    }
  }
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(now);
  return `${weekday} ${now.toISOString()} (UTC)`;
}

/** Token counts, normalised across providers (Anthropic input/output, OpenAI prompt/completion). */
export interface Usage {
  input: number;
  output: number;
}

/** Optional sampling/effort tuning for a chat call; omitted fields are not sent. Tool loops
 *  want near-deterministic routing (low temperature) and, on local reasoning models like
 *  GPT-OSS, minimal thinking (low effort = latency). Some hosted models reject these params
 *  (e.g. pinned temperature): a 400/422 is retried once without them, and the agent is
 *  remembered so subsequent calls skip tuning instead of paying the retry every time. */
export interface ChatTuning {
  temperature?: number;
  /** OpenAI-compatible reasoning models only (GPT-OSS, o-series). */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

// Agents whose provider demonstrably rejects tuning params (the stripped retry succeeded).
// In-memory: resets on restart, which is fine — it exists to avoid a retry per call.
const tuningRejectedAgents = new Set<string>();

/** A tool the model may call; `parameters` is a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: object;
}

/** A tool invocation the model returned. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Provider-agnostic chat message used to drive a tool loop. */
export type ChatMsg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * One turn of a (optionally tool-enabled) chat against the agent's provider. Returns the
 * assistant text, any tool calls, and normalised token usage. Used by both the comment-reply
 * path (no tools) and the in-app command loop (with tools).
 */
export async function chatLLM(
  agent: FullAgentRow,
  messages: ChatMsg[],
  tools: ToolDef[],
  allowPrivate: boolean,
  tuning?: ChatTuning,
): Promise<ChatResult> {
  if (agent.kind === 'anthropic') {
    const url = `${(agent.endpoint || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => (m as { content: string }).content)
      .join('\n\n');
    const amsgs = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'user') return { role: 'user', content: m.content };
        if (m.role === 'tool')
          return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
          };
        // assistant
        const blocks: unknown[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls ?? [])
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        return { role: 'assistant', content: blocks };
      });
    const body: Record<string, unknown> = {
      model: agent.model || 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: amsgs,
    };
    if (tuning?.temperature != null) body.temperature = tuning.temperature;
    if (system) body.system = system;
    if (tools.length)
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    const res = await safeFetch(url, allowPrivate, {
      method: 'POST',
      headers: {
        'x-api-key': agent.api_key ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new LLMHttpError(res.status, `POST ${url}: ${snippet(await res.text())}`);
    const d = (await res.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of d.content ?? []) {
      if (block.type === 'text') text += block.text ?? '';
      else if (block.type === 'tool_use')
        toolCalls.push({ id: block.id ?? '', name: block.name ?? '', args: parseArgs(block.input) });
    }
    return {
      text,
      toolCalls,
      usage: { input: d.usage?.input_tokens ?? 0, output: d.usage?.output_tokens ?? 0 },
    };
  }

  // openai-compatible (OpenAI, OpenRouter, LM Studio, …). Endpoint = base exposing
  // /chat/completions (usually ending in /v1).
  const url = `${(agent.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const omsgs = messages.map((m) => {
    if (m.role === 'tool')
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant')
      return {
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            }
          : {}),
      };
    return { role: m.role, content: m.content };
  });
  const body: Record<string, unknown> = { model: agent.model || 'gpt-4o-mini', messages: omsgs };
  if (tools.length)
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  const tuned = !!tuning && !tuningRejectedAgents.has(agent.id);
  if (tuned) {
    if (tuning.temperature != null) body.temperature = tuning.temperature;
    if (tuning.reasoningEffort) body.reasoning_effort = tuning.reasoningEffort;
  }
  const post = (b: Record<string, unknown>) =>
    safeFetch(url, allowPrivate, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.api_key ?? ''}`, 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });
  let res = await post(body);
  if (!res.ok && tuned && (res.status === 400 || res.status === 422) && ('temperature' in body || 'reasoning_effort' in body)) {
    // The 400 might be the provider rejecting the tuning params (pinned temperature, no
    // reasoning_effort support) — retry once without them. Only if the stripped retry
    // succeeds do we blame (and stop sending) tuning; otherwise report the original error.
    const detail = snippet(await res.text());
    const stripped = { ...body };
    delete stripped.temperature;
    delete stripped.reasoning_effort;
    const retry = await post(stripped);
    if (!retry.ok) throw new LLMHttpError(res.status, `POST ${url}: ${detail}`);
    console.log(
      `[carbon] agent "${agent.name}": provider rejected temperature/reasoning_effort (${detail}); ` +
        'succeeded without them — disabling tuning for this agent',
    );
    tuningRejectedAgents.add(agent.id);
    res = retry;
  }
  if (!res.ok) throw new LLMHttpError(res.status, `POST ${url}: ${snippet(await res.text())}`);
  const d = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const msg = d.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
    id: tc.id ?? '',
    name: tc.function?.name ?? '',
    args: parseArgs(tc.function?.arguments),
  }));
  return {
    text: msg?.content ?? '',
    toolCalls,
    usage: { input: d.usage?.prompt_tokens ?? 0, output: d.usage?.completion_tokens ?? 0 },
  };
}

/** Single-shot text completion (no tools), with usage — the comment-reply path. */
async function callLLM(
  agent: FullAgentRow,
  system: string,
  userText: string,
  allowPrivate: boolean,
): Promise<{ text: string; usage: Usage }> {
  const r = await chatLLM(
    agent,
    [
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ],
    [],
    allowPrivate,
  );
  return { text: r.text, usage: r.usage };
}

/** Notify an agentic framework (webhook kind) of a trigger; it acts back via API. */
async function callWebhook(
  db: Db,
  agent: FullAgentRow,
  taskId: string,
  reason: TriggerReason,
  allowPrivate: boolean,
): Promise<void> {
  if (!agent.endpoint) throw new EndpointError('no webhook URL is configured for this agent');
  const item = getItem(db, taskId);
  const comments = listComments(db, taskId).map((c) => ({
    author: c.author_id ? (getUser(db, c.author_id)?.username ?? null) : null,
    body: c.body,
    created_at: c.created_at,
  }));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (agent.api_key) headers['x-carbon-secret'] = agent.api_key;
  const res = await safeFetch(agent.endpoint, allowPrivate, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      event: reason,
      agent: agent.name,
      instructions: agent.system_prompt ?? undefined,
      task: item
        ? {
            id: item.id,
            title: item.title,
            note: item.note,
            status: item.status,
            due_date: item.due_date,
          }
        : { id: taskId },
      comments,
    }),
  });
  if (!res.ok)
    throw new LLMHttpError(res.status, `POST ${agent.endpoint}: ${snippet(await res.text())}`);
}

/** Live connectivity check for an agent (used by the Settings "Test" button). */
export async function testAgent(
  db: Db,
  id: string,
  allowPrivate: boolean,
): Promise<{ ok: boolean; message: string }> {
  const agent = getAgent(db, id);
  if (!agent) return { ok: false, message: 'agent not found' };
  try {
    if (agent.kind === 'webhook') {
      if (!agent.endpoint) return { ok: false, message: 'no webhook URL configured' };
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (agent.api_key) headers['x-carbon-secret'] = agent.api_key;
      const res = await safeFetch(agent.endpoint, allowPrivate, {
        method: 'POST',
        headers,
        body: JSON.stringify({ event: 'test', agent: agent.name }),
      });
      return res.ok
        ? { ok: true, message: `Webhook reachable (${res.status})` }
        : { ok: false, message: `Webhook ${res.status}: ${snippet(await res.text())}` };
    }
    const { text } = await callLLM(
      agent,
      'You are a connectivity test.',
      'Reply with the word: ok',
      allowPrivate,
    );
    return { ok: true, message: `Model replied: ${snippet(text.trim(), 80) || '(empty)'}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ----- run an agent on a task ----------------------------------------------

export type TriggerReason = 'mention' | 'assigned';

/** Default system prompt for direct-LLM agents (used when none is configured). */
export const DEFAULT_SYSTEM_PROMPT = `You are a concise assistant inside Carbon, a shared to-do / task manager. \
Each item is a task with a title, optional notes, dates, a project, and a comment thread where people \
(and you) collaborate. You have been mentioned or assigned on a task and are replying in its comment thread.

Work only from the details and discussion provided — you have limited information, so make reasonable \
assumptions instead of asking for more. Be practical and specific. Reply with a single short paragraph \
(a few sentences at most): no greeting, no sign-off, no markdown headings or bullet lists.`;

const PRIORITY_LABEL = ['None', 'Low', 'Medium', 'High'];

function buildContext(db: Db, agent: FullAgentRow, taskId: string, reason: TriggerReason): string {
  const item = getItem(db, taskId);
  if (!item) return '';
  const parent = item.parent_id ? getItem(db, item.parent_id) : undefined;
  const projectLabel = parent
    ? `${parent.title || '(untitled)'}${parent.type === 'project' ? '' : ' (parent task)'}`
    : 'Inbox (no project)';

  const lines: string[] = [
    'Here is a task you have been asked to comment on.',
    '',
    `Title: ${item.title || '(untitled)'}`,
    `Project: ${projectLabel}`,
    `Status: ${item.status}`,
    `Priority: ${PRIORITY_LABEL[item.priority] ?? item.priority}`,
  ];
  if (item.due_date) lines.push(`Due: ${item.due_date}`);
  if (item.defer_date) lines.push(`Deferred until: ${item.defer_date}`);
  lines.push(`Created: ${item.created_at}`);
  lines.push(`Notes: ${item.note ? '\n' + item.note : '(none)'}`);

  const comments = listComments(db, taskId);
  const tagged =
    reason === 'mention'
      ? [...comments].reverse().find((c) => (c.mentions ?? []).includes(agent.user_id))
      : undefined;
  if (comments.length) {
    lines.push('', 'Comment thread (oldest first):');
    for (const c of comments) {
      const who = c.author_id ? (getUser(db, c.author_id)?.username ?? 'user') : 'user';
      const mark = tagged && c.id === tagged.id ? '   ← you were tagged here' : '';
      lines.push(`- ${who}: ${c.body}${mark}`);
    }
  }

  lines.push('');
  lines.push(
    reason === 'assigned'
      ? 'You have been ASSIGNED this task. Help move it forward in one short paragraph. If you are confident it is fully done, end your reply with a final line containing only: COMPLETE'
      : 'Reply to the comment you were tagged in (above), in one short paragraph.',
  );
  return lines.join('\n');
}

/** Allow only one provider call at a time per tenant (simple sequential queue), so a
 *  slow/misconfigured LLM or webhook endpoint in one tenant can't head-of-line-block
 *  agent replies for every other tenant sharing the process. */
interface TenantQueue {
  jobs: Array<() => Promise<void>>;
  pumping: boolean;
}
const queues = new Map<string, TenantQueue>();
function enqueue(tenantId: string, fn: () => Promise<void>): void {
  let q = queues.get(tenantId);
  if (!q) {
    q = { jobs: [], pumping: false };
    queues.set(tenantId, q);
  }
  q.jobs.push(fn);
  void pump(tenantId, q);
}
async function pump(tenantId: string, q: TenantQueue): Promise<void> {
  if (q.pumping) return;
  q.pumping = true;
  while (q.jobs.length) {
    const fn = q.jobs.shift()!;
    try {
      await fn();
    } catch (e) {
      console.error('[carbon] agent run error:', e);
    }
  }
  q.pumping = false;
  if (q.jobs.length === 0) queues.delete(tenantId); // don't leak an entry per tenant forever
}

/**
 * Turn an internal agent error into a message that is both safe and useful to show
 * the people on the task. Configuration problems — the common case when wiring up an
 * LLM — get specific, actionable guidance; only genuine code faults fall back to
 * "contact support". The raw endpoint host and provider error body are never included
 * (they stay in the server log; A8).
 */
function describeAgentError(e: unknown, agent: FullAgentRow): string {
  const who = agent.name;
  const where = agent.kind === 'webhook' ? 'webhook' : 'LLM endpoint';
  const model = agent.model || '(default model)';

  if (e instanceof EndpointError) return `⚠️ ${who} can't run: ${e.message}.`;

  if (e instanceof LLMHttpError) {
    const s = e.status;
    if (s === 401 || s === 403)
      return `⚠️ ${who}: the ${where} rejected the request as unauthorized (HTTP ${s}). Check the API key in the agent's settings.`;
    if (s === 404) {
      const hint =
        agent.kind === 'openai'
          ? ' For OpenAI-compatible servers like LM Studio the endpoint should be the base URL ending in /v1.'
          : '';
      return `⚠️ ${who}: the ${where} returned 404 Not Found. Check the endpoint URL and that the model "${model}" exists.${hint}`;
    }
    if (s === 400 || s === 422)
      return `⚠️ ${who}: the ${where} rejected the request (HTTP ${s}) — usually the model name "${model}" is wrong or not loaded. Check the model in the agent's settings.`;
    if (s === 429)
      return `⚠️ ${who}: the ${where} rate-limited the request (HTTP 429). Wait a moment and try again, or check your provider quota.`;
    if (s >= 500)
      return `⚠️ ${who}: the ${where} returned a server error (HTTP ${s}). The model server may be down or overloaded — try again shortly.`;
    return `⚠️ ${who}: the ${where} returned HTTP ${s}. Check the agent's endpoint and model settings.`;
  }

  if (e instanceof SyntaxError)
    return `⚠️ ${who}: the ${where} returned a response that wasn't valid JSON. Check that the endpoint URL points at an LLM API and not a web page.`;

  // Node's fetch surfaces connection failures as a TypeError with a `cause.code`.
  const code =
    (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return `⚠️ ${who} couldn't connect to the ${where} — connection refused. Make sure the model server (e.g. LM Studio) is running and the endpoint URL and port are correct.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `⚠️ ${who} couldn't resolve the ${where} hostname. Check the endpoint URL in the agent's settings.`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `⚠️ ${who} timed out connecting to the ${where}. Check that the model server is running and reachable from this server.`;
    case 'ECONNRESET':
      return `⚠️ ${who} lost the connection to the ${where} (reset). Check the endpoint URL/port and whether it expects http vs https.`;
  }
  if (typeof code === 'string' && /CERT|SSL|TLS/i.test(code))
    return `⚠️ ${who} hit a TLS/certificate error reaching the ${where}. Check http vs https in the endpoint URL and the server's certificate.`;

  // Unknown / unexpected: more likely a bug than a configuration problem.
  return `⚠️ ${who} failed with an unexpected internal error. Please contact support.`;
}

async function runAgent(
  db: Db,
  deviceId: string,
  agent: FullAgentRow,
  taskId: string,
  reason: TriggerReason,
  allowPrivate: boolean,
): Promise<void> {
  const item = getItem(db, taskId);
  if (!item || item.deleted) return;
  try {
    if (agent.kind === 'webhook') {
      // Hand off to the agentic framework; it will comment/complete via the API.
      await callWebhook(db, agent, taskId, reason, allowPrivate);
      console.log(`[carbon] notified webhook agent "${agent.name}" for task ${taskId.slice(0, 8)}`);
      return;
    }
    const userText = buildContext(db, agent, taskId, reason);
    const llm = await callLLM(agent, agent.system_prompt || DEFAULT_SYSTEM_PROMPT, userText, allowPrivate);
    recordAgentUsage(db, agent.id, llm.usage, agent.model || '(default)', 'comment_reply');
    let reply = llm.text.trim();
    let complete = false;
    if (reason === 'assigned' && /(^|\n)\s*COMPLETE\s*$/.test(reply)) {
      complete = true;
      reply = reply.replace(/(^|\n)\s*COMPLETE\s*$/, '').trim();
    }
    if (reply) {
      addComment(db, deviceId, { itemId: taskId, authorId: agent.user_id, body: reply });
    } else if (!complete) {
      // Empty model reply, and nothing else happened — say so rather than going silent.
      addComment(db, deviceId, {
        itemId: taskId,
        authorId: agent.user_id,
        body: `${agent.name} has nothing to say.`,
      });
    }
    if (complete) setCompleted(db, deviceId, taskId, true);
    console.log(`[carbon] agent "${agent.name}" responded on task ${taskId.slice(0, 8)}`);
  } catch (e) {
    // Full detail (endpoint URL, upstream status + body) goes to the server log only.
    // The public comment is classified into actionable guidance for the common config
    // mistakes, but never echoes internal hostnames or provider error bodies (A8).
    console.error('[carbon] agent failed:', e);
    addComment(db, deviceId, {
      itemId: taskId,
      authorId: agent.user_id,
      body: describeAgentError(e, agent),
    });
  }
}

/**
 * Inspect freshly-ingested record ops for agent triggers: a comment that
 * @mentions a bot, or an assignment of a task to a bot. Bot-authored comments are
 * ignored (no loops). Runs are queued and processed asynchronously.
 */
export function triggerAgents(
  tenantId: string,
  db: Db,
  deviceId: string,
  fresh: Array<{ entity: string; data: unknown }>,
  allowPrivate: boolean,
): void {
  for (const op of fresh) {
    if (op.entity === 'comment') {
      const c = op.data as { item_id: string; author_id: string | null; mentions?: string[] };
      if (c.author_id && getUser(db, c.author_id)?.is_bot) continue; // ignore bot comments
      for (const uid of c.mentions ?? []) {
        const agent = getAgentForUser(db, uid);
        if (agent) enqueue(tenantId, () => runAgent(db, deviceId, agent, c.item_id, 'mention', allowPrivate));
      }
    } else if (op.entity === 'assignee') {
      const a = op.data as { item_id: string; user_id: string; deleted?: boolean };
      if (a.deleted) continue;
      const agent = getAgentForUser(db, a.user_id);
      if (agent) enqueue(tenantId, () => runAgent(db, deviceId, agent, a.item_id, 'assigned', allowPrivate));
    }
  }
}
