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

interface FullAgentRow extends AgentRow {
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
}

// ----- LLM provider call ----------------------------------------------------

function snippet(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function callLLM(
  agent: FullAgentRow,
  system: string,
  userText: string,
  allowPrivate: boolean,
): Promise<string> {
  if (agent.kind === 'anthropic') {
    const url = `${(agent.endpoint || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
    const res = await safeFetch(url, allowPrivate, {
      method: 'POST',
      headers: {
        'x-api-key': agent.api_key ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: agent.model || 'claude-sonnet-4-6',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!res.ok) throw new LLMHttpError(res.status, `POST ${url}: ${snippet(await res.text())}`);
    const d = (await res.json()) as { content?: { text?: string }[] };
    return d.content?.[0]?.text ?? '';
  }
  // openai-compatible (OpenAI, OpenRouter, LM Studio, …). Endpoint must be the base
  // that exposes /chat/completions (usually ending in /v1).
  const url = `${(agent.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const res = await safeFetch(url, allowPrivate, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agent.api_key ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: agent.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    }),
  });
  if (!res.ok) throw new LLMHttpError(res.status, `POST ${url}: ${snippet(await res.text())}`);
  const d = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return d.choices?.[0]?.message?.content ?? '';
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
    const reply = await callLLM(
      agent,
      'You are a connectivity test.',
      'Reply with the word: ok',
      allowPrivate,
    );
    return { ok: true, message: `Model replied: ${snippet(reply.trim(), 80) || '(empty)'}` };
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

/** Allow only one provider call at a time (simple sequential queue). */
const queue: Array<() => Promise<void>> = [];
let pumping = false;
function enqueue(fn: () => Promise<void>): void {
  queue.push(fn);
  void pump();
}
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const fn = queue.shift()!;
    try {
      await fn();
    } catch (e) {
      console.error('[carbon] agent run error:', e);
    }
  }
  pumping = false;
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
    let reply = (
      await callLLM(agent, agent.system_prompt || DEFAULT_SYSTEM_PROMPT, userText, allowPrivate)
    ).trim();
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
        if (agent) enqueue(() => runAgent(db, deviceId, agent, c.item_id, 'mention', allowPrivate));
      }
    } else if (op.entity === 'assignee') {
      const a = op.data as { item_id: string; user_id: string; deleted?: boolean };
      if (a.deleted) continue;
      const agent = getAgentForUser(db, a.user_id);
      if (agent) enqueue(() => runAgent(db, deviceId, agent, a.item_id, 'assigned', allowPrivate));
    }
  }
}
