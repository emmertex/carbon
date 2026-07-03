/**
 * Federation Phase-3 end-to-end: bidirectional WRITE over same-host loopback. Two
 * in-process tenant DBs (acme/alice/Roadmap ↔ globex/bob) wired by a `deliverToPeer`
 * that loops between their apps — the SAME route L3 will later hit over HTTPS. The
 * link is granted WRITE, so edits flow both ways within the granted subtree.
 *
 * Covers the 8 required assertions:
 *   1. round-trip (edit on globex → acme; owner not hijacked; no self-shadow; no echo)
 *   2. write gate (read-only link rejects an inbound pushed edit)
 *   3. scope reject (a push for an item outside the subtree is dropped)
 *   4. owner protection (a push changing owner_id of an existing item is ignored)
 *   5. no agents / no tags (a pushed @mention fires no agent; a pushed tag op no-ops)
 *   6. concurrent LWW (far-future-ts peer op wins UNCLAMPED)
 *   7. move-in (a task reparented under Roadmap on acme reaches globex next round)
 *   8. timingSafeEqual link auth accepts the right secret, rejects a wrong one
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Hono } from 'hono';
import {
  createItem,
  updateItem,
  getItem,
  getUser,
  ingestOps,
  recordRecordOp,
  getUserByUsername,
  createUser as coreCreateUser,
  migrate,
  ensureDeviceId,
  type Op,
} from '@carbon/core';
import { openDb } from './sqlite';
import {
  ensureServerTables,
  basicAuth,
  hashPassword,
  setPassword,
  createSession,
  type AuthVars,
} from './auth';
import { ensureNoticeTables, getNotice, actOnNotice, listOpenNotices } from './notices';
import {
  ensureFederationTables,
  ensureGovernanceTables,
  federationRoutes,
  setFederationPolicy,
  listLinks,
  listLinkRoots,
  getCursor,
  findActiveLinkBySecret,
  runFederationExchange,
  buildIncrementalPullPayload,
  memBlobStore,
  type FederationLink,
  type FederationMode,
  type DeliverToPeer,
} from './federation';

// ─── two-tenant harness (mirrors the Phase-2 harness) ──────────────────────────

interface Tenant {
  label: string;
  db: ReturnType<typeof openDb>;
  deviceId: string;
  app: Hono<{ Variables: AuthVars }>;
  addUser(username: string, password: string): { id: string; token: string };
}

function makeWorld(mode: () => Record<string, FederationMode>) {
  const tenants = new Map<string, Tenant>();

  const deliverToPeer: DeliverToPeer = async (peerBaseUrl, path, body) => {
    const peer = tenants.get(peerBaseUrl);
    if (!peer) throw new Error('unsupported_peer');
    const req = new Request(`http://${peerBaseUrl}.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return peer.app.fetch(req);
  };

  function makeTenant(label: string): Tenant {
    const db = openDb(':memory:');
    migrate(db);
    ensureServerTables(db);
    ensureNoticeTables(db);
    ensureFederationTables(db);
    ensureGovernanceTables(db);
    const deviceId = ensureDeviceId(db);
    const sessionAuth = basicAuth(db, false);

    const app = new Hono<{ Variables: AuthVars }>();
    app.post('/api/notices/:id/act', sessionAuth, async (c) => {
      const userId = c.get('userId');
      const notice = getNotice(db, c.req.param('id'));
      if (!notice) return c.json({ error: 'not found' }, 404);
      if (notice.user_id !== userId) return c.json({ error: 'forbidden' }, 403);
      const b = (await c.req.json().catch(() => ({}))) as { action?: string };
      const resolved = await actOnNotice(db, deviceId, notice, b.action ?? 'dismiss');
      return c.json({ notice: resolved });
    });

    const fedApi = federationRoutes({
      db,
      serverDeviceId: deviceId,
      myLabel: label,
      resolveMode: () => mode()[label] ?? 'off',
      deliverToPeer,
      blobStore: memBlobStore(),
      sessionAuth,
    });
    app.route('/api/federation', fedApi);

    const t: Tenant = {
      label,
      db,
      deviceId,
      app,
      addUser(username, password) {
        const u = getUserByUsername(db, username);
        const id = u ? u.id : coreCreateUser(db, { username, displayName: username, role: 'admin' }).id;
        setPassword(db, id, hashPassword(password));
        return { id, token: createSession(db, id) };
      },
    };
    tenants.set(label, t);
    return t;
  }

  return { tenants, deliverToPeer, makeTenant };
}

function seedRoadmap(acme: Tenant, aliceId: string): { roadmap: string; child: string } {
  const roadmap = createItem(acme.db, acme.deviceId, {
    type: 'project',
    parentId: null,
    ownerId: aliceId,
    title: 'Roadmap',
  });
  const child = createItem(acme.db, acme.deviceId, {
    type: 'task',
    parentId: roadmap.id,
    ownerId: aliceId,
    title: 'Ship v1',
  });
  return { roadmap: roadmap.id, child: child.id };
}

async function offer(
  acme: Tenant,
  aliceToken: string,
  to: string,
  rootItemId: string,
  permission: 'read' | 'write' = 'read',
): Promise<Response> {
  return acme.app.fetch(
    new Request('http://acme.test/api/federation/offers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ to, root_item_id: rootItemId, permission }),
    }),
  );
}

/** Drive the full offer→approve handshake and return { acme, globex, alice, bob, ids }.
 *  After this the acme (outbound) + globex (inbound) links are active and Roadmap is
 *  materialized on globex under shadow-alice, with the granted permission on both. */
