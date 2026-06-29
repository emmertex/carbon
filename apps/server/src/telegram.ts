/**
 * Per-server Telegram bot.
 *
 * One bot serves the whole server (every workspace), not one bot per workspace. A Telegram
 * chat links to an individual **Carbon user** in a chosen workspace via a one-time code the
 * user generates in Settings → Telegram (proving they're logged in as that user). Once linked,
 * every message runs through the SAME natural-language tool-loop as the in-app "Add" box
 * (`runAgentCommand`), scoped to that user — but in *conversational* mode, so the bot can also
 * answer questions ("what's due tomorrow in the work project?") and give richer feedback.
 *
 * All Telegram state lives in the **control DB** (always present, even single-tenant self-host),
 * because the bot is per-server and must map a chat to (workspace, user) across tenants.
 *
 * Transport is a Telegram **webhook**: Telegram POSTs updates to `POST /telegram/webhook`
 * (a top-level route in index.ts), authenticated by a secret token header.
 */
import { randomInt } from 'node:crypto';
import { type Db, getUser } from '@carbon/core';
import { sha256Hex } from './auth';
import { getAgent, getNlSettings } from './agents';
import { buildAgentApiDeps } from './agent-ops';
import { runAgentCommand } from './agent-command';
import type { TenantRegistry } from './tenant';

const CODE_TTL_MS = 10 * 60 * 1000; // pairing codes are short-lived
const CODE_MAX_ATTEMPTS = 5; // wrong-workspace / bad redemptions before a code is burned
// Unambiguous alphabet (no 0/O/1/I) — codes are read off one screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

const PER_CHAT_HOUR = Math.max(1, Number(process.env.TELEGRAM_PER_CHAT_HOUR) || 120);
const TG_MAX_LEN = 4096; // Telegram's per-message character cap
// How many recent messages (user+assistant) to keep and replay as context per chat. 6 ≈ the
// last three exchanges — enough for "add eggs to it" follow-ups without bloating the prompt.
const HISTORY_MAX = Math.max(0, Number(process.env.TELEGRAM_HISTORY_MESSAGES) || 6);

// ----- control-DB schema -----------------------------------------------------

