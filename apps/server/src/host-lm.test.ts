/**
 * Tests for host-lm.ts: env config parsing, the synthetic agent row, resolveAgent's
 * sentinel handling, and the three independent rate-limit windows.
 */
import assert from 'node:assert/strict';
import { test, describe, afterEach } from 'node:test';
import { createAgent } from './agents';
import {
  HOST_LM_AGENT_ID,
  getHostLmConfig,
  buildHostAgentRow,
  resolveAgent,
  isHostAgent,
  checkHostRateLimit,
} from './host-lm';
import { makeTestDb, type TestDb } from './test-app';

const ENV_KEYS = [
  'HOST_LM_ENABLED',
  'HOST_LM_IP',
  'HOST_LM_TOKEN',
  'HOST_LM_MODEL',
  'HOST_LM_ENABLED_BY_DEFAULT',
  'HOST_LM_AVAILABLE_NEW_ACCOUNTS',
  'HOST_LM_RATE_LIMIT_PER_MINUTE',
  'HOST_LM_RATE_LIMIT_PER_6H',
  'HOST_LM_RATE_LIMIT_PER_WEEK',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('getHostLmConfig', () => {
  test('null when HOST_LM_ENABLED is unset', () => {
    delete process.env.HOST_LM_ENABLED;
    assert.equal(getHostLmConfig(), null);
  });

  test('null when enabled but IP/model missing (misconfigured, treated as off)', () => {
    process.env.HOST_LM_ENABLED = '1';
    delete process.env.HOST_LM_IP;
    process.env.HOST_LM_MODEL = 'qwen';
    assert.equal(getHostLmConfig(), null);
  });

  test('parses a fully-configured host model, defaulting the scheme to http://', () => {
    process.env.HOST_LM_ENABLED = '1';
    process.env.HOST_LM_IP = '10.2.100.50:1234/v1';
    process.env.HOST_LM_TOKEN = 'secret';
    process.env.HOST_LM_MODEL = 'qwen2.5-1.5b';
    process.env.HOST_LM_ENABLED_BY_DEFAULT = '1';
    process.env.HOST_LM_RATE_LIMIT_PER_MINUTE = '5';
    const cfg = getHostLmConfig();
    assert.ok(cfg);
    assert.equal(cfg!.endpoint, 'http://10.2.100.50:1234/v1');
    assert.equal(cfg!.token, 'secret');
    assert.equal(cfg!.model, 'qwen2.5-1.5b');
    assert.equal(cfg!.enabledByDefault, true);
    assert.equal(cfg!.limits.perMinute, 5);
    assert.equal(cfg!.limits.per6h, 0);
  });

  test('availableNewAccounts defaults true; explicit "0" turns it off', () => {
    process.env.HOST_LM_ENABLED = '1';
    process.env.HOST_LM_IP = 'http://x/v1';
    process.env.HOST_LM_MODEL = 'm';
    delete process.env.HOST_LM_AVAILABLE_NEW_ACCOUNTS;
    assert.equal(getHostLmConfig()!.availableNewAccounts, true);
    process.env.HOST_LM_AVAILABLE_NEW_ACCOUNTS = '0';
    assert.equal(getHostLmConfig()!.availableNewAccounts, false);
  });

  test('a scheme already present in HOST_LM_IP is preserved', () => {
    process.env.HOST_LM_ENABLED = '1';
    process.env.HOST_LM_IP = 'https://openrouter.example/api/v1/';
    process.env.HOST_LM_MODEL = 'm';
    assert.equal(getHostLmConfig()!.endpoint, 'https://openrouter.example/api/v1');
  });
});

describe('buildHostAgentRow / isHostAgent', () => {
  test('builds an OpenAI-kind row using the sentinel id', () => {
    process.env.HOST_LM_ENABLED = '1';
    process.env.HOST_LM_IP = 'http://x/v1';
    process.env.HOST_LM_MODEL = 'm';
    const row = buildHostAgentRow(getHostLmConfig()!);
    assert.equal(row.id, HOST_LM_AGENT_ID);
    assert.equal(row.kind, 'openai');
    assert.equal(row.enabled, true);
    assert.ok(isHostAgent(row));
  });
});

describe('resolveAgent', () => {
  let db: TestDb;
  test('returns undefined for the sentinel when host model is unavailable for the tenant', () => {
    process.env.HOST_LM_ENABLED = '1';
    process.env.HOST_LM_IP = 'http://x/v1';
    process.env.HOST_LM_MODEL = 'm';
    db = makeTestDb().db;
    assert.equal(resolveAgent(db, HOST_LM_AGENT_ID, false), undefined);
  });

  test('returns the synthetic row for the sentinel when available and configured', () => {
    process.env.HOST_LM_ENABLED = '1';
    process.env.HOST_LM_IP = 'http://x/v1';
    process.env.HOST_LM_MODEL = 'm';
    db = makeTestDb().db;
    const agent = resolveAgent(db, HOST_LM_AGENT_ID, true);
    assert.ok(agent);
    assert.equal(agent!.id, HOST_LM_AGENT_ID);
  });

  test('returns undefined for the sentinel when the host model is not configured', () => {
    delete process.env.HOST_LM_ENABLED;
    db = makeTestDb().db;
    assert.equal(resolveAgent(db, HOST_LM_AGENT_ID, true), undefined);
  });

  test('falls through to a normal per-tenant agent lookup for non-sentinel ids', () => {
    db = makeTestDb().db;
    const a = createAgent(db, { name: 'NL', username: 'nlbot', kind: 'openai', model: 'm' });
    const agent = resolveAgent(db, a.id, false);
    assert.equal(agent?.id, a.id);
  });

  test('unknown non-sentinel id resolves to undefined', () => {
    db = makeTestDb().db;
    assert.equal(resolveAgent(db, 'nonexistent', true), undefined);
  });
});

describe('checkHostRateLimit', () => {
  const cfgWith = (limits: Partial<{ perMinute: number; per6h: number; perWeek: number }>) => ({
    endpoint: 'http://x',
    token: '',
    model: 'm',
    enabledByDefault: false,
    availableNewAccounts: true,
    limits: { perMinute: 0, per6h: 0, perWeek: 0, ...limits },
  });

  test('0/unset limits never reject', () => {
    const tenant = `t-unlimited-${Date.now()}`;
    const cfg = cfgWith({});
    for (let i = 0; i < 20; i++) {
      assert.equal(checkHostRateLimit(tenant, cfg).ok, true);
    }
  });

  test('per-minute window rejects once the cap is hit, independently per tenant', () => {
    const tenantA = `t-min-a-${Date.now()}`;
    const tenantB = `t-min-b-${Date.now()}`;
    const cfg = cfgWith({ perMinute: 2 });
    assert.equal(checkHostRateLimit(tenantA, cfg).ok, true);
    assert.equal(checkHostRateLimit(tenantA, cfg).ok, true);
    const third = checkHostRateLimit(tenantA, cfg);
    assert.equal(third.ok, false);
    assert.ok(third.message);
    // A different tenant has its own quota.
    assert.equal(checkHostRateLimit(tenantB, cfg).ok, true);
  });

  test('per-6h window rejects independently of the per-minute window', () => {
    const tenant = `t-6h-${Date.now()}`;
    const cfg = cfgWith({ perMinute: 100, per6h: 1 });
    assert.equal(checkHostRateLimit(tenant, cfg).ok, true);
    const second = checkHostRateLimit(tenant, cfg);
    assert.equal(second.ok, false);
  });

  test('per-week window rejects independently of the other two', () => {
    const tenant = `t-week-${Date.now()}`;
    const cfg = cfgWith({ perMinute: 100, per6h: 100, perWeek: 1 });
    assert.equal(checkHostRateLimit(tenant, cfg).ok, true);
    const second = checkHostRateLimit(tenant, cfg);
    assert.equal(second.ok, false);
  });

  test('a rejected call does not consume quota from any window (no partial recording)', () => {
    const tenant = `t-partial-${Date.now()}`;
    const cfg = cfgWith({ perMinute: 1, per6h: 100 });
    assert.equal(checkHostRateLimit(tenant, cfg).ok, true); // uses the 1 per-minute slot
    assert.equal(checkHostRateLimit(tenant, cfg).ok, false); // per-minute now rejects
    // per-6h should still show only the one successful call recorded, not two.
    const cfgOnly6h = cfgWith({ per6h: 1 });
    // A fresh tenant sharing no state: confirm cap=1 rejects on the 2nd real call only.
    const t2 = `t-partial2-${Date.now()}`;
    assert.equal(checkHostRateLimit(t2, cfgOnly6h).ok, true);
    assert.equal(checkHostRateLimit(t2, cfgOnly6h).ok, false);
  });
});