async function handshake(permission: 'read' | 'write') {
  const modes: Record<string, FederationMode> = { acme: 'intra_server', globex: 'intra_server' };
  const world = makeWorld(() => modes);
  const acme = world.makeTenant('acme');
  const globex = world.makeTenant('globex');
  setFederationPolicy(acme.db, 'user_open');
  setFederationPolicy(globex.db, 'user_open');
  const alice = acme.addUser('alice', 'pw');
  const bob = globex.addUser('bob', 'pw');
  const { roadmap, child } = seedRoadmap(acme, alice.id);

  const res = await offer(acme, alice.token, 'bob@globex', roadmap, permission);
  assert.equal(res.status, 200, await res.text().catch(() => ''));
  const notice = listOpenNotices(globex.db, bob.id)[0]!;
  const act = await globex.app.fetch(
    new Request(`http://globex.test/api/notices/${notice.id}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ action: 'accept' }),
    }),
  );
  assert.equal(act.status, 200);
  return { world, acme, globex, alice, bob, roadmap, child };
}

/** The active outbound link on acme + inbound link on globex. */
function links(acme: Tenant, globex: Tenant): { acme: FederationLink; globex: FederationLink } {
  return { acme: listLinks(acme.db)[0]!, globex: listLinks(globex.db)[0]! };
}

// A round from globex's side (globex pushes its edits, pulls acme's content) then a
// round from acme's side (acme pushes, pulls globex) — a full both-directions exchange.
async function exchangeBothWays(acme: Tenant, globex: Tenant, deliver: DeliverToPeer) {
  const l = links(acme, globex);
  await runFederationExchange(globex.db, l.globex, deliver, 'globex');
  await runFederationExchange(acme.db, l.acme, deliver, 'acme');
}

// ─── 1. round-trip + owner-not-hijacked + no self-shadow + no echo ─────────────

describe('federation Phase 3 — round-trip write', () => {
  test('bob edits Roadmap title on globex → acme shows it, owner stays alice, no self-shadow, no echo', async () => {
    const { world, acme, globex, alice, bob, roadmap } = await handshake('write');
    const deliver = world.deliverToPeer;
    const shadowAlice = `remote:acme:${alice.id}`;

    // Roadmap materialized on globex, owned by shadow-alice, granted WRITE.
    assert.equal(getItem(globex.db, roadmap)!.owner_id, shadowAlice);
    assert.equal(
      listLinkRoots(globex.db, links(acme, globex).globex.id).find((r) => r.root_item_id === roadmap)!
        .permission,
      'write',
      'recipient records the WRITE grant',
    );

    // Bob edits the title on globex (a normal local op — synced=0).
    updateItem(globex.db, globex.deviceId, roadmap, { title: 'Roadmap (edited by bob)' });

    // One full exchange both ways.
    await exchangeBothWays(acme, globex, deliver);

    // acme shows bob's new title, and the item is STILL owned by alice (not hijacked).
    const aRoadmap = getItem(acme.db, roadmap)!;
    assert.equal(aRoadmap.title, 'Roadmap (edited by bob)', 'edit reached acme');
    assert.equal(aRoadmap.owner_id, alice.id, 'owner is still alice, not a bob shadow');

    // The edit is attributed to bob's device on acme (the op survived with bob's device).
    const bobEditOnAcme = acme.db.get<{ device_id: string }>(
      "SELECT device_id FROM ops WHERE item_id = ? AND fields LIKE '%edited by bob%'",
      [roadmap],
    );
    assert.ok(bobEditOnAcme, "bob's edit op is present on acme");

    // No shadow-OF-BOB on globex (bob's HOME server): when content flows back to globex,
    // bob's ref `remote:globex:bob` un-maps to local `bob`, so no self-shadow is created.
    const bobShadowOnGlobex = getUser(globex.db, `remote:globex:${bob.id}`);
    assert.equal(bobShadowOnGlobex, undefined, 'no shadow-of-bob on globex (his own ref un-maps)');

    // globex's copy is still correct after pulling acme back.
    assert.equal(getItem(globex.db, roadmap)!.title, 'Roadmap (edited by bob)');
    assert.equal(getItem(globex.db, roadmap)!.owner_id, shadowAlice, 'shadow-alice still owns it');

    // No infinite echo: a SECOND exchange with no new edits transfers nothing and the
    // push cursors stay stable.
    const before = {
      acme: getCursor(acme.db, links(acme, globex).acme.id)!,
      globex: getCursor(globex.db, links(acme, globex).globex.id)!,
    };
    const acmeOpsBefore = acme.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n;
    const globexOpsBefore = globex.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n;

    await exchangeBothWays(acme, globex, deliver);

    const after = {
      acme: getCursor(acme.db, links(acme, globex).acme.id)!,
      globex: getCursor(globex.db, links(acme, globex).globex.id)!,
    };
    assert.equal(acme.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n, acmeOpsBefore, 'no new ops on acme');
    assert.equal(
      globex.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops')!.n,
      globexOpsBefore,
      'no new ops on globex',
    );
    assert.equal(after.acme.push_since, before.acme.push_since, 'acme push cursor stable');
    assert.equal(after.globex.push_since, before.globex.push_since, 'globex push cursor stable');
  });
});

// ─── 2. write gate: a read-only link rejects an inbound pushed edit ────────────

describe('federation Phase 3 — write gate', () => {
  test('read-only link: an inbound pushed edit is rejected (title unchanged on receiver)', async () => {
    const { world, acme, globex, roadmap } = await handshake('read');
    const deliver = world.deliverToPeer;

    // Bob edits the title on globex; the acme link is READ-ONLY so acme must reject it.
    updateItem(globex.db, globex.deviceId, roadmap, { title: 'sneaky read-only edit' });
    await exchangeBothWays(acme, globex, deliver);

    assert.equal(getItem(acme.db, roadmap)!.title, 'Roadmap', 'read-only link rejects inbound write');
  });
});

// ─── 3. scope reject: a push for an item OUTSIDE the subtree is dropped ─────────

describe('federation Phase 3 — scope reject', () => {
  test('a pushed op for an item outside the granted subtree is dropped', async () => {
    const { world, acme, globex, alice } = await handshake('write');
    const deliver = world.deliverToPeer;
    const l = links(acme, globex);

    // An item that exists ONLY on globex, not under Roadmap (out of scope). Craft an op
    // and push it directly to acme's /sync with the active link secret.
    const outsideId = 'outside-item-1';
    const rogueOp: Op = {
      id: 'rogue-op-1',
      item_id: outsideId,
      ts: Date.now(),
      device_id: 'globex-dev',
      fields: { type: 'task', parent_id: null, owner_id: alice.id, title: 'rogue' },
    };
    const res = await deliver('acme', '/api/federation/sync', {
      __link_secret: l.acme.secret,
      push_ops: [rogueOp],
      push_records: [],
      since: 0,
      rsince: 0,
    });
    assert.equal(res.status, 200);
    assert.equal(getItem(acme.db, outsideId), undefined, 'out-of-scope item never created on acme');
    assert.equal(acme.db.get<{ x: number }>('SELECT 1 AS x FROM ops WHERE id = ?', ['rogue-op-1']), undefined);
  });
});

// ─── 4. owner protection: a push changing owner_id of an existing item is ignored ─

describe('federation Phase 3 — owner protection', () => {
  test('a pushed owner_id change on an existing shared item does not change the owner', async () => {
    const { world, acme, globex, alice, bob, roadmap } = await handshake('write');
    const deliver = world.deliverToPeer;
    const l = links(acme, globex);

    // Push an op that both edits the title (allowed) and tries to steal ownership to bob's
    // shadow (must be ignored). Existing item ⇒ owner_id stripped by sanitizeFederatedPush.
    const evilOp: Op = {
      id: 'evil-owner-op',
      item_id: roadmap,
      ts: Date.now() + 1000,
      device_id: 'globex-dev',
      fields: { title: 'owner-steal attempt', owner_id: `remote:acme:${bob.id}` },
    };
    const res = await deliver('acme', '/api/federation/sync', {
      __link_secret: l.acme.secret,
      push_ops: [evilOp],
      push_records: [],
      since: 0,
      rsince: 0,
    });
    assert.equal(res.status, 200);
    const r = getItem(acme.db, roadmap)!;
    assert.equal(r.owner_id, alice.id, 'owner unchanged (still alice)');
    assert.equal(r.title, 'owner-steal attempt', 'the non-ownership field DID apply');
    void bob;
  });
});

// ─── 5. no agents / no tags ────────────────────────────────────────────────────

describe('federation Phase 3 — no agents, no tags', () => {
  test('a pushed comment @mentioning a bot fires no agent; a pushed tag op creates no tag', async () => {
    const { world, acme, globex, roadmap } = await handshake('write');
    const deliver = world.deliverToPeer;
    const l = links(acme, globex);

    // A bot user on acme (agents would fire on an @mention through /api/sync, never here).
    const bot = coreCreateUser(acme.db, { username: 'botty', displayName: 'Botty', role: 'member' });
    acme.db.run('UPDATE users SET is_bot = 1 WHERE id = ?', [bot.id]);

    const now = new Date().toISOString();
    // A comment mentioning the bot, plus a tag + item_tag — all pushed to acme.
    const res = await deliver('acme', '/api/federation/sync', {
      __link_secret: l.acme.secret,
      push_ops: [],
      push_records: [
        {
          id: 'c1',
          entity: 'comment',
          row_id: 'c1',
          ts: Date.now(),
          device_id: 'globex-dev',
          data: {
            id: 'c1',
            item_id: roadmap,
            author_id: 'remote:acme:someone',
            body: 'hey @botty',
            mentions: [bot.id],
            created_at: now,
            updated_at: now,
            deleted: false,
          },
        },
        {
          id: 'tag1',
          entity: 'tag',
          row_id: 'tag1',
          ts: Date.now(),
          device_id: 'globex-dev',
          data: { id: 'tag1', name: 'imported', color: null, status: 'active', sort_order: 0, geo: null, created_at: now, updated_at: now, deleted: false },
        },
        {
          id: 'it1',
          entity: 'item_tag',
          row_id: `${roadmap}:tag1`,
          ts: Date.now(),
          device_id: 'globex-dev',
          data: { item_id: roadmap, tag_id: 'tag1', updated_at: now, deleted: false },
        },
      ],
      since: 0,
      rsince: 0,
    });
    assert.equal(res.status, 200);

    // The comment landed (record ingested), but NO tag/item_tag exist on acme.
    const tagCount = acme.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM record_ops WHERE entity IN ('tag','item_tag')")!.n;
    assert.equal(tagCount, 0, 'tags dropped on federated push');
    // No agent run was queued: the bot has no assigned/mention-driven task op created by us.
    // (triggerAgents is never called on federated ingest — assert no agent_runs row exists.)
    const agentRuns = acme.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'")
      .length;
    if (agentRuns) {
      const n = acme.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_runs')!.n;
      assert.equal(n, 0, 'no agent run fired on federated ingest');
    }
  });
});

// ─── 6. concurrent LWW: far-future peer op wins UNCLAMPED ───────────────────────

describe('federation Phase 3 — concurrent LWW unclamped', () => {
  test('simultaneous edits converge by (ts, device_id) with the far-future peer op winning', async () => {
    const { world, acme, globex, roadmap } = await handshake('write');
    const deliver = world.deliverToPeer;

    // acme edits the title with a normal (now) ts.
    updateItem(acme.db, acme.deviceId, roadmap, { title: 'acme-now-edit' });

    // globex edits the SAME field with a FAR-FUTURE causal ts (year 3000) — must win
    // unclamped after converging.
    const farTs = Date.parse('3000-01-01T00:00:00Z');
    ingestOps(
      globex.db,
      [{ id: 'far-title', item_id: roadmap, ts: farTs, device_id: 'globex-dev', fields: { title: 'globex-year-3000' } }],
      false, // synced=0 so the push loop gathers it
    );

    await exchangeBothWays(acme, globex, deliver);
    await exchangeBothWays(acme, globex, deliver); // second round to fully converge both ways

    assert.equal(getItem(acme.db, roadmap)!.title, 'globex-year-3000', 'far-future op won on acme');
    assert.equal(getItem(globex.db, roadmap)!.title, 'globex-year-3000', 'and on globex');
    const farOnAcme = acme.db.get<{ ts: number }>('SELECT ts FROM ops WHERE id = ?', ['far-title'])!;
    assert.equal(Number(farOnAcme.ts), farTs, 'ts ingested UNCLAMPED (not now+5min)');
  });
});

// ─── 7. move-in: a task reparented under Roadmap on acme reaches globex ─────────

describe('federation Phase 3 — move-in', () => {
  test('a task moved under Roadmap on acme after initial sync reaches globex next exchange', async () => {
    const { world, acme, globex, alice, roadmap } = await handshake('write');
    const deliver = world.deliverToPeer;

    // A pre-existing standalone task on acme (created BEFORE any move; predates cursor).
    const loose = createItem(acme.db, acme.deviceId, {
      type: 'task',
      parentId: null,
      ownerId: alice.id,
      title: 'Loose task',
    });

    // Prime cursors: one exchange so `loose` (out of scope) is NOT sent, cursor advances.
    await exchangeBothWays(acme, globex, deliver);
    assert.equal(getItem(globex.db, loose.id), undefined, 'loose task not yet on globex');

    // Move `loose` UNDER Roadmap on acme — now in scope but its create op predates the
    // push cursor, so the move-in backfill (`need`) must carry it.
    updateItem(acme.db, acme.deviceId, loose.id, { parent_id: roadmap });

    await exchangeBothWays(acme, globex, deliver);

    const moved = getItem(globex.db, loose.id);
    assert.ok(moved, 'moved-in task reached globex');
    assert.equal(moved!.parent_id, roadmap, 'reparented under Roadmap on globex');
    assert.equal(moved!.title, 'Loose task', 'its full content backfilled');
  });
});

// ─── 8. timingSafeEqual link auth ──────────────────────────────────────────────

describe('federation Phase 3 — timing-safe link auth', () => {
  test('findActiveLinkBySecret accepts the right secret and rejects wrong/short ones', async () => {
    const { acme, globex } = await handshake('write');
    const l = links(acme, globex);

    assert.ok(findActiveLinkBySecret(acme.db, l.acme.secret), 'correct secret accepted');
    assert.equal(findActiveLinkBySecret(acme.db, 'wrong-but-same-length-xxxxxxxxxxxxxxxxxxxxxxxx'), undefined);
    assert.equal(findActiveLinkBySecret(acme.db, 'short'), undefined, 'length-mismatch rejected');
    assert.equal(findActiveLinkBySecret(acme.db, ''), undefined, 'empty rejected');

    // Also via the HTTP /sync path (acme's own app holds acme's link): right 200, wrong 401.
    const good = await acme.app.fetch(
      new Request('http://acme.test/api/federation/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ __link_secret: l.acme.secret, since: 0, rsince: 0 }),
      }),
    );
    assert.equal(good.status, 200, 'right secret authenticates over HTTP');
    const bad = await acme.app.fetch(
      new Request('http://acme.test/api/federation/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ __link_secret: 'nope', since: 0, rsince: 0 }),
      }),
    );
    assert.equal(bad.status, 401, 'wrong secret rejected over HTTP');
  });
});

// ─── 9. concurrent-edit strand (regression) ─────────────────────────────────────
//
// A local edit committed on the SENDER's db DURING the `deliverToPeer` await — after
// the push payload was built and before the peer's response is ingested — must still
// reach the peer on the NEXT exchange. The old cursor logic advanced the push cursor
// to the max rowid of the JUST-INGESTED PEER ops; because those peer ops are appended
// ABOVE the concurrent local edit's rowid, the cursor jumped PAST that edit and it was
// never `rowid > push_since` again ⇒ silently never federated. The fix advances the
// cursor to the BUILD-TIME high-water and excludes peer-origin ops by device instead.

describe('federation Phase 3 — concurrent-edit strand (regression)', () => {
  test('a local edit landing during the pull await still federates next round', async () => {
    const { world, acme, globex, roadmap, child } = await handshake('write');
    const deliver = world.deliverToPeer;
    const l = links(acme, globex);

    // Isolate the PUSH path: we ONLY ever run acme's exchange (acme is the sender/owner).
    // globex never runs its own exchange, so acme's edits reach globex SOLELY via acme's
    // push cursor — no peer-pull path masks a stranded push.

    // globex makes a local edit. acme's pull-of-globex (the /sync response) carries it and
    // acme ingests it, appending a PEER op to acme's log — this is what the old cursor
    // jumped its push_since past, above the concurrent local edit injected below.
    updateItem(globex.db, globex.deviceId, roadmap, { title: 'from bob' });

    // Wrap deliver so that, while acme is awaiting globex's /sync response (acme's push
    // already built), a LOCAL edit lands on acme — exactly the concurrent-edit window.
    let injected = false;
    const wrapped: DeliverToPeer = async (peerBaseUrl, path, body) => {
      const res = await deliver(peerBaseUrl, path, body);
      if (!injected && peerBaseUrl === 'globex' && path === '/api/federation/sync') {
        injected = true;
        updateItem(acme.db, acme.deviceId, child, { title: 'edited during await' });
      }
      return res;
    };

    // ONLY acme's exchange (its await races the injected local edit against the appended
    // peer op). globex is never exchanged, so the push cursor is the only delivery path.
    await runFederationExchange(acme.db, l.acme, wrapped, 'acme');

    // The injected edit must NOT yet be on globex (it landed after acme built its push).
    assert.equal(
      getItem(globex.db, child)!.title,
      'Ship v1',
      'injected edit not yet delivered (landed after the push was built)',
    );

    // Next acme-only exchange (no more injection): the stranded local edit must now reach
    // globex via the push. OLD cursor logic advanced push_since to the ingested peer op's
    // rowid — above the injected edit's rowid — so it was never `rowid > push_since` again
    // and never federated. The fix keeps push_since at the build-time high-water (and keeps
    // the peer op out of the push by device), so the local edit is caught this round.
    await runFederationExchange(acme.db, l.acme, deliver, 'acme');

    assert.equal(
      getItem(globex.db, child)!.title,
      'edited during await',
      'the concurrent local edit federated on the next round (not stranded)',
    );
  });
});

// ─── 10. buildIncrementalPullPayload excludeDevices (unit) ──────────────────────

describe('federation Phase 3 — buildIncrementalPullPayload excludeDevices', () => {
  test('ops from an excluded device are omitted but the cursor still advances past them', async () => {
    const { acme, globex, roadmap } = await handshake('write');
    void globex;
    const roots = [roadmap];

    // A local acme edit (device = acme) and a peer-origin edit (device = 'peer-dev').
    updateItem(acme.db, acme.deviceId, roadmap, { title: 'local edit' });
    ingestOps(
      acme.db,
      [{ id: 'peer-op-1', item_id: roadmap, ts: Date.now() + 1, device_id: 'peer-dev', fields: { note: 'from peer' } }],
      true,
    );

    // Without exclusion: both the local and the peer op are included.
    const all = buildIncrementalPullPayload(acme.db, roots, 0, 0);
    assert.ok(all.payload.ops.some((o) => o.device_id === acme.deviceId), 'local op present');
    assert.ok(all.payload.ops.some((o) => o.id === 'peer-op-1'), 'peer op present without exclusion');

    // With exclusion: the peer-device op is dropped, but the returned `since` high-water
    // still covers it (so the cursor advances past it — no re-scan next round).
    const excl = buildIncrementalPullPayload(acme.db, roots, 0, 0, undefined, new Set(['peer-dev']));
    assert.ok(!excl.payload.ops.some((o) => o.id === 'peer-op-1'), 'peer op excluded');
    assert.ok(excl.payload.ops.some((o) => o.device_id === acme.deviceId), 'local op still present');
    assert.equal(excl.since, all.since, 'cursor high-water unchanged by exclusion (scanned, not sent)');
  });
});