export function ensureTelegramTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_links (
      chat_id    TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      subdomain  TEXT,
      user_id    TEXT NOT NULL,
      username   TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tg_links_user ON telegram_links(tenant_id, user_id);
    CREATE TABLE IF NOT EXISTS telegram_state (
      chat_id    TEXT PRIMARY KEY,
      step       TEXT NOT NULL,
      subdomain  TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_codes (
      code_hash  TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      subdomain  TEXT,
      user_id    TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tg_hist_chat ON telegram_history(chat_id, id);
  `);
}

// ----- conversation history (rolling per-chat context) -----------------------

/** Append a turn and trim the chat back to the most recent HISTORY_MAX messages. */
function appendHistory(db: Db, chatId: string, role: 'user' | 'assistant', content: string): void {
  if (HISTORY_MAX === 0) return;
  db.run('INSERT INTO telegram_history (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)', [
    chatId,
    role,
    content,
    new Date().toISOString(),
  ]);
  db.run(
    `DELETE FROM telegram_history WHERE chat_id = ? AND id NOT IN
       (SELECT id FROM telegram_history WHERE chat_id = ? ORDER BY id DESC LIMIT ?)`,
    [chatId, chatId, HISTORY_MAX],
  );
}

/** The chat's recent turns, oldest first, for replaying as context. */
function getHistory(db: Db, chatId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (HISTORY_MAX === 0) return [];
  const rows = db.all<{ role: string; content: string }>(
    'SELECT role, content FROM telegram_history WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
    [chatId, HISTORY_MAX],
  );
  return rows.reverse().map((r) => ({
    role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: r.content,
  }));
}

function clearHistory(db: Db, chatId: string): void {
  db.run('DELETE FROM telegram_history WHERE chat_id = ?', [chatId]);
}

// ----- pairing codes ----------------------------------------------------------

function genCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Normalise user-typed codes: uppercase, strip spaces/dashes (people add them). */
function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface CodeTarget {
  tenantId: string;
  subdomain: string | null;
  userId: string;
}

/**
 * Issue a one-time link code for a user, replacing any code they had outstanding. Returns the
 * PLAINTEXT code (shown once, in Settings) and its expiry; only the hash is stored.
 */
export function createTelegramCode(db: Db, target: CodeTarget): { code: string; expiresAt: string } {
  ensureTelegramTables(db);
  // One live code per user — drop any previous one so an old code can't linger.
  db.run('DELETE FROM telegram_codes WHERE tenant_id = ? AND user_id = ?', [
    target.tenantId,
    target.userId,
  ]);
  const code = genCode();
  const now = Date.now();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  db.run(
    `INSERT INTO telegram_codes (code_hash, tenant_id, subdomain, user_id, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [sha256Hex(code), target.tenantId, target.subdomain, target.userId, expiresAt, new Date(now).toISOString()],
  );
  return { code, expiresAt };
}

export type RedeemResult =
  | { ok: true; tenantId: string; subdomain: string | null; userId: string }
  | { ok: false; error: 'bad_code' | 'expired' | 'wrong_workspace' };

/**
 * Redeem a code. Single-use: a successful redemption deletes it. When `expectedSubdomain` is
 * given (multi-tenant, the user named a workspace first) the code must belong to it.
 */
export function redeemTelegramCode(
  db: Db,
  rawCode: string,
  expectedSubdomain?: string | null,
): RedeemResult {
  ensureTelegramTables(db);
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LEN) return { ok: false, error: 'bad_code' };
  const row = db.get<{
    code_hash: string;
    tenant_id: string;
    subdomain: string | null;
    user_id: string;
    expires_at: string;
    attempts: number;
  }>('SELECT * FROM telegram_codes WHERE code_hash = ?', [sha256Hex(code)]);
  if (!row) return { ok: false, error: 'bad_code' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.run('DELETE FROM telegram_codes WHERE code_hash = ?', [row.code_hash]);
    return { ok: false, error: 'expired' };
  }
  if (expectedSubdomain !== undefined && (row.subdomain ?? null) !== (expectedSubdomain ?? null)) {
    const attempts = row.attempts + 1;
    if (attempts >= CODE_MAX_ATTEMPTS) {
      db.run('DELETE FROM telegram_codes WHERE code_hash = ?', [row.code_hash]);
    } else {
      db.run('UPDATE telegram_codes SET attempts = ? WHERE code_hash = ?', [attempts, row.code_hash]);
    }
    return { ok: false, error: 'wrong_workspace' };
  }
  db.run('DELETE FROM telegram_codes WHERE code_hash = ?', [row.code_hash]);
  return { ok: true, tenantId: row.tenant_id, subdomain: row.subdomain ?? null, userId: row.user_id };
}

// ----- links + per-user helpers (used by the /api/telegram routes) ------------

export interface TelegramLink {
  chat_id: string;
  tenant_id: string;
  subdomain: string | null;
  user_id: string;
  username: string | null;
}

function getLinkByChat(db: Db, chatId: string): TelegramLink | null {
  return db.get<TelegramLink>('SELECT * FROM telegram_links WHERE chat_id = ?', [chatId]) ?? null;
}

/** The chat linked to a given user in a workspace, if any (for the Settings status readout). */
export function getTelegramLinkForUser(
  db: Db,
  tenantId: string,
  userId: string,
): { chat_id: string; username: string | null } | null {
  ensureTelegramTables(db);
  return (
    db.get<{ chat_id: string; username: string | null }>(
      'SELECT chat_id, username FROM telegram_links WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId],
    ) ?? null
  );
}

/** Unlink a user's chat(s). Returns how many links were removed. */
export function unlinkTelegramUser(db: Db, tenantId: string, userId: string): number {
  ensureTelegramTables(db);
  const links = db.all<{ chat_id: string }>(
    'SELECT chat_id FROM telegram_links WHERE tenant_id = ? AND user_id = ?',
    [tenantId, userId],
  );
  for (const l of links) db.run('DELETE FROM telegram_state WHERE chat_id = ?', [l.chat_id]);
  db.run('DELETE FROM telegram_links WHERE tenant_id = ? AND user_id = ?', [tenantId, userId]);
  return links.length;
}

// ----- Telegram Bot API (raw fetch; api.telegram.org is public, no SSRF guard) -

const TG_API = 'https://api.telegram.org';

async function tgCall(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`telegram ${method}: ${res.status} ${data.description ?? JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result;
}

export async function tgSend(token: string, chatId: string | number, text: string): Promise<void> {
  // Telegram rejects empty messages and truncates hard at 4096 chars.
  const body = (text || '…').slice(0, TG_MAX_LEN);
  await tgCall(token, 'sendMessage', { chat_id: chatId, text: body });
}

export async function tgGetMe(token: string): Promise<{ username?: string }> {
  return tgCall(token, 'getMe', {});
}

export async function tgSetWebhook(token: string, url: string, secret?: string): Promise<unknown> {
  const body: Record<string, unknown> = { url, allowed_updates: ['message'] };
  if (secret) body.secret_token = secret;
  return tgCall(token, 'setWebhook', body);
}

// ----- per-chat rate limit (in-memory, sliding 1h) ----------------------------

const chatHits = new Map<string, number[]>();
function hitAllowed(chatId: string): boolean {
  const now = Date.now();
  const cutoff = now - 3_600_000;
  const hits = (chatHits.get(chatId) ?? []).filter((t) => t > cutoff);
  if (hits.length >= PER_CHAT_HOUR) {
    chatHits.set(chatId, hits);
    return false;
  }
  hits.push(now);
  chatHits.set(chatId, hits);
  return true;
}

// ----- dispatcher -------------------------------------------------------------

export interface TelegramDeps {
  controlDb: Db;
  registry: TenantRegistry;
  botToken: string;
  botUsername?: string | null;
  /** Apex domain; set => multi-tenant (ask for a workspace), unset => single-tenant self-host. */
  baseDomain?: string;
  /** Resolve a workspace subdomain to a control-plane subdomain string (null if unknown). */
  resolveSubdomain: (subdomain: string) => string | null;
  /** Whether a tenant's agents may reach private/LAN endpoints (host-admin flag / self-host). */
  allowPrivateFor: (tenantId: string) => boolean;
  /** Test seam: override the outbound sender. */
  send?: (chatId: string, text: string) => Promise<void>;
}

interface TgMessage {
  chat?: { id?: number | string };
  text?: string;
  from?: { username?: string };
}
interface TgUpdate {
  message?: TgMessage;
}

const HELP = [
  "I'm your Carbon assistant. Once linked, just tell me what you need:",
  '• "add milk and eggs to my shopping list"',
  '• "what\'s due tomorrow in the work project?"',
  '• "untick my weekly shopping items"',
  '',
  'I remember the last few messages, so you can say "add eggs to it" or "mark that off".',
  '',
  'Commands: /start (link), /whoami, /reset (forget context), /unlink, /help',
].join('\n');

function setState(db: Db, chatId: string, step: string, subdomain: string | null): void {
  db.run(
    `INSERT INTO telegram_state (chat_id, step, subdomain, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET step = excluded.step, subdomain = excluded.subdomain, updated_at = excluded.updated_at`,
    [chatId, step, subdomain, new Date().toISOString()],
  );
}
function clearState(db: Db, chatId: string): void {
  db.run('DELETE FROM telegram_state WHERE chat_id = ?', [chatId]);
}
function getState(db: Db, chatId: string): { step: string; subdomain: string | null } | null {
  return (
    db.get<{ step: string; subdomain: string | null }>(
      'SELECT step, subdomain FROM telegram_state WHERE chat_id = ?',
      [chatId],
    ) ?? null
  );
}

/** Display label for a workspace ('your workspace' for single-tenant self-host). */
function workspaceLabel(subdomain: string | null): string {
  return subdomain ? `"${subdomain}"` : 'your workspace';
}

/** Finalise a redeemed code into a link and greet the user. */
function completeLink(db: Db, deps: TelegramDeps, chatId: string, r: Extract<RedeemResult, { ok: true }>): string {
  const ctx = deps.registry.getCtx(r.subdomain);
  const carbonUser = ctx ? getUser(ctx.db, r.userId) : undefined;
  const name = carbonUser?.username ?? r.userId;
  // One chat ↔ one user: drop any prior link for this chat before writing the new one.
  db.run('DELETE FROM telegram_links WHERE chat_id = ?', [chatId]);
  db.run(
    `INSERT INTO telegram_links (chat_id, tenant_id, subdomain, user_id, username, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [chatId, r.tenantId, r.subdomain, r.userId, name, new Date().toISOString()],
  );
  clearState(db, chatId);
  clearHistory(db, chatId); // fresh conversation for a freshly-linked account
  return `✅ Linked as ${name} in ${workspaceLabel(r.subdomain)}.\n\n${HELP}`;
}

/**
 * Handle one Telegram update. Sends replies via `deps.send` (default: tgSend). Resolves to void;
 * never throws (errors are logged and surfaced to the user as a friendly message).
 */
export async function handleTelegramUpdate(update: unknown, deps: TelegramDeps): Promise<void> {
  const msg = (update as TgUpdate)?.message;
  const chatRaw = msg?.chat?.id;
  const text = (msg?.text ?? '').trim();
  if (chatRaw === undefined || chatRaw === null || !text) return; // ignore non-text / non-message updates
  const chatId = String(chatRaw);
  const db = deps.controlDb;
  const send = deps.send ?? ((cid: string, t: string) => tgSend(deps.botToken, cid, t));
  const reply = async (t: string) => {
    try {
      await send(chatId, t);
    } catch (e) {
      console.error('[telegram] send failed:', e);
    }
  };

  ensureTelegramTables(db);
  if (!hitAllowed(chatId)) {
    await reply('Slow down a moment — too many messages. Try again shortly.');
    return;
  }

  const multiTenant = !!deps.baseDomain;
  const lower = text.toLowerCase();
  const link = getLinkByChat(db, chatId);

  // ----- commands (work in any state) -----
  if (lower === '/help') {
    await reply(HELP);
    return;
  }
  if (lower === '/whoami') {
    await reply(
      link
        ? `You're linked as ${link.username ?? link.user_id} in ${workspaceLabel(link.subdomain)}.`
        : "You're not linked yet. Send /start to connect your Carbon account.",
    );
    return;
  }
  if (lower === '/unlink') {
    db.run('DELETE FROM telegram_links WHERE chat_id = ?', [chatId]);
    clearState(db, chatId);
    clearHistory(db, chatId);
    await reply('Unlinked. Send /start to connect again.');
    return;
  }
  if (lower === '/reset' || lower === '/clear') {
    clearHistory(db, chatId);
    await reply('Cleared our conversation context. The next message starts fresh.');
    return;
  }
  if (lower === '/start') {
    if (link) {
      await reply(
        `You're already linked as ${link.username ?? link.user_id} in ${workspaceLabel(link.subdomain)}. ` +
          `Send /unlink to disconnect, or just tell me what you need.`,
      );
      return;
    }
    if (multiTenant) {
      setState(db, chatId, 'awaiting_workspace', null);
      await reply(
        `Hi! Let's connect your Carbon account.\n\nWhich workspace are you on? Reply with its name ` +
          `(the part before .${deps.baseDomain}).`,
      );
    } else {
      setState(db, chatId, 'awaiting_code', null);
      await reply(
        "Hi! Let's connect your Carbon account.\n\nOpen Carbon → Settings → Telegram, tap Connect, " +
          'and send me the code it shows.',
      );
    }
    return;
  }

  // /link CODE — explicit redemption regardless of state.
  if (lower.startsWith('/link')) {
    const code = text.slice('/link'.length).trim();
    if (!code) {
      await reply('Send the code like: /link ABCD2345');
      return;
    }
    await redeemAndReply(db, deps, chatId, code, reply, multiTenant);
    return;
  }

  // ----- linked: run the natural-language command -----
  if (link) {
    await runLinkedCommand(deps, chatId, link, text, reply);
    return;
  }

  // ----- unlinked: walk the linking FSM -----
  const state = getState(db, chatId);
  if (state?.step === 'awaiting_workspace') {
    const sub = deps.resolveSubdomain(text.replace(/^@/, '').trim());
    if (!sub) {
      await reply(`I couldn't find a workspace named "${text}". Check the name and try again.`);
      return;
    }
    setState(db, chatId, 'awaiting_code', sub);
    await reply(
      `Got it — ${workspaceLabel(sub)}.\n\nNow open Carbon → Settings → Telegram, tap Connect, ` +
        'and send me the code.',
    );
    return;
  }
  if (state?.step === 'awaiting_code') {
    await redeemAndReply(db, deps, chatId, text, reply, multiTenant, state.subdomain);
    return;
  }

  // No state, not linked, not a command → onboard.
  await reply('Send /start to connect your Carbon account, or /help to see what I can do.');
}

async function redeemAndReply(
  db: Db,
  deps: TelegramDeps,
  chatId: string,
  code: string,
  reply: (t: string) => Promise<void>,
  multiTenant: boolean,
  expectedSubdomain?: string | null,
): Promise<void> {
  // In multi-tenant the user named a workspace first, so the code must match it. In single-tenant
  // there is only one workspace, so we don't constrain (expectedSubdomain stays undefined).
  const expect = multiTenant ? (expectedSubdomain ?? undefined) : undefined;
  const r = redeemTelegramCode(db, code, expect);
  if (!r.ok) {
    const m =
      r.error === 'expired'
        ? 'That code has expired. Generate a fresh one in Carbon → Settings → Telegram.'
        : r.error === 'wrong_workspace'
          ? "That code is for a different workspace. Send /start to pick the right one, or generate a code in the workspace you named."
          : "I didn't recognise that code. Double-check it in Carbon → Settings → Telegram (or generate a new one).";
    await reply(m);
    return;
  }
  await reply(completeLink(db, deps, chatId, r));
}

async function runLinkedCommand(
  deps: TelegramDeps,
  chatId: string,
  link: TelegramLink,
  text: string,
  reply: (t: string) => Promise<void>,
): Promise<void> {
  const ctx = deps.registry.getCtx(link.subdomain);
  if (!ctx) {
    await reply('Your workspace is currently unavailable. Try again later.');
    return;
  }
  const nl = getNlSettings(ctx.db);
  const agent = nl.enabled && nl.agentId ? getAgent(ctx.db, nl.agentId) : undefined;
  if (!agent || !agent.enabled || agent.kind === 'webhook') {
    await reply(
      "This workspace doesn't have an AI assistant set up yet. An admin can add one in " +
        'Carbon → Settings → AI agents and turn on Natural-language commands.',
    );
    return;
  }
  const allowPrivate = deps.allowPrivateFor(link.tenant_id);
  const apiDeps = buildAgentApiDeps(ctx.db, ctx.serverDeviceId, {
    multiTenant: !!deps.baseDomain,
    allowPrivate,
  });
  const history = getHistory(deps.controlDb, chatId);
  try {
    const r = await runAgentCommand(apiDeps, agent, link.user_id, text, allowPrivate, {
      conversational: true,
      now: new Date(),
      requestKind: 'telegram_command',
      history,
    });
    const out = r.reply || 'Done.';
    await reply(out);
    // Record the exchange for follow-up context (only on success, so a failed turn
    // doesn't poison the thread).
    appendHistory(deps.controlDb, chatId, 'user', text);
    appendHistory(deps.controlDb, chatId, 'assistant', out);
  } catch (e) {
    console.error('[telegram] command failed:', e);
    await reply("Sorry — something went wrong running that. Please try again.");
  }
}

// ----- bot lifecycle ----------------------------------------------------------

export interface TelegramBot {
  botUsername: string | null;
  handle(update: unknown): Promise<void>;
}

export interface StartTelegramOpts {
  controlDb: Db;
  registry: TenantRegistry;
  botToken: string | undefined;
  botUsername?: string;
  baseDomain?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  resolveSubdomain: (subdomain: string) => string | null;
  allowPrivateFor: (tenantId: string) => boolean;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

/**
 * Start the per-server bot when `TELEGRAM_BOT_TOKEN` is set: confirm the token (getMe), register
 * the webhook, and return a handler the webhook route calls. No-ops (returns null) when unset.
 */
export async function startTelegramBot(opts: StartTelegramOpts): Promise<TelegramBot | null> {
  ensureTelegramTables(opts.controlDb);
  const token = opts.botToken;
  if (!token) {
    console.log('[carbon] telegram bot disabled (TELEGRAM_BOT_TOKEN unset)');
    return null;
  }
  let botUsername: string | null = opts.botUsername ?? null;
  try {
    const me = await tgGetMe(token);
    botUsername = me.username ?? botUsername;
  } catch (e) {
    console.error('[carbon] telegram getMe failed (check TELEGRAM_BOT_TOKEN):', (e as Error).message);
  }
  if (opts.webhookUrl) {
    const url = joinUrl(opts.webhookUrl, '/telegram/webhook');
    try {
      await tgSetWebhook(token, url, opts.webhookSecret);
      console.log(`[carbon] telegram webhook registered -> ${url}`);
    } catch (e) {
      console.error('[carbon] telegram setWebhook failed:', (e as Error).message);
    }
  } else {
    console.warn(
      '[carbon] TELEGRAM_WEBHOOK_URL unset — webhook not auto-registered. ' +
        'Set it, or call setWebhook manually pointing at <host>/telegram/webhook.',
    );
  }
  const deps: TelegramDeps = {
    controlDb: opts.controlDb,
    registry: opts.registry,
    botToken: token,
    botUsername,
    baseDomain: opts.baseDomain,
    resolveSubdomain: opts.resolveSubdomain,
    allowPrivateFor: opts.allowPrivateFor,
  };
  console.log(`[carbon] telegram bot @${botUsername ?? '?'} ready`);
  return { botUsername, handle: (u: unknown) => handleTelegramUpdate(u, deps) };
}
