import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

// federation.ts imports ./config, which touches localStorage at import/runtime.
// Provide a tiny in-memory stub so the module loads under the node test runner.
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { canFederate, offerablePeerSubdomains } = await import('./federation');

type Cfg = Parameters<typeof canFederate>[0] & Parameters<typeof offerablePeerSubdomains>[0];

function cfg(over: Partial<Cfg> = {}): Cfg {
  return {
    policy: 'user_open',
    ceiling: 'intra_server',
    allow: [],
    deny: [],
    ...over,
  } as Cfg;
}

describe('canFederate — in-dialog affordance gate', () => {
  test('true when policy allows and ceiling is on', () => {
    assert.equal(canFederate(cfg({ policy: 'user_open', ceiling: 'intra_server' })), true);
    assert.equal(canFederate(cfg({ policy: 'admin_whitelist', ceiling: 'cross_server' })), true);
  });

  test('false when the workspace policy is workspace_only', () => {
    assert.equal(canFederate(cfg({ policy: 'workspace_only', ceiling: 'cross_server' })), false);
  });

  test('false when the host ceiling is off', () => {
    assert.equal(canFederate(cfg({ policy: 'user_open', ceiling: 'off' })), false);
  });
});

describe('offerablePeerSubdomains — picker candidates (allow list)', () => {
  const peer = (over: Record<string, unknown>) => ({
    id: 'p',
    base_url: 'http://x',
    subdomain: null,
    label: null,
    approved_by: null,
    approved_at: null,
    list_type: 'allow',
    deleted: false,
    ...over,
  });

  test('keeps live allow-list peers that carry a subdomain', () => {
    const c = cfg({
      allow: [peer({ subdomain: 'globex' }), peer({ subdomain: 'initech' })] as Cfg['allow'],
    });
    assert.deepEqual(offerablePeerSubdomains(c), ['globex', 'initech']);
  });

  test('drops peers with no subdomain and deleted peers', () => {
    const c = cfg({
      allow: [
        peer({ subdomain: null }),
        peer({ subdomain: 'gone', deleted: true }),
        peer({ subdomain: 'globex' }),
      ] as Cfg['allow'],
    });
    assert.deepEqual(offerablePeerSubdomains(c), ['globex']);
  });
});
