/**
 * Server-side federation Phase-1 tests: storage (links/roots/cursors), the shadow
 * user provisioner, governance storage (workspace policy + peer whitelist), and a
 * full truth-table of the pure gate-evaluation helpers. No transport, no
 * endpoints — Phase 1 is storage + governance + pure logic only.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { getUser } from '@carbon/core';
import { makeTestDb } from './test-app';
import {
  ensureFederationTables,
  ensureGovernanceTables,
  createLink,
  getLink,
  listLinks,
  setLinkStatus,
  addLinkRoot,
  listLinkRoots,
  getCursor,
  setCursor,
  provisionShadowUser,
  shadowUserId,
  getFederationPolicy,
  setFederationPolicy,
  addPeer,
  listPeers,
  peerDenied,
  removePeer,
  hostCeilingAllows,
  workspacePolicyAllows,
  canOffer,
  canAccept,
  getSyncEpoch,
  setSyncEpoch,
  bumpSyncEpoch,
  type FederationMode,
  type FederationPolicy,
  type FederationTier,
} from './federation';

// ─── schema creation ──────────────────────────────────────────────────────────

describe('ensureFederationTables / ensureGovernanceTables', () => {
  test('create every federation + governance table idempotently', () => {
    const { db } = makeTestDb(); // makeTestDb already calls both ensure* funcs
    // Calling again must not throw (idempotent CREATE IF NOT EXISTS).
    ensureFederationTables(db);
    ensureGovernanceTables(db);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name);
    for (const t of [
      'federation_links',
      'federation_link_roots',
      'federation_cursors',
      'workspace_settings',
      'federation_peers',
    ]) {
      assert.ok(tables.includes(t), `table ${t} exists`);
    }
  });
});

// ─── link / root / cursor CRUD ──────────────────────────────────────────────────

describe('federation link/root/cursor CRUD', () => {
  test('create/get/list/setStatus for links', () => {
    const { db } = makeTestDb();
    const link = createLink(db, {
      peerBaseUrl: 'http://globex.test',
      peerLabel: 'globex',
      direction: 'outbound',
    });
    assert.equal(link.status, 'pending');
    assert.ok(link.secret.length > 0, 'a secret was minted');

    const fetched = getLink(db, link.id);
    assert.ok(fetched);
    assert.equal(fetched!.peer_base_url, 'http://globex.test');
    assert.equal(fetched!.direction, 'outbound');

    setLinkStatus(db, link.id, 'active');
    assert.equal(getLink(db, link.id)!.status, 'active');

    setLinkStatus(db, link.id, 'revoked');
    assert.equal(getLink(db, link.id)!.status, 'revoked');

    createLink(db, { peerBaseUrl: 'http://acme.test', direction: 'inbound' });
    assert.equal(listLinks(db).length, 2);
  });

  test('createLink binds a provided secret (e.g. the peer offer_secret)', () => {
    const { db } = makeTestDb();
    const link = createLink(db, {
      peerBaseUrl: 'http://p.test',
      direction: 'inbound',
      secret: 'bound-secret',
      status: 'active',
    });
    assert.equal(link.secret, 'bound-secret');
    assert.equal(link.status, 'active');
  });

  test('add/list roots, permission update is idempotent per (link, root)', () => {
    const { db } = makeTestDb();
    const link = createLink(db, { peerBaseUrl: 'http://p.test', direction: 'outbound' });
    addLinkRoot(db, link.id, 'item-1', 'read');
    addLinkRoot(db, link.id, 'item-2', 'write');
    let roots = listLinkRoots(db, link.id);
    assert.equal(roots.length, 2);

    // Re-adding the same root updates the permission rather than duplicating.
    addLinkRoot(db, link.id, 'item-1', 'write');
    roots = listLinkRoots(db, link.id);
    assert.equal(roots.length, 2, 'no duplicate row');
    assert.equal(roots.find((r) => r.root_item_id === 'item-1')!.permission, 'write');
  });

  test('get/set cursor (upsert, partial writes preserve other fields)', () => {
    const { db } = makeTestDb();
    const link = createLink(db, { peerBaseUrl: 'http://p.test', direction: 'outbound' });
    assert.equal(getCursor(db, link.id), undefined);

    setCursor(db, link.id, { since: '100' });
    assert.equal(getCursor(db, link.id)!.since, '100');
    assert.equal(getCursor(db, link.id)!.rsince, null);

    // A partial write leaves `since` intact.
    setCursor(db, link.id, { rsince: '200', needJson: JSON.stringify(['x']) });
    const cur = getCursor(db, link.id)!;
    assert.equal(cur.since, '100');
    assert.equal(cur.rsince, '200');
    assert.equal(cur.need_json, JSON.stringify(['x']));
  });
});

// ─── shadow users ───────────────────────────────────────────────────────────────

describe('provisionShadowUser', () => {
  test('id shape is remote:<host>:<remoteUserId> and cannot collide with a uuid', () => {
    assert.equal(shadowUserId('globex', 'alice'), 'remote:globex:alice');
    const { db, deviceId } = makeTestDb();
    const u = provisionShadowUser(db, deviceId, 'globex', 'alice', 'Alice');
    assert.equal(u.id, 'remote:globex:alice');
    assert.equal(u.is_remote, true);
    assert.equal(u.home_server, 'globex');
    assert.ok(u.id.startsWith('remote:'), 'namespaced, never a bare uuid');
  });

  test('is idempotent and refreshes the display name', () => {
    const { db, deviceId } = makeTestDb();
    provisionShadowUser(db, deviceId, 'globex', 'alice', 'Alice');
    const again = provisionShadowUser(db, deviceId, 'globex', 'alice', 'Alice Renamed');
    assert.equal(again.display_name, 'Alice Renamed');
    // Only one row for that id.
    const persisted = getUser(db, 'remote:globex:alice');
    assert.ok(persisted);
    assert.equal(persisted!.is_remote, true);
  });
});

// ─── governance storage ──────────────────────────────────────────────────────

describe('federation policy + peer whitelist', () => {
  test('getFederationPolicy defaults to workspace_only; set/get round-trips', () => {
    const { db } = makeTestDb();
    assert.equal(getFederationPolicy(db), 'workspace_only');
    setFederationPolicy(db, 'admin_whitelist');
    assert.equal(getFederationPolicy(db), 'admin_whitelist');
    setFederationPolicy(db, 'user_open');
    assert.equal(getFederationPolicy(db), 'user_open');
  });

  test('peer whitelist add/list/remove (soft-delete)', () => {
    const { db } = makeTestDb();
    assert.equal(listPeers(db).length, 0);
    const p = addPeer(db, {
      baseUrl: 'http://globex.test',
      subdomain: 'globex',
      label: 'Globex',
      approvedBy: 'admin-1',
    });
    assert.equal(listPeers(db).length, 1);
    assert.equal(listPeers(db)[0]!.base_url, 'http://globex.test');
    assert.equal(listPeers(db)[0]!.approved_by, 'admin-1');
    assert.equal(listPeers(db)[0]!.list_type, 'allow', 'defaults to the allow list');

    removePeer(db, p.id);
    assert.equal(listPeers(db).length, 0, 'removed peer no longer listed');
  });

  test('allow + deny entries: listPeers filters by type; peerDenied works', () => {
    const { db } = makeTestDb();
    const allow = addPeer(db, { baseUrl: 'allowed', subdomain: 'allowed', listType: 'allow' });
    const deny = addPeer(db, { baseUrl: 'blocked', subdomain: 'blocked', listType: 'deny' });

    // Unfiltered = both; filtered = the right set.
    assert.equal(listPeers(db).length, 2, 'listPeers() returns both lists');
    assert.deepEqual(
      listPeers(db, 'allow').map((p) => p.id),
      [allow.id],
      'listPeers(allow) is just the allow entry',
    );
    assert.deepEqual(
      listPeers(db, 'deny').map((p) => p.id),
      [deny.id],
      'listPeers(deny) is just the deny entry',
    );
    assert.equal(deny.list_type, 'deny', 'addPeer persists the list type');

    // peerDenied matches a deny row by subdomain OR base_url, and only deny rows.
    assert.equal(peerDenied(db, 'blocked'), true, 'denied by subdomain');
    assert.equal(peerDenied(db, 'allowed'), false, 'an allow-list peer is not denied');
    assert.equal(peerDenied(db, 'unknown'), false, 'an unknown peer is not denied');

    // Removing the deny row clears the denial.
    removePeer(db, deny.id);
    assert.equal(peerDenied(db, 'blocked'), false, 'removed deny row no longer blocks');
    assert.equal(listPeers(db, 'deny').length, 0);
  });
});

// ─── pure gate helpers: full truth table ───────────────────────────────────────

describe('hostCeilingAllows', () => {
  const cases: [FederationMode, FederationTier, boolean][] = [
    ['off', 'intra_server', false],
    ['off', 'cross_server', false],
    ['intra_server', 'intra_server', true],
    ['intra_server', 'cross_server', false],
    ['cross_server', 'intra_server', true],
    ['cross_server', 'cross_server', true],
  ];
  for (const [mode, tier, expected] of cases) {
    test(`${mode} × ${tier} → ${expected}`, () => {
      assert.equal(hostCeilingAllows(mode, tier), expected);
    });
  }
});

describe('workspacePolicyAllows', () => {
  // [policy, peerOnAllowlist, peerOnDenylist, expected]
  const cases: [FederationPolicy, boolean, boolean, boolean][] = [
    ['workspace_only', false, false, false],
    ['workspace_only', true, false, false],
    ['admin_whitelist', false, false, false],
    ['admin_whitelist', true, false, true],
    ['user_open', false, false, true],
    ['user_open', true, false, true],
    // Deny ALWAYS wins — blocked under every policy, even when also on the allow list.
    ['workspace_only', false, true, false],
    ['admin_whitelist', true, true, false],
    ['admin_whitelist', false, true, false],
    ['user_open', false, true, false],
    ['user_open', true, true, false],
  ];
  for (const [policy, onAllow, onDeny, expected] of cases) {
    test(`${policy} × allow=${onAllow} × deny=${onDeny} → ${expected}`, () => {
      assert.equal(workspacePolicyAllows(policy, onAllow, onDeny), expected);
    });
  }

  test('the deny flag defaults to false (back-compatible 2-arg call)', () => {
    assert.equal(workspacePolicyAllows('user_open', false), true);
    assert.equal(workspacePolicyAllows('admin_whitelist', true), true);
  });
});

describe('canOffer / canAccept — full (mode × policy × tier × allow × deny) truth table', () => {
  const modes: FederationMode[] = ['off', 'intra_server', 'cross_server'];
  const policies: FederationPolicy[] = ['workspace_only', 'admin_whitelist', 'user_open'];
  const tiers: FederationTier[] = ['intra_server', 'cross_server'];
  const bools = [false, true];

  for (const mode of modes) {
    for (const policy of policies) {
      for (const tier of tiers) {
        for (const peerOnAllowlist of bools) {
          for (const peerOnDenylist of bools) {
            const expected =
              hostCeilingAllows(mode, tier) &&
              workspacePolicyAllows(policy, peerOnAllowlist, peerOnDenylist);
            test(`${mode}/${policy}/${tier}/allow=${peerOnAllowlist}/deny=${peerOnDenylist} → ${expected}`, () => {
              const inputs = { mode, policy, tier, peerOnAllowlist, peerOnDenylist };
              // Both edges evaluate identically (Gates 1–2).
              assert.equal(canOffer(inputs).ok, expected);
              assert.equal(canAccept(inputs).ok, expected);
              if (!expected) {
                assert.ok(canOffer(inputs).reason, 'a rejection carries a reason');
              }
            });
          }
        }
      }
    }
  }

  test('intra_server ceiling permits an L2 offer but rejects an L3 offer', () => {
    const base = {
      mode: 'intra_server' as const,
      policy: 'user_open' as const,
      peerOnAllowlist: true,
    };
    assert.equal(canOffer({ ...base, tier: 'intra_server' }).ok, true);
    assert.equal(canOffer({ ...base, tier: 'cross_server' }).ok, false);
  });

  test('admin_whitelist rejects a non-allow-listed peer and permits an allow-listed one', () => {
    const base = {
      mode: 'cross_server' as const,
      policy: 'admin_whitelist' as const,
      tier: 'cross_server' as const,
    };
    assert.equal(canAccept({ ...base, peerOnAllowlist: false }).ok, false);
    assert.equal(canAccept({ ...base, peerOnAllowlist: true }).ok, true);
  });

  test('deny ALWAYS wins: a denied peer is blocked under user_open AND admin_whitelist', () => {
    // Ceiling + tier permissive; the denial is the only reason to block.
    const base = { mode: 'cross_server' as const, tier: 'cross_server' as const };
    // Open policy: normally always permits, but the deny flag blocks it.
    const open = { ...base, policy: 'user_open' as const, peerOnAllowlist: false };
    assert.equal(canOffer({ ...open, peerOnDenylist: true }).ok, false);
    assert.ok(
      /deny/i.test(canOffer({ ...open, peerOnDenylist: true }).reason ?? ''),
      'the reason mentions the deny list',
    );
    assert.equal(canAccept({ ...open, peerOnDenylist: true }).ok, false);

    // Admin policy: deny wins even when the peer is ALSO on the allow list.
    const admin = { ...base, policy: 'admin_whitelist' as const, peerOnAllowlist: true };
    assert.equal(canOffer({ ...admin, peerOnDenylist: true }).ok, false, 'deny beats allow');
    assert.equal(canAccept({ ...admin, peerOnDenylist: true }).ok, false);

    // Sanity: without the deny flag both of those are allowed.
    assert.equal(canOffer({ ...open, peerOnDenylist: false }).ok, true);
    assert.equal(canOffer({ ...admin, peerOnDenylist: false }).ok, true);
  });
});

describe('sync_epoch workspace setting', () => {
  test('defaults to 1 and bumps', () => {
    const { db } = makeTestDb();
    ensureGovernanceTables(db);
    assert.equal(getSyncEpoch(db), 1);
    setSyncEpoch(db, 3);
    assert.equal(getSyncEpoch(db), 3);
    assert.equal(bumpSyncEpoch(db), 4);
    assert.equal(getSyncEpoch(db), 4);
  });
});
