import { getServerConfig, authHeaders, type CurrentUser } from './config';

function url(path: string): string {
  return getServerConfig().url.replace(/\/$/, '') + path;
}

/** Pull the server's `{error}` message off a failed response, falling back to status. */
async function errMsg(res: Response, fallback: string): Promise<string> {
  const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
  return msg || `${fallback}: ${res.status}`;
}

export async function adminListUsers(): Promise<CurrentUser[]> {
  const res = await fetch(url('/api/users'), { headers: authHeaders(getServerConfig()) });
  if (!res.ok) throw new Error(`list users failed: ${res.status}`);
  return ((await res.json()) as { users: CurrentUser[] }).users;
}

export async function adminCreateUser(input: {
  username: string;
  password: string;
  displayName?: string;
  role?: 'admin' | 'member';
}): Promise<void> {
  const res = await fetch(url('/api/admin/users'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    throw new Error(msg || `create failed: ${res.status}`);
  }
}

export async function adminUpdateUser(
  id: string,
  patch: { role?: 'admin' | 'member'; password?: string; displayName?: string },
): Promise<void> {
  const res = await fetch(url(`/api/admin/users/${id}`), {
    method: 'PATCH',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'update failed'));
}

export async function adminDeleteUser(id: string): Promise<void> {
  const res = await fetch(url(`/api/admin/users/${id}`), {
    method: 'DELETE',
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'delete failed'));
}

// ----- API tokens -----------------------------------------------------------

export interface ApiToken {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
}

export async function adminListTokens(): Promise<ApiToken[]> {
  const res = await fetch(url('/api/admin/tokens'), { headers: authHeaders(getServerConfig()) });
  if (!res.ok) throw new Error(`list tokens failed: ${res.status}`);
  return ((await res.json()) as { tokens: ApiToken[] }).tokens;
}

/** Returns the plaintext token (shown only once). */
export async function adminCreateToken(input: {
  name: string;
  scopes: string[];
}): Promise<string> {
  const res = await fetch(url('/api/admin/tokens'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create token failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export async function adminRevokeToken(id: string): Promise<void> {
  const res = await fetch(url(`/api/admin/tokens/${id}`), {
    method: 'DELETE',
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
}

// ----- LLM agents -----------------------------------------------------------

export type AgentKind = 'openai' | 'anthropic' | 'webhook';

export interface Agent {
  id: string;
  user_id: string;
  name: string;
  kind: AgentKind;
  endpoint: string | null;
  model: string | null;
  system_prompt: string | null;
  enabled: boolean;
}

export async function adminListAgents(): Promise<Agent[]> {
  const res = await fetch(url('/api/admin/agents'), { headers: authHeaders(getServerConfig()) });
  if (!res.ok) throw new Error(`list agents failed: ${res.status}`);
  return ((await res.json()) as { agents: Agent[] }).agents;
}

/** Returns a one-time API token for webhook (agentic) agents, if issued. */
export async function adminCreateAgent(input: {
  name: string;
  username: string;
  kind: AgentKind;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
}): Promise<{ token?: string }> {
  const res = await fetch(url('/api/admin/agents'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    throw new Error(msg || `create failed: ${res.status}`);
  }
  return (await res.json()) as { token?: string };
}

export async function adminUpdateAgent(
  id: string,
  patch: Partial<{
    kind: AgentKind;
    endpoint: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    enabled: boolean;
  }>,
): Promise<void> {
  const res = await fetch(url(`/api/admin/agents/${id}`), {
    method: 'PATCH',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status}`);
}

export async function adminTestAgent(id: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(url(`/api/admin/agents/${id}/test`), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
  });
  return (await res.json()) as { ok: boolean; message: string };
}

export async function adminDeleteAgent(id: string): Promise<void> {
  const res = await fetch(url(`/api/admin/agents/${id}`), {
    method: 'DELETE',
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

// ----- natural-language commands (Stage 2) ----------------------------------

export interface NlConfig {
  enabled: boolean;
  keywords: string[];
}

/** Public config the Add box uses to decide when to trigger (any authed user). */
export async function getNlConfig(): Promise<NlConfig> {
  const res = await fetch(url('/api/agent/config'), { headers: authHeaders(getServerConfig()) });
  if (!res.ok) throw new Error(`nl config failed: ${res.status}`);
  return (await res.json()) as NlConfig;
}

export interface CommandReply {
  reply: string;
  executed?: unknown[];
  usage?: { input: number; output: number };
}

/** Run a natural-language command server-side (acts as the signed-in user). */
export async function runCommand(text: string): Promise<CommandReply> {
  const res = await fetch(url('/api/agent/command'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify({ text }),
  });
  if (res.status === 503) throw new Error('AI commands are not set up. Configure one in Settings → AI agents.');
  if (!res.ok) throw new Error(await errMsg(res, 'command failed'));
  return (await res.json()) as CommandReply;
}

// ----- Telegram (per-user account linking) ---------------------------------

export interface TelegramStatus {
  /** The server has a bot configured (TELEGRAM_BOT_TOKEN set). */
  enabled: boolean;
  botUsername: string | null;
  /** Present when this user's account is already linked to a chat. */
  link: { username: string | null } | null;
}

/** Telegram link status for the signed-in user (any authed user). */
export async function getTelegramStatus(): Promise<TelegramStatus> {
  const res = await fetch(url('/api/telegram'), { headers: authHeaders(getServerConfig()) });
  if (!res.ok) throw new Error(await errMsg(res, 'telegram status failed'));
  return (await res.json()) as TelegramStatus;
}

/** Issue a one-time code the user sends to the bot to link this account. */
export async function createTelegramCode(): Promise<{
  code: string;
  expiresAt: string;
  botUsername: string | null;
}> {
  const res = await fetch(url('/api/telegram/code'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
  });
  if (res.status === 503) throw new Error('The Telegram bot is not configured on this server.');
  if (!res.ok) throw new Error(await errMsg(res, 'could not create code'));
  return (await res.json()) as { code: string; expiresAt: string; botUsername: string | null };
}

/** Disconnect this user's Telegram chat. */
export async function deleteTelegramLink(): Promise<void> {
  const res = await fetch(url('/api/telegram'), {
    method: 'DELETE',
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'could not unlink'));
}

export interface NlSettings {
  agent_id: string | null;
  keywords: string[];
  enabled: boolean;
}

export async function adminGetNlSettings(): Promise<NlSettings> {
  const res = await fetch(url('/api/admin/nl-settings'), { headers: authHeaders(getServerConfig()) });
  if (!res.ok) throw new Error(`nl settings failed: ${res.status}`);
  return (await res.json()) as NlSettings;
}

export async function adminSetNlSettings(patch: Partial<NlSettings>): Promise<NlSettings> {
  const res = await fetch(url('/api/admin/nl-settings'), {
    method: 'PATCH',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'save failed'));
  return (await res.json()) as NlSettings;
}

export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

export async function adminGetNlUsage(): Promise<{
  total: UsageTotals;
  byKind: Record<string, UsageTotals>;
}> {
  const res = await fetch(url('/api/admin/nl-usage'), { headers: authHeaders(getServerConfig()) });
  if (!res.ok) throw new Error(`nl usage failed: ${res.status}`);
  return (await res.json()) as { total: UsageTotals; byKind: Record<string, UsageTotals> };
}
