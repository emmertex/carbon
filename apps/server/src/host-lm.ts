/**
 * Host-shared LM model: a single OpenAI-compatible model the host operator configures once in
 * `.env` and offers to every workspace, for NL commands + Telegram only (never comment-reply /
 * task-assignment bots, and never the NL→filter builder — those still require a workspace's own
 * agent). Exposed to workspaces as a synthetic, read-only `agents` row (id = HOST_LM_AGENT_ID)
 * that never actually lives in any tenant's `agents` table.
 */
import type { Db } from '@carbon/core';
import { getAgent, type FullAgentRow } from './agents';

export const HOST_LM_AGENT_ID = '__host_lm__';

export interface HostLmConfig {
  endpoint: string;
  token: string;
  model: string;
  enabledByDefault: boolean;
  availableNewAccounts: boolean;
  limits: { perMinute: number; per6h: number; perWeek: number }; // 0 = unlimited
}

function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Parsed once per call from env; null when HOST_LM_ENABLED isn't '1' (feature off entirely). */
export function getHostLmConfig(): HostLmConfig | null {
  if (process.env.HOST_LM_ENABLED !== '1') return null;
  const ip = process.env.HOST_LM_IP?.trim();
  const model = process.env.HOST_LM_MODEL?.trim();
  if (!ip || !model) return null; // enabled but not fully configured — treat as off
  return {
    endpoint: normalizeEndpoint(ip),
    token: process.env.HOST_LM_TOKEN?.trim() ?? '',
    model,
    enabledByDefault: process.env.HOST_LM_ENABLED_BY_DEFAULT === '1',
    availableNewAccounts: process.env.HOST_LM_AVAILABLE_NEW_ACCOUNTS !== '0',
    limits: {
      perMinute: Math.max(0, Number(process.env.HOST_LM_RATE_LIMIT_PER_MINUTE) || 0),
      per6h: Math.max(0, Number(process.env.HOST_LM_RATE_LIMIT_PER_6H) || 0),
      perWeek: Math.max(0, Number(process.env.HOST_LM_RATE_LIMIT_PER_WEEK) || 0),
    },
  };
}

/** Synthesize a FullAgentRow-shaped object chatLLM/runAgentCommand can use as-is. */
export function buildHostAgentRow(cfg: HostLmConfig): FullAgentRow {
  return {
    id: HOST_LM_AGENT_ID,
    user_id: HOST_LM_AGENT_ID,
    name: 'Host-provided assistant',
    kind: 'openai',
    endpoint: cfg.endpoint,
    api_key: cfg.token || null,
    model: cfg.model,
    system_prompt: null,
    enabled: true,
  };
}

/**
 * Resolve an NL-settings agent id to a usable agent row. If `agentId` is the host sentinel and
 * the host model is configured + available for this tenant, returns the synthetic row;
 * otherwise falls back to the normal per-tenant `agents` table lookup (so an unknown/foreign
 * sentinel — e.g. the host model was later disabled — degrades to "no agent configured" rather
 * than throwing).
 */
export function resolveAgent(
  db: Db,
  agentId: string | null,
  hostAvailable: boolean,
): FullAgentRow | undefined {
  if (!agentId) return undefined;
  if (agentId === HOST_LM_AGENT_ID) {
    if (!hostAvailable) return undefined;
    const cfg = getHostLmConfig();
    return cfg ? buildHostAgentRow(cfg) : undefined;
  }
  return getAgent(db, agentId);
}

export function isHostAgent(agent: Pick<FullAgentRow, 'id'>): boolean {
  return agent.id === HOST_LM_AGENT_ID;
}

// ----- per-tenant rate limit (in-memory, three independent sliding windows) -------------------

const MINUTE_MS = 60_000;
const SIX_HOUR_MS = 6 * 60 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

const minuteHits = new Map<string, number[]>();
const sixHourHits = new Map<string, number[]>();
const weekHits = new Map<string, number[]>();

function checkWindow(
  map: Map<string, number[]>,
  tenantId: string,
  windowMs: number,
  cap: number,
  now: number,
): boolean {
  if (cap <= 0) return true; // 0/unset = unlimited
  const cutoff = now - windowMs;
  const hits = (map.get(tenantId) ?? []).filter((t) => t > cutoff);
  if (hits.length >= cap) {
    map.set(tenantId, hits);
    return false;
  }
  hits.push(now);
  map.set(tenantId, hits);
  return true;
}

/** Checks (and records, on success) one call against all three windows for a tenant. All three
 *  are always evaluated so partial recording can't happen — if any window is over cap, none of
 *  the hits are recorded (the caller didn't actually make the call). */
export function checkHostRateLimit(tenantId: string, cfg: HostLmConfig): { ok: boolean; message?: string } {
  const now = Date.now();
  const cutoffMin = now - MINUTE_MS;
  const cutoff6h = now - SIX_HOUR_MS;
  const cutoffWeek = now - WEEK_MS;
  const minHits = (minuteHits.get(tenantId) ?? []).filter((t) => t > cutoffMin);
  const sixHits = (sixHourHits.get(tenantId) ?? []).filter((t) => t > cutoff6h);
  const wkHits = (weekHits.get(tenantId) ?? []).filter((t) => t > cutoffWeek);

  if (cfg.limits.perMinute > 0 && minHits.length >= cfg.limits.perMinute) {
    minuteHits.set(tenantId, minHits);
    return { ok: false, message: 'The shared assistant is busy right now — try again in a minute.' };
  }
  if (cfg.limits.per6h > 0 && sixHits.length >= cfg.limits.per6h) {
    sixHourHits.set(tenantId, sixHits);
    return { ok: false, message: 'This workspace has used up its shared-assistant quota for now — try again later.' };
  }
  if (cfg.limits.perWeek > 0 && wkHits.length >= cfg.limits.perWeek) {
    weekHits.set(tenantId, wkHits);
    return { ok: false, message: "This workspace has used up its shared-assistant quota for the week." };
  }

  // Only track windows that actually have a cap — an unlimited window shouldn't accumulate
  // bookkeeping (and would otherwise leak stale hits into a window that later gets a cap set).
  if (cfg.limits.perMinute > 0) {
    minHits.push(now);
    minuteHits.set(tenantId, minHits);
  }
  if (cfg.limits.per6h > 0) {
    sixHits.push(now);
    sixHourHits.set(tenantId, sixHits);
  }
  if (cfg.limits.perWeek > 0) {
    wkHits.push(now);
    weekHits.set(tenantId, wkHits);
  }
  return { ok: true };
}
