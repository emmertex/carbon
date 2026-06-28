import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  type Db,
  getItem,
  getUser,
  listComments,
  addComment,
  setCompleted,
  createUser,
} from '@carbon/core';

// ----- SSRF guard for agent endpoints ---------------------------------------
// An agent's endpoint/webhook URL is admin-supplied, so a malicious/curious tenant
// admin could point it at internal services or cloud metadata (169.254.169.254) and
// read the reflected response via the Test button. In multi-tenant mode (BASE_DOMAIN
// set) we block private/loopback/link-local targets. Self-hosters legitimately point
// agents at LAN LLMs (e.g. LM Studio on 10.x), so single-tenant mode allows private
// hosts; ALLOW_PRIVATE_AGENT_ENDPOINTS=1 forces the allow even under BASE_DOMAIN.
const BLOCK_PRIVATE_ENDPOINTS =
  !!process.env.BASE_DOMAIN && process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS !== '1';

function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb'))
      return true; // fe80::/10 link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 ULA
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable → treat unsafe
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata endpoint
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
  return false;
}

async function assertSafeEndpoint(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`invalid endpoint URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new Error(`endpoint must be http(s)`);
  if (!BLOCK_PRIVATE_ENDPOINTS) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost'))
    throw new Error('endpoint host not allowed');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('endpoint host not allowed (private/loopback)');
    return;
  }
  const addrs = await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error('endpoint resolves to a private address');
  }
}

/** fetch() that first refuses internal/loopback targets (see assertSafeEndpoint). */
async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  await assertSafeEndpoint(url);
  return fetch(url, init);
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

async function callLLM(agent: FullAgentRow, system: string, userText: string): Promise<string> {
  if (agent.kind === 'anthropic') {
    const url = `${(agent.endpoint || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
    const res = await safeFetch(url, {
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
    if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${snippet(await res.text())}`);
    const d = (await res.json()) as { content?: { text?: string }[] };
    return d.content?.[0]?.text ?? '';
  }
  // openai-compatible (OpenAI, OpenRouter, LM Studio, …). Endpoint must be the base
  // that exposes /chat/completions (usually ending in /v1).
  const url = `${(agent.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const res = await safeFetch(url, {
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
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${snippet(await res.text())}`);
  const d = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return d.choices?.[0]?.message?.content ?? '';
}

/** Notify an agentic framework (webhook kind) of a trigger; it acts back via API. */
async function callWebhook(
  db: Db,
  agent: FullAgentRow,
  taskId: string,
  reason: TriggerReason,
): Promise<void> {
  if (!agent.endpoint) throw new Error('no webhook URL configured');
  const item = getItem(db, taskId);
  const comments = listComments(db, taskId).map((c) => ({
    author: c.author_id ? (getUser(db, c.author_id)?.username ?? null) : null,
    body: c.body,
    created_at: c.created_at,
  }));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (agent.api_key) headers['x-carbon-secret'] = agent.api_key;
  const res = await safeFetch(agent.endpoint, {
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
  if (!res.ok) throw new Error(`POST ${agent.endpoint} → ${res.status}: ${snippet(await res.text())}`);
}

/** Live connectivity check for an agent (used by the Settings "Test" button). */
export async function testAgent(db: Db, id: string): Promise<{ ok: boolean; message: string }> {
  const agent = getAgent(db, id);
  if (!agent) return { ok: false, message: 'agent not found' };
  try {
    if (agent.kind === 'webhook') {
      if (!agent.endpoint) return { ok: false, message: 'no webhook URL configured' };
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (agent.api_key) headers['x-carbon-secret'] = agent.api_key;
      const res = await safeFetch(agent.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ event: 'test', agent: agent.name }),
      });
      return res.ok
        ? { ok: true, message: `Webhook reachable (${res.status})` }
        : { ok: false, message: `Webhook ${res.status}: ${snippet(await res.text())}` };
    }
    const reply = await callLLM(agent, 'You are a connectivity test.', 'Reply with the word: ok');
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

async function runAgent(
  db: Db,
  deviceId: string,
  agent: FullAgentRow,
  taskId: string,
  reason: TriggerReason,
): Promise<void> {
  const item = getItem(db, taskId);
  if (!item || item.deleted) return;
  try {
    if (agent.kind === 'webhook') {
      // Hand off to the agentic framework; it will comment/complete via the API.
      await callWebhook(db, agent, taskId, reason);
      console.log(`[carbon] notified webhook agent "${agent.name}" for task ${taskId.slice(0, 8)}`);
      return;
    }
    const userText = buildContext(db, agent, taskId, reason);
    let reply = (
      await callLLM(agent, agent.system_prompt || DEFAULT_SYSTEM_PROMPT, userText)
    ).trim();
    let complete = false;
    if (reason === 'assigned' && /(^|\n)\s*COMPLETE\s*$/.test(reply)) {
      complete = true;
      reply = reply.replace(/(^|\n)\s*COMPLETE\s*$/, '').trim();
    }
    if (reply) {
      addComment(db, deviceId, { itemId: taskId, authorId: agent.user_id, body: reply });
    }
    if (complete) setCompleted(db, deviceId, taskId, true);
    console.log(`[carbon] agent "${agent.name}" responded on task ${taskId.slice(0, 8)}`);
  } catch (e) {
    // Full detail (endpoint URL, upstream status + body) goes to the server log only.
    // The public comment stays generic so it can't leak internal hostnames or provider
    // error bodies to everyone on the task (A8).
    console.error('[carbon] agent failed:', e);
    addComment(db, deviceId, {
      itemId: taskId,
      authorId: agent.user_id,
      body: `⚠️ ${agent.name} couldn't complete this request. Check the server logs for details.`,
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
): void {
  for (const op of fresh) {
    if (op.entity === 'comment') {
      const c = op.data as { item_id: string; author_id: string | null; mentions?: string[] };
      if (c.author_id && getUser(db, c.author_id)?.is_bot) continue; // ignore bot comments
      for (const uid of c.mentions ?? []) {
        const agent = getAgentForUser(db, uid);
        if (agent) enqueue(() => runAgent(db, deviceId, agent, c.item_id, 'mention'));
      }
    } else if (op.entity === 'assignee') {
      const a = op.data as { item_id: string; user_id: string; deleted?: boolean };
      if (a.deleted) continue;
      const agent = getAgentForUser(db, a.user_id);
      if (agent) enqueue(() => runAgent(db, deviceId, agent, a.item_id, 'assigned'));
    }
  }
}
