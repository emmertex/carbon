import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import {
  type Db,
  type User,
  type Permission,
  type Op,
  type RecordOp,
  upsertUser,
  getUser,
  getItem,
  hasWriteAccess,
  effectiveShares,
  listAssigneesForItem,
  shareItem,
  unshareItem,
  subtreeIds,
  ingestOps,
  ingestRecordOps,
  observeTs,
  ensureDeviceId,
} from '@carbon/core';
import {
  createSystemNotice,
  registerNoticeHandler,
  type SystemNotice,
  type NoticeState,
} from './notices';
import { safeFetch } from './safe-fetch';
import type { AuthVars } from './auth';

// ----- federation (Phase 1: storage + governance + pure gate logic) ----------
//
// This module is the server-only, per-tenant substrate for federation. It owns
// four things and NOTHING else (no transport, no offer endpoints, no sync loop —
// those are Phases 2–4):
//
//   1. Link/cursor storage  (`ensureFederationTables` + link/root/cursor CRUD)
//   2. Shadow users         (`provisionShadowUser` — a remote peer's user mirrored
//                            into the synced `users` table so shares/comments render)
//   3. Governance storage    (`ensureGovernanceTables` — workspace policy + peer
//                            whitelist, the tenant-admin half of the three-gate funnel)
//   4. Pure gate evaluation  (`hostCeilingAllows`/`workspacePolicyAllows`/`canOffer`/
//                            `canAccept` — no DB/IO; the resolution helpers that read
//                            mode/policy/peers live separately so the logic is trivially
//                            unit-tested)
//
// The tables here are server-authoritative (never CRDT-synced), except the shadow
// `users` row, which deliberately IS synced so it materialises on every client.

// ============================================================================
// B. Federation link / root / cursor storage
// ============================================================================

export type FederationDirection = 'outbound' | 'inbound';
export type FederationStatus = 'pending' | 'active' | 'revoked';

export interface FederationLink {
  id: string;
  peer_base_url: string;
  peer_label: string | null;
  direction: FederationDirection;
  /** Per-link shared secret authenticating `/api/federation/sync` (NOT an api_token). */
  secret: string;
  status: FederationStatus;
  created_at: string;
}

export interface FederationLinkRoot {
  link_id: string;
  root_item_id: string;
  permission: Permission;
}

export interface FederationCursor {
  link_id: string;
  /** PULL cursor: the peer's `ops` rowid high-water we've already pulled (sent to
   *  the peer as `since` so it returns only newer ops). */
  since: string | null;
  /** PULL cursor: the peer's `record_ops` rowid high-water we've already pulled. */
  rsince: string | null;
  /** JSON-encoded set of item ids the peer reported it's missing (backfill). */
  need_json: string | null;
  /** PUSH cursor: OUR `ops` rowid high-water already delivered to this peer. */
  push_since?: string | null;
  /** PUSH cursor: OUR `record_ops` rowid high-water already delivered to this peer. */
  push_rsince?: string | null;
}

/** Server-only per-tenant tables (not part of the synced core schema). */
export function ensureFederationTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS federation_links (
      id            TEXT PRIMARY KEY,
      peer_base_url TEXT NOT NULL,
      peer_label    TEXT,
      direction     TEXT NOT NULL,        -- outbound | inbound
      secret        TEXT NOT NULL,
      status        TEXT NOT NULL,        -- pending | active | revoked
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS federation_link_roots (
      link_id      TEXT NOT NULL,
      root_item_id TEXT NOT NULL,
      permission   TEXT NOT NULL          -- read | write
    );
    CREATE INDEX IF NOT EXISTS idx_fed_link_roots_link ON federation_link_roots(link_id);
    CREATE TABLE IF NOT EXISTS federation_cursors (
      link_id   TEXT PRIMARY KEY,
      since     TEXT,
      rsince    TEXT,
      need_json TEXT
    );
    CREATE TABLE IF NOT EXISTS federation_peer_devices (
      link_id   TEXT NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (link_id, device_id)
    );
  `);
  // Phase 3: per-link PUSH high-water marks (rowids of OUR ops/record_ops already
  // delivered to this peer). `since`/`rsince` remain the PULL cursors (the peer's
  // op-log rowids we have already pulled — sent to the peer on the next round).
  // Added idempotently so an existing Phase-2 table upgrades in place.
  for (const col of ['push_since', 'push_rsince']) {
    const present = db
      .all<{ name: string }>('PRAGMA table_info(federation_cursors)')
      .some((r) => r.name === col);
    if (!present) db.exec(`ALTER TABLE federation_cursors ADD COLUMN ${col} TEXT`);
  }
  // Federation retraction deletes every record_op keyed on a dropped item. `record_ops`
  // carries its owning item only inside the JSON `data.item_id` (no column), so index that
  // extracted value: `applyRetraction` can then match by an indexed lookup instead of a
  // full-table scan + per-row JSON.parse. `migrate(db)` (which creates `record_ops`) always
  // runs before this, so the table exists.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_record_ops_item_id ON record_ops(json_extract(data, '$.item_id'))",
  );
}

interface LinkRow {
  id: string;
  peer_base_url: string;
  peer_label: string | null;
  direction: string;
  secret: string;
  status: string;
  created_at: string;
}

function rowToLink(r: LinkRow): FederationLink {
  return {
    id: r.id,
    peer_base_url: r.peer_base_url,
    peer_label: r.peer_label,
    direction: r.direction as FederationDirection,
    secret: r.secret,
    status: r.status as FederationStatus,
    created_at: r.created_at,
  };
}

export interface CreateLinkInput {
  peerBaseUrl: string;
  peerLabel?: string | null;
  direction: FederationDirection;
  /** Provide to bind a known secret (e.g. the peer's offer_secret); else minted. */
  secret?: string;
  status?: FederationStatus;
}

/** Mint a federation link row (pending by default). Returns the created row. */
export function createLink(db: Db, input: CreateLinkInput): FederationLink {
  const link: FederationLink = {
    id: randomUUID(),
    peer_base_url: input.peerBaseUrl,
    peer_label: input.peerLabel ?? null,
    direction: input.direction,
    secret: input.secret ?? randomBytes(24).toString('hex'),
    status: input.status ?? 'pending',
    created_at: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO federation_links
       (id, peer_base_url, peer_label, direction, secret, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      link.id,
      link.peer_base_url,
      link.peer_label,
      link.direction,
      link.secret,
      link.status,
      link.created_at,
    ],
  );
  return link;
}

export function getLink(db: Db, id: string): FederationLink | undefined {
  const r = db.get<LinkRow>('SELECT * FROM federation_links WHERE id = ?', [id]);
  return r ? rowToLink(r) : undefined;
}

export function listLinks(db: Db): FederationLink[] {
  return db
    .all<LinkRow>('SELECT * FROM federation_links ORDER BY created_at')
    .map(rowToLink);
}

export function setLinkStatus(db: Db, id: string, status: FederationStatus): void {
  db.run('UPDATE federation_links SET status = ? WHERE id = ?', [status, id]);
}

/**
 * Tombstone a link and remove any dangling federation state it left behind:
 * revoke the link row, drop its `federation_link_roots`, and — null-safe — undo any
 * share rows this link's grants created. Used on decline (both sides): a pending
 * link should leave nothing behind. At the pending stage there are typically no
 * share rows yet (the issuer only mints them on `/offers/confirm`), so the share
 * cleanup is defensive: it soft-deletes only shares to the recipient's shadow on a
 * granted root, and no-ops when none exist.
 */
export function tombstoneLink(db: Db, deviceId: string, linkId: string): void {
  const link = getLink(db, linkId);
  // Undo grant shares BEFORE dropping the roots (we need the root ids + the peer
  // label to reconstruct the shadow ref). No-op when there are no matching shares.
  if (link) {
    const recipientLabel = link.peer_label ?? link.peer_base_url;
    const shadowRef = shadowUserId(recipientLabel, ''); // prefix `remote:<label>:`
    for (const r of listLinkRoots(db, linkId)) {
      // A grant share, if it exists, is `s:<root>:remote:<label>:<addressee>`; soft-
      // delete any share on this root to a shadow of the recipient peer (null-safe).
      const rows = db.all<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM shares WHERE item_id = ? AND deleted = 0',
        [r.root_item_id],
      );
      for (const s of rows) {
        if (s.user_id.startsWith(shadowRef)) {
          try {
            unshareItem(db, deviceId, r.root_item_id, s.user_id);
          } catch {
            /* best-effort: an already-gone share need not block the tombstone */
          }
        }
      }
    }
  }
  db.run('DELETE FROM federation_link_roots WHERE link_id = ?', [linkId]);
  setLinkStatus(db, linkId, 'revoked');
}

/** Grant a root to a link. Idempotent on (link_id, root_item_id): a repeat call
 *  updates the permission rather than inserting a duplicate row. */
export function addLinkRoot(
  db: Db,
  linkId: string,
  rootItemId: string,
  permission: Permission,
): void {
  const existing = db.get<{ x: number }>(
    'SELECT 1 AS x FROM federation_link_roots WHERE link_id = ? AND root_item_id = ?',
    [linkId, rootItemId],
  );
  if (existing) {
    db.run(
      'UPDATE federation_link_roots SET permission = ? WHERE link_id = ? AND root_item_id = ?',
      [permission, linkId, rootItemId],
    );
    return;
  }
  db.run(
    'INSERT INTO federation_link_roots (link_id, root_item_id, permission) VALUES (?, ?, ?)',
    [linkId, rootItemId, permission],
  );
}

export function listLinkRoots(db: Db, linkId: string): FederationLinkRoot[] {
  return db.all<FederationLinkRoot>(
    'SELECT link_id, root_item_id, permission FROM federation_link_roots WHERE link_id = ?',
    [linkId],
  );
}

export function getCursor(db: Db, linkId: string): FederationCursor | undefined {
  const r = db.get<FederationCursor>(
    'SELECT link_id, since, rsince, need_json, push_since, push_rsince FROM federation_cursors WHERE link_id = ?',
    [linkId],
  );
  return r ?? undefined;
}

/** Upsert the cursor set for a link. Only provided fields are written. */
export function setCursor(
  db: Db,
  linkId: string,
  patch: {
    since?: string | null;
    rsince?: string | null;
    needJson?: string | null;
    pushSince?: string | null;
    pushRsince?: string | null;
  },
): void {
  const cur = getCursor(db, linkId);
  const since = 'since' in patch ? patch.since ?? null : cur?.since ?? null;
  const rsince = 'rsince' in patch ? patch.rsince ?? null : cur?.rsince ?? null;
  const needJson = 'needJson' in patch ? patch.needJson ?? null : cur?.need_json ?? null;
  const pushSince = 'pushSince' in patch ? patch.pushSince ?? null : cur?.push_since ?? null;
  const pushRsince = 'pushRsince' in patch ? patch.pushRsince ?? null : cur?.push_rsince ?? null;
  db.run(
    `INSERT INTO federation_cursors (link_id, since, rsince, need_json, push_since, push_rsince)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(link_id) DO UPDATE SET
       since = excluded.since, rsince = excluded.rsince, need_json = excluded.need_json,
       push_since = excluded.push_since, push_rsince = excluded.push_rsince`,
    [linkId, since, rsince, needJson, pushSince, pushRsince],
  );
}

/**
 * Record the peer-origin `device_id`s of ops/records we INGEST via a link, so the
 * push builder can exclude them from what we send back to that peer. Local edits
 * carry OUR devices' ids; anything we ingest from the peer carries the peer's device
 * ids. Excluding those devices (rather than advancing the push cursor past the freshly
 * appended peer-op rowids) lets a concurrent local edit — committed during the pull
 * await, at a rowid BELOW the ingested peer ops — still be `rowid > push_since` next
 * round. Idempotent per (link_id, device_id). */
export function rememberPeerDevices(db: Db, linkId: string, deviceIds: Iterable<string>): void {
  for (const deviceId of deviceIds) {
    if (!deviceId) continue;
    db.run(
      'INSERT OR IGNORE INTO federation_peer_devices (link_id, device_id) VALUES (?, ?)',
      [linkId, deviceId],
    );
  }
}

/** Whether a row with `id` already exists in `ops`/`record_ops` — used to record a
 *  device as peer-origin ONLY for genuinely-new ingested ops (not our own round-trips). */
function rowExists(db: Db, table: 'ops' | 'record_ops', id: string): boolean {
  return !!db.get<{ x: number }>(`SELECT 1 AS x FROM ${table} WHERE id = ?`, [id]);
}

/** The set of peer-origin device ids learned for a link (see `rememberPeerDevices`). */
export function getPeerDevices(db: Db, linkId: string): Set<string> {
  const out = new Set<string>();
  for (const r of db.all<{ device_id: string }>(
    'SELECT device_id FROM federation_peer_devices WHERE link_id = ?',
    [linkId],
  )) {
    out.add(r.device_id);
  }
  return out;
}

// ============================================================================
// C. Shadow users
// ============================================================================

/** Deterministic id for a remote peer's user: `remote:<homeServer>:<remoteUserId>`.
 *  The `remote:` prefix guarantees it can never collide with a local uuidv4. */
export function shadowUserId(homeServer: string, remoteUserId: string): string {
  return `remote:${homeServer}:${remoteUserId}`;
}

/**
 * Upsert a synced `users` row representing a remote peer's user, so shares,
 * assignees, and comments referencing it render on clients like any local user.
 * `is_remote=1`, `home_server=<homeServer>`, id namespaced (see `shadowUserId`).
 * Idempotent: re-provisioning refreshes the display name.
 */
export function provisionShadowUser(
  db: Db,
  deviceId: string,
  homeServer: string,
  remoteUserId: string,
  displayName: string,
): User {
  void deviceId; // reserved for a future record-op-stamped path; upsertUser records the op
  const id = shadowUserId(homeServer, remoteUserId);
  const existing = getUser(db, id);
  const now = new Date().toISOString();
  const user: User = {
    id,
    // A stable, human-ish username scoped to the peer; de-collided by upsertUser if needed.
    username: existing?.username ?? `${remoteUserId}@${homeServer}`,
    display_name: displayName,
    role: 'member',
    is_bot: false,
    avatar_color: existing?.avatar_color ?? null,
    avatar_initial: existing?.avatar_initial ?? null,
    plan_startup_min: existing?.plan_startup_min ?? null,
    plan_default_estimate_min: existing?.plan_default_estimate_min ?? null,
    is_remote: true,
    home_server: homeServer,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    deleted: false,
  };
  upsertUser(db, user);
  return getUser(db, id) ?? user;
}

// ============================================================================
// D. Governance storage (workspace policy — the tenant-admin gate)
// ============================================================================

export type FederationPolicy = 'workspace_only' | 'admin_whitelist' | 'user_open';

const FEDERATION_POLICIES: readonly FederationPolicy[] = [
  'workspace_only',
  'admin_whitelist',
  'user_open',
];

/** Which list a peer row belongs to: `allow` (the admin allow-list, consulted under
 *  `admin_whitelist`) or `deny` (always-blocked, consulted under BOTH policies). */
export type PeerListType = 'allow' | 'deny';

export interface FederationPeer {
  id: string;
  base_url: string;
  subdomain: string | null;
  label: string | null;
  approved_by: string | null;
  approved_at: string | null;
  list_type: PeerListType;
  deleted: boolean;
}

/** Server-only per-tenant governance tables (not part of the synced core schema). */
export function ensureGovernanceTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS federation_peers (
      id          TEXT PRIMARY KEY,
      base_url    TEXT NOT NULL,
      subdomain   TEXT,
      label       TEXT,
      approved_by TEXT,
      approved_at TEXT,
      deleted     INTEGER NOT NULL DEFAULT 0
    );
  `);
  // A peer row is either an ALLOW-list entry (the admin allow-list consulted under
  // `admin_whitelist`) or a DENY-list entry (always-blocked, consulted under BOTH
  // `admin_whitelist` and `user_open` — deny always wins). Added idempotently so an
  // existing pre-deny-list table upgrades in place; legacy rows default to 'allow'.
  const hasListType = db
    .all<{ name: string }>('PRAGMA table_info(federation_peers)')
    .some((r) => r.name === 'list_type');
  if (!hasListType) {
    db.exec("ALTER TABLE federation_peers ADD COLUMN list_type TEXT NOT NULL DEFAULT 'allow'");
  }
}

function getSetting(db: Db, key: string): string | null {
  return (
    db.get<{ value: string | null }>('SELECT value FROM workspace_settings WHERE key = ?', [key])
      ?.value ?? null
  );
}

function setSetting(db: Db, key: string, value: string): void {
  db.run(
    `INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}

/** The workspace's federation policy (Gate 2). Defaults to the strictest,
 *  `workspace_only`, when unset or unrecognised. Shaped like `getNlSettings`. */
export function getFederationPolicy(db: Db): FederationPolicy {
  const raw = getSetting(db, 'federation_policy');
  return raw && (FEDERATION_POLICIES as readonly string[]).includes(raw)
    ? (raw as FederationPolicy)
    : 'workspace_only';
}

export function setFederationPolicy(db: Db, value: FederationPolicy): void {
  setSetting(db, 'federation_policy', value);
}

/** Workspace sync-epoch (Tier-2 log rebuild). Defaults to 1 when unset. */
export function getSyncEpoch(db: Db): number {
  const raw = getSetting(db, 'sync_epoch');
  const n = raw == null ? 1 : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function setSyncEpoch(db: Db, epoch: number): void {
  const n = Math.max(1, Math.floor(epoch));
  setSetting(db, 'sync_epoch', String(n));
}

/** Increment sync_epoch by 1; returns the new value. */
export function bumpSyncEpoch(db: Db): number {
  const next = getSyncEpoch(db) + 1;
  setSyncEpoch(db, next);
  return next;
}

interface PeerRow {
  id: string;
  base_url: string;
  subdomain: string | null;
  label: string | null;
  approved_by: string | null;
  approved_at: string | null;
  list_type: string | null;
  deleted: number;
}

function rowToPeer(r: PeerRow): FederationPeer {
  return {
    id: r.id,
    base_url: r.base_url,
    subdomain: r.subdomain,
    label: r.label,
    approved_by: r.approved_by,
    approved_at: r.approved_at,
    // Legacy rows (added before the column existed) may read null → treat as 'allow'.
    list_type: r.list_type === 'deny' ? 'deny' : 'allow',
    deleted: !!r.deleted,
  };
}

export interface AddPeerInput {
  baseUrl: string;
  subdomain?: string | null;
  label?: string | null;
  approvedBy?: string | null;
  /** Which list the peer joins. Defaults to `allow` (the admin allow-list). */
  listType?: PeerListType;
}

/** Add a peer to either the admin allow-list (default; consulted under
 *  `admin_whitelist`) or the deny-list (always-blocked under BOTH policies). */
export function addPeer(db: Db, input: AddPeerInput): FederationPeer {
  const peer: FederationPeer = {
    id: randomUUID(),
    base_url: input.baseUrl,
    subdomain: input.subdomain ?? null,
    label: input.label ?? null,
    approved_by: input.approvedBy ?? null,
    approved_at: new Date().toISOString(),
    list_type: input.listType === 'deny' ? 'deny' : 'allow',
    deleted: false,
  };
  db.run(
    `INSERT INTO federation_peers
       (id, base_url, subdomain, label, approved_by, approved_at, list_type, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      peer.id,
      peer.base_url,
      peer.subdomain,
      peer.label,
      peer.approved_by,
      peer.approved_at,
      peer.list_type,
    ],
  );
  return peer;
}

/** Live (non-deleted) peers. Pass a `listType` to filter to just the allow- or
 *  deny-list; omit it to return both. */
export function listPeers(db: Db, listType?: PeerListType): FederationPeer[] {
  const rows = listType
    ? db.all<PeerRow>(
        'SELECT * FROM federation_peers WHERE deleted = 0 AND list_type = ? ORDER BY approved_at',
        [listType],
      )
    : db.all<PeerRow>('SELECT * FROM federation_peers WHERE deleted = 0 ORDER BY approved_at');
  return rows.map(rowToPeer);
}

/** Soft-delete a peer (allow OR deny; tombstone by id; idempotent). */
export function removePeer(db: Db, id: string): void {
  db.run('UPDATE federation_peers SET deleted = 1 WHERE id = ?', [id]);
}

// ============================================================================
// E. Pure gate-evaluation helpers (no DB / no IO)
// ============================================================================
//
// The plan's three-gate funnel. These take ALREADY-RESOLVED inputs; the DB/env
// lookups that resolve `mode`/`policy`/`peerOnAllowlist`/`peerOnDenylist` happen in the
// callers (Phase 2 writes those). Keeping the pure logic separate makes the truth table
// trivially unit-testable.

/** A peer's tier: same-host (L2) is `intra_server`; different host (L3) is `cross_server`. */
export type FederationTier = 'intra_server' | 'cross_server';

/** The host ceiling (Gate 1). Resolved value — env default already applied and
 *  single-tenant self-host already collapsed to `off` by the caller. */
export type FederationMode = 'off' | 'intra_server' | 'cross_server';

export interface GateInputs {
  mode: FederationMode;
  policy: FederationPolicy;
  tier: FederationTier;
  /** Whether the peer is on this workspace's admin allow-list (only consulted
   *  under `admin_whitelist`). */
  peerOnAllowlist: boolean;
  /** Whether the peer is on this workspace's admin deny-list. Deny ALWAYS wins:
   *  a denied peer is blocked regardless of policy (both `user_open` and
   *  `admin_whitelist`). Defaults to `false` when omitted. */
  peerOnDenylist?: boolean;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Resolve the effective host ceiling (Gate 1) from already-fetched inputs — a
 * pure helper so the resolution rule is unit-testable without index.ts's env
 * side effects. Single-tenant self-host has no peer and collapses to `off`; a
 * per-tenant `override` (the control-DB `federation_mode`) beats the env default;
 * an unset/unrecognised override inherits `envDefault`.
 */
export function resolveHostCeiling(args: {
  override: string | null | undefined;
  envDefault: FederationMode;
  isSelfHost: boolean;
}): FederationMode {
  if (args.isSelfHost) return 'off';
  const o = args.override;
  if (o === 'off' || o === 'intra_server' || o === 'cross_server') return o;
  return args.envDefault;
}

/** Gate 1 — host ceiling. `off` allows nothing; `intra_server` allows only an
 *  intra-server (L2) peer; `cross_server` allows both tiers. */
export function hostCeilingAllows(mode: FederationMode, tier: FederationTier): boolean {
  if (mode === 'off') return false;
  if (mode === 'intra_server') return tier === 'intra_server';
  return true; // cross_server
}

/** Gate 2 — workspace policy. Deny ALWAYS wins: a peer on the deny-list is blocked
 *  regardless of policy. Otherwise `workspace_only` never federates; `admin_whitelist`
 *  requires the peer to be on the allow-list; `user_open` always permits. */
export function workspacePolicyAllows(
  policy: FederationPolicy,
  peerOnAllowlist: boolean,
  peerOnDenylist = false,
): boolean {
  if (peerOnDenylist) return false; // deny wins over every policy
  if (policy === 'workspace_only') return false;
  if (policy === 'admin_whitelist') return peerOnAllowlist;
  return true; // user_open
}

/** Composite of Gates 1–2 (Gate 3 — recipient approval — is the user's click,
 *  enforced separately by the notice handler). Used at BOTH edges. */
function evaluateGates(i: GateInputs): GateResult {
  if (!hostCeilingAllows(i.mode, i.tier)) {
    return { ok: false, reason: `host ceiling '${i.mode}' blocks a '${i.tier}' peer` };
  }
  if (!workspacePolicyAllows(i.policy, i.peerOnAllowlist, i.peerOnDenylist ?? false)) {
    // Deny wins, so report it first (it applies regardless of policy).
    const why = i.peerOnDenylist
      ? 'peer is on the deny list'
      : i.policy === 'workspace_only'
        ? "workspace policy is 'workspace_only'"
        : 'peer is not on the allow list';
    return { ok: false, reason: why };
  }
  return { ok: true };
}

/** Outbound edge: may this workspace SEND an offer to the peer? (Gates 1–2.) */
export function canOffer(i: GateInputs): GateResult {
  return evaluateGates(i);
}

/** Inbound edge: may this workspace ACCEPT an offer from the peer? (Gates 1–2;
 *  Gate 3 — the addressed user's approval click — is layered on by the caller.) */
export function canAccept(i: GateInputs): GateResult {
  return evaluateGates(i);
}

// ============================================================================
// F. Phase 2 — transport seam, offer/inbound/sync endpoints, and the pull ingest
// ============================================================================
//
// Scope (Phase 2): read-only, single granted root, same-host (L2) loopback only.
// Bidirectional write, per-link push, per-link cursors, and cross-server HTTPS are
// later phases and are intentionally NOT built here.

/**
 * Deliver an offer/callback/sync request to a peer. One code path for both tiers:
 * an L2 same-host peer is an in-process loopback into the peer's inbound HTTP route;
 * an L3 remote peer is real HTTPS to the same route over the network (Phase 6). The
 * concrete transport is built by `makeDeliverToPeer` below.
 */
export type DeliverToPeer = (
  peerBaseUrl: string,
  path: string,
  body: unknown,
) => Promise<Response>;

// ----- the L2/L3 transport seam (Phase 6) -----------------------------------

/** The narrow in-process app capability the L2 loopback path calls (a Hono app's
 *  `fetch`). Kept structural so this module needn't import the registry/tenant types. */
export interface FetchApp {
  fetch(req: Request): Promise<Response> | Response;
}

/** The remote HTTP transport used for L3 delivery, injectable so tests can route the
 *  "HTTPS" call into a second in-process tenant app WITHOUT a real socket or tripping
 *  the SSRF guard. Same signature as `safeFetch(url, allowPrivate, init)`. */
export type HttpFetch = (
  url: string,
  allowPrivate: boolean,
  init?: RequestInit,
) => Promise<Response>;

/** Whether a peer address is a bare same-host tenant label (L2 loopback) rather than a
 *  full URL / dotted host (L3 remote). A bare subdomain has no scheme, path, port, or dot. */
export function isLocalPeer(peerBaseUrl: string): boolean {
  return !(
    peerBaseUrl.includes('.') ||
    peerBaseUrl.includes('/') ||
    peerBaseUrl.includes(':')
  );
}

/** Join a peer base URL and a request path into one absolute URL. The base may be a
 *  bare host (`peer.example.com`, defaulting to https) or an explicit `https://…`
 *  origin; a trailing slash on the base and a leading slash on the path collapse. */
export function joinPeerUrl(peerBaseUrl: string, path: string): string {
  const base = /^https?:\/\//.test(peerBaseUrl) ? peerBaseUrl : `https://${peerBaseUrl}`;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Build the peer-delivery transport — one code path for L2 and L3:
 *
 *  - **Same-host** (a bare subdomain resolving to a local tenant via `getApp`) →
 *    in-process loopback: `getApp(subdomain).fetch(new Request(...))`. Unchanged from
 *    Phase 2.
 *  - **Remote** (a full URL, a dotted host, or a bare label with no local tenant) →
 *    real HTTPS: POST `joinPeerUrl(base, path)` via `httpFetch` (default `safeFetch`,
 *    which refuses private/loopback targets unless `allowPrivate()`). The link secret
 *    in `body.__link_secret` is ALSO sent in the `x-federation-secret` header (the L3
 *    shape `linkAuth` accepts); the body keeps `__link_secret` for uniformity, and
 *    failures reject (callers already skip unreachable peers).
 */
export function makeDeliverToPeer(opts: {
  getApp: (subdomain: string) => FetchApp | null;
  /** Apex domain (for the loopback Host header). Undefined ⇒ single-tenant/self-host. */
  baseDomain?: string;
  /** L3 remote transport (default `safeFetch`). */
  httpFetch?: HttpFetch;
  /** Resolve whether L3 may reach a private/loopback/LAN peer (default: never). */
  allowPrivate?: () => boolean;
}): DeliverToPeer {
  const httpFetch = opts.httpFetch ?? safeFetch;
  const resolveAllowPrivate = opts.allowPrivate ?? (() => false);
  return async (peerBaseUrl, path, body) => {
    // ----- L2: same-host in-process loopback (a bare label with a local tenant) -----
    if (isLocalPeer(peerBaseUrl)) {
      const app = opts.getApp(peerBaseUrl);
      if (app) {
        const host = opts.baseDomain ? `${peerBaseUrl}.${opts.baseDomain}` : 'localhost';
        const req = new Request(`http://${host}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', host },
          body: JSON.stringify(body ?? {}),
        });
        return app.fetch(req);
      }
      // A bare label with no local tenant is not a valid same-host peer, and we can't
      // form an HTTPS origin from it — nothing to reach.
      throw new Error('unsupported_peer');
    }

    // ----- L3: real HTTPS to a remote Carbon host -----
    const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
    const secret = rec && typeof rec.__link_secret === 'string' ? rec.__link_secret : undefined;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-federation-secret'] = secret;
    return httpFetch(joinPeerUrl(peerBaseUrl, path), resolveAllowPrivate(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
  };
}

/**
 * The narrow local blob-store capability the federation blob routes close over — the
 * SAME on-disk content-addressed store `GET/POST /api/blobs/:hash` uses, injected so
 * this module stays free of Node fs/path/quota specifics. `read` returns the raw bytes
 * (or null if absent); `store` writes them under the hash (dedup + hash-verify are the
 * caller's/store's concern — `storeVerified` below re-hashes before it ever calls this).
 */
export interface BlobStore {
  has(hash: string): boolean;
  read(hash: string): Buffer | null;
  store(hash: string, bytes: Buffer): void;
}

/** An in-memory `BlobStore` (a plain Map). Used by the headless federation tests; the
 *  production store is on-disk (`join(BLOBS_DIR, hash)` in index.ts). */
export function memBlobStore(): BlobStore & { size: number } {
  const m = new Map<string, Buffer>();
  return {
    has: (hash) => m.has(hash),
    read: (hash) => m.get(hash) ?? null,
    store: (hash, bytes) => void m.set(hash, bytes),
    get size() {
      return m.size;
    },
  };
}

/** Hono context vars the federation routes read/set. `userId`/`authMethod`/`role`
 *  come from the tenant's `basicAuth`; `fedLink` is set by the link-auth middleware. */
/** The federation routes read `userId`/`authMethod` from the tenant's `basicAuth`
 *  (so `FedVars` extends `AuthVars` for middleware compatibility) and set `fedLink`
 *  on the link-auth path. */
interface FedVars extends AuthVars {
  /** Set by the link-auth middleware on /api/federation/sync. */
  fedLink?: FederationLink;
}

/** Everything the federation routes close over for one tenant. */
export interface FederationDeps {
  db: Db;
  serverDeviceId: string;
  /** This workspace's own subdomain label (used to build `<user>@<label>` and to
   *  un-map shadow refs the peer was mirroring back to us). */
  myLabel: string;
  /** This workspace's own externally-reachable base — its full host (or `https://…`
   *  origin) under `BASE_DOMAIN` — advertised as the `callback_base_url` for an L3
   *  (cross-server) offer so a remote recipient can reach us back over HTTPS. Unset
   *  ⇒ same-host only: the bare `myLabel` is used (an L2 loopback resolves it). */
  myBaseUrl?: string;
  /** Resolve the effective host ceiling (Gate 1) for THIS workspace. */
  resolveMode: () => FederationMode;
  /** The narrow peer-delivery capability (loopback for L2). */
  deliverToPeer: DeliverToPeer;
  /** This tenant's local content-addressed blob store (Phase 5). The blob serve
   *  endpoint reads from it; the fetch-from-peer fallback writes verified bytes to it. */
  blobStore: BlobStore;
  /** Human-session auth middleware (the tenant's `basicAuth`) — applied ONLY to the
   *  outbound `/offers` route so it identifies the caller. The inbound/confirm/sync
   *  routes are secret-authed and must NOT run it. */
  sessionAuth: MiddlewareHandler<{ Variables: FedVars }>;
}

/** Parse a `user@subdomain` federation address. Returns null if malformed. */
export function parseAddress(addr: string): { user: string; label: string } | null {
  const at = addr.indexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  const user = addr.slice(0, at).trim();
  const label = addr.slice(at + 1).trim();
  if (!user || !label) return null;
  // Phase 2 is same-host L2: a bare subdomain (no dot). A dotted label is an L3
  // host address; we still parse it (the host ceiling rejects the cross_server tier).
  return { user, label };
}

/** The peer's tier from THIS workspace's perspective: a bare same-host subdomain is
 *  `intra_server` (L2); a dotted host label is `cross_server` (L3). */
export function tierForLabel(label: string): FederationTier {
  return label.includes('.') ? 'cross_server' : 'intra_server';
}

/** A peer is on the allow-list if any live ALLOW-list peer row matches its
 *  subdomain/base. (Deny rows live in the same table but must not count here.) */
function peerWhitelisted(db: Db, label: string): boolean {
  return listPeers(db, 'allow').some((p) => p.subdomain === label || p.base_url === label);
}

/** A peer is denied if any live DENY-list peer row matches its subdomain/base. Deny
 *  always wins — this is consulted under BOTH `user_open` and `admin_whitelist`. */
export function peerDenied(db: Db, label: string): boolean {
  return listPeers(db, 'deny').some((p) => p.subdomain === label || p.base_url === label);
}

// ----- correlation state for the outbound side ------------------------------
//
// When we send an offer we must remember enough to (a) recognise the peer's
// acceptance callback and (b) let the peer pull from us. We stash it in the link's
// `peer_base_url` as a structured token and keep the per-offer secret in a small
// server-only table so the callback can be authenticated.

/** Server-only table binding an outbound offer to its per-offer confirm secret and
 *  the local user who made the offer (so a decline callback can target them). */
function ensureOfferTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS federation_offers (
      link_id      TEXT PRIMARY KEY,
      offer_secret TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
  `);
  // The offerer's local user id — added idempotently so an existing Phase-2 table
  // upgrades in place. Nullable: rows minted before this column existed have none.
  const present = db
    .all<{ name: string }>('PRAGMA table_info(federation_offers)')
    .some((r) => r.name === 'offered_by');
  if (!present) db.exec('ALTER TABLE federation_offers ADD COLUMN offered_by TEXT');
}

function putOfferSecret(
  db: Db,
  linkId: string,
  offerSecret: string,
  offeredBy?: string | null,
): void {
  ensureOfferTable(db);
  db.run(
    `INSERT INTO federation_offers (link_id, offer_secret, created_at, offered_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(link_id) DO UPDATE SET
       offer_secret = excluded.offer_secret, offered_by = excluded.offered_by`,
    [linkId, offerSecret, new Date().toISOString(), offeredBy ?? null],
  );
}

function findLinkByOfferSecret(db: Db, offerSecret: string): string | null {
  ensureOfferTable(db);
  return (
    db.get<{ link_id: string }>('SELECT link_id FROM federation_offers WHERE offer_secret = ?', [
      offerSecret,
    ])?.link_id ?? null
  );
}

/** The offer-correlation row for an offer_secret: the granted link + the local user
 *  who made the offer (`offered_by`). Used by the decline callback to target a notice. */
function findOfferBySecret(
  db: Db,
  offerSecret: string,
): { link_id: string; offered_by: string | null } | null {
  ensureOfferTable(db);
  return (
    db.get<{ link_id: string; offered_by: string | null }>(
      'SELECT link_id, offered_by FROM federation_offers WHERE offer_secret = ?',
      [offerSecret],
    ) ?? null
  );
}

/** Drop the offer-correlation row for a link (after the offer reaches a terminal state). */
function deleteOfferRow(db: Db, linkId: string): void {
  ensureOfferTable(db);
  db.run('DELETE FROM federation_offers WHERE link_id = ?', [linkId]);
}

// ----- identity remap (pull direction) --------------------------------------

/**
 * Remap a user reference pulled from a peer into a local id — the pull-direction
 * analogue of `applyImport`'s user remapping.
 *
 *   `remote:<myLabel>:<id>` → `<id>`                one of MY users the peer shadowed → un-map
 *   other `remote:*`        → unchanged             a third-party shadow, keep as-is
 *   otherwise (peer-local)  → `remote:<peerLabel>:<ref>`   becomes MY shadow
 */
export function remapUserRef(
  ref: string | null | undefined,
  myLabel: string,
  peerLabel: string,
): string | null | undefined {
  if (ref == null) return ref;
  if (ref.startsWith('remote:')) {
    const rest = ref.slice('remote:'.length);
    const sep = rest.indexOf(':');
    if (sep > 0) {
      const home = rest.slice(0, sep);
      const id = rest.slice(sep + 1);
      if (home === myLabel) return id; // un-map: one of mine the peer was shadowing
    }
    return ref; // a third-party shadow — leave unchanged
  }
  return `remote:${peerLabel}:${ref}`; // a peer-local id becomes my shadow
}

/** Deterministic join-id regeneration, matching repo.ts (`s:<item>:<user>` /
 *  `a:<item>:<user>`). Applied AFTER remap, exactly like `applyImport`. */
const shareRowId = (itemId: string, userId: string) => `s:${itemId}:${userId}`;
const assigneeRowId = (itemId: string, userId: string) => `a:${itemId}:${userId}`;

// ----- shared identity-remap primitives (used by BOTH the pull ingest and the
//        inbound-push sanitizer, so the remap rule lives in exactly one place) ---

/** A shadow-provisioner closure: given a remapped local ref (`remote:*`) and the
 *  original peer ref it came from, upsert the shadow `users` row (once). */
type EnsureShadow = (localRef: string | null | undefined, originalPeerRef?: string) => void;

/** Build the `ensureShadow` closure for a batch, naming shadows from the pulled
 *  public-user projection when available. Shared by pull-ingest and push-sanitize. */
function makeEnsureShadow(db: Db, deviceId: string, users?: PulledUser[]): EnsureShadow {
  const pulledById = new Map<string, PulledUser>();
  for (const u of users ?? []) pulledById.set(u.id, u);
  const provisioned = new Set<string>();
  return (localRef, originalPeerRef) => {
    if (!localRef || !localRef.startsWith('remote:') || provisioned.has(localRef)) return;
    provisioned.add(localRef);
    const rest = localRef.slice('remote:'.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return;
    const home = rest.slice(0, sep);
    const remoteId = rest.slice(sep + 1);
    const pulled = (originalPeerRef && pulledById.get(originalPeerRef)) || pulledById.get(remoteId);
    const name = pulled?.display_name ?? pulled?.username ?? remoteId;
    provisionShadowUser(db, deviceId, home, remoteId, name);
  };
}

/**
 * Remap the identity fields of ONE record op into local refs, provisioning shadows,
 * and regenerate its deterministic join id — the per-record half of the pull/push
 * identity rewrite. Returns `null` for a dropped entity (tag/item_tag) or a record
 * whose `item_id` is not in `scope`. Pure w.r.t. ownership/scoping decisions made by
 * the caller; the CALLER owns whether to also enforce owner-change protection.
 */
function remapRecordOp(
  rec: RecordOp,
  scope: Set<string>,
  remap: (ref: string | null | undefined) => string | null | undefined,
  ensureShadow: EnsureShadow,
): RecordOp | null {
  if (rec.entity === 'tag' || rec.entity === 'item_tag') return null; // tags dropped
  const data = { ...(rec.data as Record<string, unknown>) };
  const itemId = data.item_id as string | undefined;
  if (!itemId || !scope.has(itemId)) return null; // scope-reject

  let userField: 'user_id' | 'author_id' | null = null;
  if (rec.entity === 'share' || rec.entity === 'assignee' || rec.entity === 'timelog') {
    userField = 'user_id';
  } else if (rec.entity === 'comment') {
    userField = 'author_id';
  }

  if (userField && userField in data) {
    const before = data[userField] as string | null | undefined;
    const after = remap(before);
    data[userField] = after ?? null;
    ensureShadow(after ?? undefined, before ?? undefined);
  }
  if (rec.entity === 'comment' && Array.isArray(data.mentions)) {
    data.mentions = (data.mentions as (string | null)[])
      .map((m) => {
        const after = remap(m);
        ensureShadow(after ?? undefined, m ?? undefined);
        return after;
      })
      .filter((m): m is string => typeof m === 'string');
  }
  if (rec.entity === 'attachment' && 'created_by' in data) {
    const before = data.created_by as string | null | undefined;
    const after = remap(before);
    data.created_by = after ?? null;
    ensureShadow(after ?? undefined, before ?? undefined);
  }

  // Regenerate deterministic join ids AFTER remap (exactly like applyImport).
  let rowId = rec.row_id;
  if (rec.entity === 'share') {
    rowId = shareRowId(itemId, data.user_id as string);
    (data as { id?: string }).id = rowId;
  } else if (rec.entity === 'assignee') {
    rowId = assigneeRowId(itemId, data.user_id as string);
    (data as { id?: string }).id = rowId;
  }
  return { ...rec, row_id: rowId, data };
}

/** The public projection a peer sends for each referenced user (for shadow naming). */
export interface PulledUser {
  id: string;
  username: string;
  display_name: string | null;
}

export interface PullPayload {
  ops: Op[];
  records: RecordOp[];
  users: PulledUser[];
}

/**
 * Materialize a peer's scoped `{ops, records, users}` locally with identity remap.
 * Read-only Phase 2: single granted root subtree. Mirrors `applyImport` (remap →
 * regen join ids → ingest) but streaming, scoped, and local→shadow.
 *
 *  - `owner_id` on item ops and `user_id`/`author_id`/`mentions` on records are
 *    remapped via `remapUserRef`; join ids are regenerated AFTER remap.
 *  - A shadow `users` row is provisioned for every non-local remapped user.
 *  - Ops are ingested WITHOUT the sync sanitizer (no ownership stamping) and
 *    WITHOUT clamping `ts` (trusted, link-scoped content keyed by the granted root);
 *    we still `observeTs` so our clock advances.
 *  - tag/item_tag records are dropped. `triggerAgents` is NEVER called.
 *  - Anything whose `item_id ∉ subtreeIds(grantedRoots)` is dropped (defense-in-depth).
 */
export function ingestFederatedPull(
  db: Db,
  deviceId: string,
  grantedRoots: string[],
  peerLabel: string,
  myLabel: string,
  payload: PullPayload,
  linkId?: string,
): void {
  // Learn the peer-origin device ids of everything we ingest for this link so the push
  // builder can exclude them (peer-echo suppression by device, not by cursor jump). Only
  // NEW ops count: an op that originated on US and is round-tripping back already exists
  // here, so recording its (our-own) device id would strand our local edits.
  if (linkId) {
    const devs = new Set<string>();
    for (const op of payload.ops ?? []) {
      if (op.device_id && !rowExists(db, 'ops', op.id)) devs.add(op.device_id);
    }
    for (const rec of payload.records ?? []) {
      if (rec.device_id && !rowExists(db, 'record_ops', rec.id)) devs.add(rec.device_id);
    }
    rememberPeerDevices(db, linkId, devs);
  }
  const remap = (ref: string | null | undefined) => remapUserRef(ref, myLabel, peerLabel);
  const ensureShadow = makeEnsureShadow(db, deviceId, payload.users);

  // Scope: only within the granted subtree(s) as they exist locally. We ingest item
  // ops FIRST (so the subtree materializes), computing the allowed set as we go.
  const rootSet = new Set(grantedRoots);

  // ----- item ops -----------------------------------------------------------
  // Sort by ts so a parent-defining create is applied before its children, letting
  // subtreeIds see the structure incrementally. Then scope-filter against the
  // resolved subtree.
  const sortedOps = [...(payload.ops ?? [])].sort((a, b) => a.ts - b.ts);
  const remappedOps: Op[] = [];
  for (const op of sortedOps) {
    const fields = { ...op.fields } as Record<string, unknown>;
    if ('owner_id' in fields) {
      const before = fields.owner_id as string | null | undefined;
      const after = remap(before);
      fields.owner_id = after ?? null;
      ensureShadow(after ?? undefined, before ?? undefined);
    }
    remappedOps.push({ ...op, fields: fields as Op['fields'] });
  }
  // Ingest so the subtree exists, then compute the authorized set and drop strays.
  if (remappedOps.length) ingestOps(db, remappedOps, true);
  const subtree = subtreeIds(db, [...rootSet]);
  // Defense-in-depth: remove any op we ingested whose item fell outside the subtree.
  for (const op of remappedOps) {
    if (!subtree.has(op.item_id)) {
      db.run('DELETE FROM ops WHERE id = ?', [op.id]);
      db.run('DELETE FROM items WHERE id = ?', [op.item_id]);
    }
  }
  // Advance our clock past the batch (ingestOps already did, but be explicit for the
  // dropped-then-not-ingested edge).
  let maxTs = 0;
  for (const op of remappedOps) if (op.ts > maxTs) maxTs = op.ts;
  if (maxTs) observeTs(db, maxTs);

  // ----- record ops ---------------------------------------------------------
  const remappedRecs: RecordOp[] = [];
  for (const rec of payload.records ?? []) {
    const remapped = remapRecordOp(rec, subtree, remap, ensureShadow);
    if (remapped) remappedRecs.push(remapped);
  }
  if (remappedRecs.length) ingestRecordOps(db, remappedRecs, true);
}

// ----- push-side identity forgery guard -------------------------------------
//
// After `remapUserRef`, a peer-supplied identity ref shaped `remote:<myLabel>:<id>` un-maps
// to the BARE local id `<id>` — i.e. one of OUR real users. A peer-local id, by contrast,
// always remaps to a `remote:<peerLabel>:*` shadow. So a bare (non-`remote:`) remapped ref
// that resolves to a real local user is the ONLY way a peer can name one of our users, and it
// is exactly the identity-forgery vector: a grantee peer is NOT authoritative for our users,
// so it must not push a share/assignee/comment/attachment that assigns identity to one of them.

/** The record op's primary identity field VALUE (the local user it assigns identity to):
 *  share/assignee → `user_id`, comment → `author_id`, attachment → `created_by`. */
function recordIdentityRef(rec: RecordOp): string | null {
  const data = rec.data as Record<string, unknown>;
  const field =
    rec.entity === 'share' || rec.entity === 'assignee'
      ? 'user_id'
      : rec.entity === 'comment'
        ? 'author_id'
        : rec.entity === 'attachment'
          ? 'created_by'
          : null;
  if (!field) return null;
  const v = data[field];
  return typeof v === 'string' ? v : null;
}

/** Whether `ref` (a POST-remap value) names an existing, real (non-shadow) local user. A
 *  `remote:*` shadow ref never does — only a bare id that un-mapped from `remote:<myLabel>:*`
 *  can, and that is precisely what the peer must not be free to assign identity to. */
function refIsExistingLocalUser(db: Db, ref: string | null | undefined): boolean {
  if (!ref || ref.startsWith('remote:')) return false;
  const u = getUser(db, ref);
  return !!u && !u.is_remote;
}

/** Whether `userId` is already a legitimate participant on `itemId` — its owner, someone it
 *  is (effectively, incl. inherited) shared with, or an assignee. A peer MAY reference such
 *  a user (e.g. re-echo an existing share, or @mention the owner); it may NOT introduce a
 *  brand-new grant/authorship for a local user with no prior relationship to the item. */
function isItemParticipant(db: Db, itemId: string, userId: string): boolean {
  if (getItem(db, itemId)?.owner_id === userId) return true;
  if (effectiveShares(db, itemId).some((e) => e.user_id === userId)) return true;
  if (listAssigneesForItem(db, itemId).some((a) => a.user_id === userId)) return true;
  return false;
}

/** Identity-forgery gate for ONE remapped record op on the PUSH (peer-writes-to-us) path:
 *  true ⇒ the op assigns identity to an EXISTING local user who is not already a participant
 *  on the item, so the caller must drop it. Returns false for ops naming only shadows /
 *  already-participating users (the legitimate cases). */
function forgesLocalIdentity(db: Db, rec: RecordOp): boolean {
  const itemId = (rec.data as { item_id?: unknown }).item_id;
  if (typeof itemId !== 'string') return false;
  const ref = recordIdentityRef(rec);
  return refIsExistingLocalUser(db, ref) && !isItemParticipant(db, itemId, ref!);
}

// ----- push side: validate + ingest ops a peer PUSHES to us -----------------

/**
 * Validate and ingest edits a peer PUSHES to us — the counterpart to `sanitizeOps`
 * for the federation channel. Security-critical; a peer is NOT trusted to have
 * checked scope, identity, or ownership.
 *
 *  - **Write gate + scope:** `writableRoots` = the link's roots whose permission is
 *    `write`; `allowed = subtreeIds(db, writableRoots)`. Any op/record whose
 *    `item_id ∉ allowed` is DROPPED — except a **create** of a brand-new item whose
 *    `parent_id ∈ allowed` (attach under the shared subtree). Reparenting an
 *    **existing** out-of-scope item into the subtree via `parent_id` is rejected.
 *    A read-only root accepts NO inbound writes.
 *  - **Identity:** `owner_id` (ops) and `user_id`/`author_id`/`mentions`/`created_by`
 *    (records) are remapped via `remapUserRef(ref, myLabel, peerLabel)`; a shadow user
 *    is provisioned per non-local ref; join ids regenerated after remap.
 *  - **Ownership protection:** a peer may NOT reassign ownership of an item that
 *    already exists in OUR db — any `owner_id` change on an existing item is stripped
 *    (mirrors how `sanitizeOps` only lets the current owner transfer). A create op for
 *    a brand-new in-scope item MAY set the remapped shadow as owner.
 *  - **No ts clamp** (peer causal clock; clamping corrupts LWW). Still `observeTs`.
 *  - **Tags dropped** (tag/item_tag). `triggerAgents` is NEVER called by the ingest.
 *
 * Returns the sanitized `{ ops, records }`; the caller ingests them (idempotent).
 */
export function sanitizeFederatedPush(
  db: Db,
  link: FederationLink,
  peerLabel: string,
  myLabel: string,
  deviceId: string,
  ops: Op[],
  records: RecordOp[],
  users?: PulledUser[],
): { ops: Op[]; records: RecordOp[] } {
  const remap = (ref: string | null | undefined) => remapUserRef(ref, myLabel, peerLabel);
  const ensureShadow = makeEnsureShadow(db, deviceId, users);

  // Write gate: only roots granted `write` contribute to the allowed subtree. A
  // read-only root's subtree is NOT writable, so any push into it is rejected.
  const writableRoots = listLinkRoots(db, link.id)
    .filter((r) => r.permission === 'write')
    .map((r) => r.root_item_id);
  const allowed = subtreeIds(db, writableRoots);

  // ----- item ops -----------------------------------------------------------
  // Sort by ts so a parent-defining create lands before its children, letting the
  // allowed set grow as new in-scope items materialize (a child of a writable item
  // is itself writable). We recompute membership per op against the growing set.
  const sortedOps = [...(ops ?? [])].sort((a, b) => a.ts - b.ts);
  const outOps: Op[] = [];
  let maxTs = 0;
  for (const op of sortedOps) {
    if (!op || typeof op.item_id !== 'string') continue;
    const existing = db.get<{ owner_id: string | null }>(
      'SELECT owner_id FROM items WHERE id = ?',
      [op.item_id],
    );
    // A create op may bring a NEW item into scope if its parent is already in `allowed`.
    // Existing items must already be in `allowed` — do NOT let a peer reparent an
    // out-of-scope row into the shared subtree (that would bypass the write scope).
    const parentId = (op.fields as { parent_id?: string | null } | undefined)?.parent_id;
    const inScope = existing
      ? allowed.has(op.item_id)
      : allowed.has(op.item_id) ||
        (typeof parentId === 'string' && allowed.has(parentId));
    if (!inScope) continue; // scope + write-gate reject
    // Only an accepted (in-scope) op advances OUR clock — a rejected out-of-scope op must
    // NOT push the local causal clock forward (else a stray peer op silently bumps it).
    if (op.ts > maxTs) maxTs = op.ts;
    if (!existing) allowed.add(op.item_id); // now writable; its children may follow

    const fields = { ...op.fields } as Record<string, unknown>;
    if ('owner_id' in fields) {
      if (existing) {
        // Ownership protection: a peer can NEVER reassign an existing item's owner.
        delete fields.owner_id;
      } else {
        // Brand-new in-scope item: remap the offered owner to its shadow.
        const before = fields.owner_id as string | null | undefined;
        const after = remap(before);
        fields.owner_id = after ?? null;
        ensureShadow(after ?? undefined, before ?? undefined);
      }
    }
    outOps.push({ ...op, fields: fields as Op['fields'] });
  }

  // ----- record ops ---------------------------------------------------------
  const outRecs: RecordOp[] = [];
  for (const rec of records ?? []) {
    const remapped = remapRecordOp(rec, allowed, remap, ensureShadow);
    if (!remapped) continue; // scope-rejected or a dropped entity (tag/item_tag)
    // Identity-forgery protection (the record-level analogue of the owner_id guard above):
    // a grantee peer is NOT authoritative for our users, so a share/assignee/comment/
    // attachment whose remapped identity resolves to an EXISTING local user who is not
    // already a participant on the item is a forged grant/authorship — drop the whole op.
    if (forgesLocalIdentity(db, remapped)) continue;
    // A forged @mention of a non-participant real local user is stripped in place (the rest
    // of the comment still lands). Shadows and already-participating users are kept.
    if (remapped.entity === 'comment') {
      const data = remapped.data as Record<string, unknown>;
      const itemId = data.item_id;
      if (Array.isArray(data.mentions) && typeof itemId === 'string') {
        data.mentions = (data.mentions as unknown[]).filter(
          (m) =>
            typeof m === 'string' &&
            !(refIsExistingLocalUser(db, m) && !isItemParticipant(db, itemId, m)),
        );
      }
    }
    // Only an accepted record advances OUR clock (see the op loop) — a scope- or
    // identity-rejected record must NOT push the local causal clock forward.
    if (remapped.ts > maxTs) maxTs = remapped.ts;
    outRecs.push(remapped);
  }

  // No ts clamp — but advance OUR clock past the batch (peer's causal ts may be huge).
  if (maxTs) observeTs(db, maxTs);
  return { ops: outOps, records: outRecs };
}

/**
 * Sanitize a peer's PUSHED `{ops, records}` and ingest them (idempotent). Ops first
 * so a share/comment pushed alongside a new item sees it. `triggerAgents` is NEVER
 * called (no cross-server LLM/credit/SSRF exposure).
 */
export function ingestFederatedPush(
  db: Db,
  deviceId: string,
  link: FederationLink,
  peerLabel: string,
  myLabel: string,
  ops: Op[],
  records: RecordOp[],
  users?: PulledUser[],
): void {
  const { ops: sOps, records: sRecs } = sanitizeFederatedPush(
    db,
    link,
    peerLabel,
    myLabel,
    deviceId,
    ops,
    records,
    users,
  );
  // Learn the peer-origin device ids of the ops/records that actually landed, so the
  // push builder excludes them from what we send back (peer-echo suppression by device).
  // Only NEW ops (ids we don't already have) count: an op that ORIGINATED on us and is
  // merely round-tripping back from the peer already exists here, so its (our-own)
  // device id must not be mislabeled peer-origin — that would strand our local edits.
  const devs = new Set<string>();
  for (const op of sOps) if (op.device_id && !rowExists(db, 'ops', op.id)) devs.add(op.device_id);
  for (const rec of sRecs) {
    if (rec.device_id && !rowExists(db, 'record_ops', rec.id)) devs.add(rec.device_id);
  }
  if (devs.size) rememberPeerDevices(db, link.id, devs);
  if (sOps.length) ingestOps(db, sOps, true);
  if (sRecs.length) ingestRecordOps(db, sRecs, true);
}

// ----- pull side: build the scoped payload a peer requests ------------------

/**
 * The scoped `{ops, records, users}` a peer may pull for its granted roots. Ops
 * whose item is in the subtree; share/assignee/comment/attachment records in the
 * subtree (tag/item_tag dropped); the PUBLIC projection of every user referenced as
 * owner/author/share/assignee, so the peer can name its shadows. Phase 2 sends the
 * full subtree (per-link incremental cursors are a later phase).
 */
export function buildPullPayload(db: Db, grantedRoots: string[]): PullPayload {
  const subtree = subtreeIds(db, grantedRoots);
  const ids = [...subtree];

  const ops: Op[] = [];
  const referencedUsers = new Set<string>();
  for (const r of db.all<{
    id: string;
    item_id: string;
    ts: number;
    device_id: string;
    fields: string;
  }>('SELECT id, item_id, ts, device_id, fields FROM ops ORDER BY rowid')) {
    if (!subtree.has(r.item_id)) continue;
    const fields = JSON.parse(r.fields) as Record<string, unknown>;
    if (typeof fields.owner_id === 'string') referencedUsers.add(fields.owner_id);
    ops.push({ id: r.id, item_id: r.item_id, ts: Number(r.ts), device_id: r.device_id, fields });
  }

  const records: RecordOp[] = [];
  for (const r of db.all<{
    id: string;
    entity: string;
    row_id: string;
    ts: number;
    device_id: string;
    data: string;
  }>('SELECT id, entity, row_id, ts, device_id, data FROM record_ops ORDER BY rowid')) {
    if (r.entity === 'tag' || r.entity === 'item_tag') continue; // dropped per decision
    if (
      r.entity !== 'share' &&
      r.entity !== 'assignee' &&
      r.entity !== 'comment' &&
      r.entity !== 'attachment'
    ) {
      continue;
    }
    const data = JSON.parse(r.data) as Record<string, unknown>;
    const itemId = data.item_id as string | undefined;
    if (!itemId || !subtree.has(itemId)) continue;
    if (typeof data.user_id === 'string') referencedUsers.add(data.user_id);
    if (typeof data.author_id === 'string') referencedUsers.add(data.author_id);
    if (Array.isArray(data.mentions)) {
      for (const m of data.mentions) if (typeof m === 'string') referencedUsers.add(m);
    }
    records.push({
      id: r.id,
      entity: r.entity,
      row_id: r.row_id,
      ts: Number(r.ts),
      device_id: r.device_id,
      data,
    });
  }
  void ids;

  const users: PulledUser[] = [];
  for (const uid of referencedUsers) {
    const u = getUser(db, uid);
    if (u) users.push({ id: u.id, username: u.username, display_name: u.display_name });
  }

  return { ops, records, users };
}

/** Whether a record entity is federated (share/assignee/comment/attachment). */
function isFederatedRecord(entity: string): boolean {
  return (
    entity === 'share' ||
    entity === 'assignee' ||
    entity === 'comment' ||
    entity === 'attachment'
  );
}

/** Public projection of every user referenced by the collected ops/records. */
function projectReferencedUsers(db: Db, referenced: Set<string>): PulledUser[] {
  const users: PulledUser[] = [];
  for (const uid of referenced) {
    const u = getUser(db, uid);
    if (u) users.push({ id: u.id, username: u.username, display_name: u.display_name });
  }
  return users;
}

export interface IncrementalPull {
  payload: PullPayload;
  /** New `ops` rowid high-water for the caller to store as its pull cursor. */
  since: number;
  /** New `record_ops` rowid high-water. */
  rsince: number;
}

/**
 * The INCREMENTAL analogue of `buildPullPayload`: only ops/records with `rowid >
 * since`/`rsince` whose item is in `subtreeIds(grantedRoots)`, plus the referenced-
 * user projection and the new high-water rowids. `need` (a move-in backfill request)
 * forces the FULL subtree for those roots regardless of cursor — idempotent, exactly
 * like the `/api/sync` backfill — so a newly-in-scope item predating the cursor is
 * still delivered. The scope is recomputed each call from CURRENT roots, so an item
 * moved OUT naturally stops being sent and one moved IN is picked up.
 */
export function buildIncrementalPullPayload(
  db: Db,
  grantedRoots: string[],
  since: number,
  rsince: number,
  need?: string[],
  excludeDevices?: Set<string>,
): IncrementalPull {
  const subtree = subtreeIds(db, grantedRoots);
  // When building a PUSH, `excludeDevices` holds the peer's own device ids (ops we
  // ingested FROM that peer): never push them back. The cursor still advances past
  // them (they were scanned) so it stays at the build-time high-water regardless.
  const excluded = (dev: string): boolean => !!excludeDevices && excludeDevices.has(dev);

  const ops: Op[] = [];
  const referenced = new Set<string>();
  let cursor = since;
  for (const r of db.all<{
    seq: number;
    id: string;
    item_id: string;
    ts: number;
    device_id: string;
    fields: string;
  }>('SELECT rowid AS seq, id, item_id, ts, device_id, fields FROM ops WHERE rowid > ? ORDER BY rowid', [
    since,
  ])) {
    cursor = r.seq;
    if (!subtree.has(r.item_id) || excluded(r.device_id)) continue;
    const fields = JSON.parse(r.fields) as Record<string, unknown>;
    if (typeof fields.owner_id === 'string') referenced.add(fields.owner_id);
    ops.push({ id: r.id, item_id: r.item_id, ts: Number(r.ts), device_id: r.device_id, fields });
  }

  const records: RecordOp[] = [];
  let rcursor = rsince;
  for (const r of db.all<{
    seq: number;
    id: string;
    entity: string;
    row_id: string;
    ts: number;
    device_id: string;
    data: string;
  }>(
    'SELECT rowid AS seq, id, entity, row_id, ts, device_id, data FROM record_ops WHERE rowid > ? ORDER BY rowid',
    [rsince],
  )) {
    rcursor = r.seq;
    if (!isFederatedRecord(r.entity) || excluded(r.device_id)) continue;
    const data = JSON.parse(r.data) as Record<string, unknown>;
    const itemId = data.item_id as string | undefined;
    if (!itemId || !subtree.has(itemId)) continue;
    if (typeof data.user_id === 'string') referenced.add(data.user_id);
    if (typeof data.author_id === 'string') referenced.add(data.author_id);
    if (Array.isArray(data.mentions)) {
      for (const m of data.mentions) if (typeof m === 'string') referenced.add(m);
    }
    records.push({
      id: r.id,
      entity: r.entity,
      row_id: r.row_id,
      ts: Number(r.ts),
      device_id: r.device_id,
      data,
    });
  }

  // Backfill: the caller reports roots it needs the full content for (a move-in it
  // synced past). Send the whole subtree for those roots regardless of the cursor.
  if (Array.isArray(need) && need.length) {
    const needRoots = need.filter((id) => typeof id === 'string' && subtree.has(id));
    const needSubtree = subtreeIds(db, needRoots);
    if (needSubtree.size) {
      const seenOps = new Set(ops.map((o) => o.id));
      for (const r of db.all<{
        id: string;
        item_id: string;
        ts: number;
        device_id: string;
        fields: string;
      }>('SELECT id, item_id, ts, device_id, fields FROM ops ORDER BY rowid')) {
        if (!needSubtree.has(r.item_id) || seenOps.has(r.id) || excluded(r.device_id)) continue;
        const fields = JSON.parse(r.fields) as Record<string, unknown>;
        if (typeof fields.owner_id === 'string') referenced.add(fields.owner_id);
        ops.push({
          id: r.id,
          item_id: r.item_id,
          ts: Number(r.ts),
          device_id: r.device_id,
          fields,
        });
      }
      const seenRecs = new Set(records.map((o) => o.id));
      for (const r of db.all<{
        id: string;
        entity: string;
        row_id: string;
        ts: number;
        device_id: string;
        data: string;
      }>('SELECT id, entity, row_id, ts, device_id, data FROM record_ops ORDER BY rowid')) {
        if (seenRecs.has(r.id) || !isFederatedRecord(r.entity) || excluded(r.device_id)) continue;
        const data = JSON.parse(r.data) as Record<string, unknown>;
        const itemId = data.item_id as string | undefined;
        if (!itemId || !needSubtree.has(itemId)) continue;
        if (typeof data.user_id === 'string') referenced.add(data.user_id);
        if (typeof data.author_id === 'string') referenced.add(data.author_id);
        if (Array.isArray(data.mentions)) {
          for (const m of data.mentions) if (typeof m === 'string') referenced.add(m);
        }
        records.push({
          id: r.id,
          entity: r.entity,
          row_id: r.row_id,
          ts: Number(r.ts),
          device_id: r.device_id,
          data,
        });
      }
    }
  }

  const users = projectReferencedUsers(db, referenced);
  return { payload: { ops, records, users }, since: cursor, rsince: rcursor };
}

// ============================================================================
// F.5 Phase 5 — blob fetch-from-peer for federated attachments
// ============================================================================
//
// Attachment METADATA rides the op-log (records); the BYTES do not — they live in the
// per-tenant content-addressed blob store and move out-of-band. When a grantee has the
// federated attachment row but not its bytes, it fetches them over the link from the
// owner, hash-verifies, and caches. The serve side scopes strictly to the link's shared
// subtree (a link may NOT fetch an arbitrary blob by hash — only one referenced by a
// live attachment on an item it can already see). One hop, same-host loopback (L2).

/**
 * Whether `hash` is referenced by a LIVE (non-deleted) attachment on some item within
 * `subtreeIds(roots)`. This is `canReadBlob`'s "referenced by a visible item" rule,
 * but scoped to a link's granted roots instead of a user's `visibleItemIds` — so a link
 * can only reach blobs inside the subtree it was actually granted. `item_id` is the
 * denormalized owning-item column (migration 4); it's present for every federated
 * attachment (they materialize via the record path which carries it).
 */
export function blobHashInScope(db: Db, roots: string[], hash: string): boolean {
  if (!roots.length) return false;
  const rows = db.all<{ item_id: string | null }>(
    'SELECT item_id FROM attachments WHERE hash = ? AND deleted = 0',
    [hash],
  );
  if (rows.length === 0) return false;
  const scope = subtreeIds(db, roots);
  for (const r of rows) {
    if (r.item_id && scope.has(r.item_id)) return true;
  }
  return false;
}

/**
 * Re-hash received bytes and store them under `hash` ONLY on an exact match — the same
 * hash-verify-on-store guarantee (A4) the `POST /api/blobs/:hash` upload path enforces,
 * reused here so a malicious/buggy peer can never poison content addressing: bytes whose
 * sha256 ≠ the requested hash are rejected (returns false, nothing cached). Idempotent:
 * an already-present hash is not rewritten.
 */
export function storeVerifiedBlob(store: BlobStore, hash: string, bytes: Buffer): boolean {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== hash) return false; // poison — reject, do not cache
  if (!store.has(hash)) store.store(hash, bytes);
  return true;
}

/**
 * Active INBOUND links (WE are the grantee; the peer OWNS the roots) whose granted
 * subtree contains a live attachment referencing `hash`. Only inbound links can supply
 * a federated blob — the bytes live on the peer that owns the item.
 */
function inboundLinksForHash(db: Db, hash: string): FederationLink[] {
  const out: FederationLink[] = [];
  for (const link of listLinks(db)) {
    if (link.status !== 'active' || link.direction !== 'inbound') continue;
    const roots = listLinkRoots(db, link.id).map((r) => r.root_item_id);
    if (blobHashInScope(db, roots, hash)) out.push(link);
  }
  return out;
}

/**
 * Fetch a federated attachment's bytes from a peer, verify, cache, and return them —
 * the grantee-side fallback for a blob present in metadata but absent locally.
 *
 *  - Finds each ACTIVE INBOUND link whose granted subtree references `hash` via a live
 *    attachment (so we only ever fetch blobs we're actually entitled to).
 *  - POSTs `{ __link_secret, hash }` to the peer's `POST /api/federation/blob` via the
 *    existing `deliverToPeer(base, path, body)` seam (the `Response` carries the bytes).
 *  - On a 200, reads the bytes and **hash-verifies** via `storeVerifiedBlob` (A4): a
 *    mismatch is rejected (null), nothing cached. On a verified match, caches locally and
 *    returns the bytes. Tries links until one yields a verified blob; returns null if none.
 */
export async function fetchFederatedBlob(
  db: Db,
  deliverToPeer: DeliverToPeer,
  store: BlobStore,
  hash: string,
): Promise<Buffer | null> {
  for (const link of inboundLinksForHash(db, hash)) {
    let res: Response;
    try {
      res = await deliverToPeer(link.peer_base_url, '/api/federation/blob', {
        __link_secret: link.secret,
        hash,
      });
    } catch {
      continue; // peer unreachable via this link — try the next
    }
    if (!res.ok) continue; // 404 (scope/absent) or auth failure — try the next
    const bytes = Buffer.from(await res.arrayBuffer());
    // Hash-verify before caching (A4): a peer that returns the wrong bytes is rejected.
    if (!storeVerifiedBlob(store, hash, bytes)) continue; // poison — try the next link
    return bytes;
  }
  return null;
}

// ----- routes ---------------------------------------------------------------

/**
 * Build the per-tenant federation routes, to be mounted under `/api/federation`.
 * Auth modes:
 *   POST /offers          — session-authed (human); rejects token auth
 *   POST /offers/inbound  — authed by the offer/link secret (NOT session/token)
 *   POST /sync            — authed by an ACTIVE link's `link_secret` (NOT session/token)
 */
export function federationRoutes(deps: FederationDeps): Hono<{ Variables: FedVars }> {
  const { db, serverDeviceId, myLabel } = deps;
  const app = new Hono<{ Variables: FedVars }>();

  // Register the offer notice handler once (module-level), and wire this tenant's
  // delivery capability so the handler can reach the issuer on accept.
  ensureFederationOfferHandler();
  bindOfferDelivery(db, deps.deliverToPeer, myLabel);

  // --- outbound: create + deliver an offer (session-authed human) ---
  app.post('/offers', deps.sessionAuth, async (c) => {
    if (c.get('authMethod') === 'token') return c.json({ error: 'forbidden' }, 403);
    const callerId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as {
      to?: string;
      root_item_id?: string;
      permission?: Permission;
    };
    const addr = body.to ? parseAddress(body.to) : null;
    if (!addr) return c.json({ error: 'bad_address' }, 400);
    if (!body.root_item_id) return c.json({ error: 'root_item_id required' }, 400);
    const permission: Permission = body.permission === 'write' ? 'write' : 'read';

    // The caller must actually be able to share this root (owner or write access;
    // `hasWriteAccess` already returns true for the owner).
    const root = getItem(db, body.root_item_id);
    if (!root || root.deleted) return c.json({ error: 'not found' }, 404);
    if (!hasWriteAccess(db, body.root_item_id, callerId)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const tier = tierForLabel(addr.label);
    const gate = canOffer({
      mode: deps.resolveMode(),
      policy: getFederationPolicy(db),
      tier,
      peerOnAllowlist: peerWhitelisted(db, addr.label),
      peerOnDenylist: peerDenied(db, addr.label),
    });
    if (!gate.ok) return c.json({ error: 'federation_denied', reason: gate.reason }, 403);

    // Mint the pending outbound link (its secret is the peer's future link_secret).
    const link = createLink(db, {
      peerBaseUrl: addr.label,
      peerLabel: addr.label,
      direction: 'outbound',
      status: 'pending',
    });
    addLinkRoot(db, link.id, body.root_item_id, permission);
    const offerSecret = randomBytes(24).toString('hex');
    // Record WHICH local user made the offer so a decline callback can target them.
    putOfferSecret(db, link.id, offerSecret, callerId);

    const fromUser = getUser(db, callerId);
    const rootLabel = root.title || 'a shared item';
    let res: Response;
    try {
      res = await deps.deliverToPeer(addr.label, '/api/federation/offers/inbound', {
        from: `${addr.user}`, // recipient-local addressee (the `user` part)
        from_address: `${fromUser?.username ?? callerId}@${myLabel}`,
        from_label: fromUser?.display_name || fromUser?.username || myLabel,
        root_label: rootLabel,
        permission,
        // The peer pulls from us and confirms back to us at this base + secret. For an
        // L2 same-host peer the bare `myLabel` resolves via loopback; for an L3 remote
        // peer we advertise our full externally-reachable base (`myBaseUrl`) so the
        // recipient can reach us back over HTTPS.
        callback_base_url: tier === 'cross_server' ? deps.myBaseUrl ?? myLabel : myLabel,
        link_secret: link.secret,
        offer_secret: offerSecret,
      });
    } catch (e) {
      setLinkStatus(db, link.id, 'revoked');
      return c.json({ error: 'delivery_failed', reason: (e as Error).message }, 502);
    }
    if (!res.ok) {
      setLinkStatus(db, link.id, 'revoked');
      const j = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      return c.json({ error: 'peer_rejected', peer_error: j.error, reason: j.reason }, 409);
    }
    return c.json({ link_id: link.id, status: 'pending', permission });
  });

  // --- offer-origin challenge: prove control of a claimed callback_base_url ---
  // The recipient of an offer calls THIS back on the claimed `callback_base_url` (with the
  // offer_secret) before trusting that origin for its deny-list / host-ceiling gates. We
  // answer affirmatively ONLY if WE genuinely minted an offer with this secret, so a caller
  // can pass the challenge for a host it actually controls — and can NEITHER spoof another
  // peer's label to dodge the deny list NOR point a recipient at a host it doesn't own. The
  // offer_secret is 24 bytes of CSPRNG hex, so a positive answer leaks nothing guessable.
  app.post('/offers/verify', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { offer_secret?: string };
    if (!body.offer_secret) return c.json({ error: 'unauthorized' }, 401);
    if (!findLinkByOfferSecret(db, body.offer_secret)) {
      return c.json({ error: 'unknown_offer' }, 404);
    }
    return c.json({ ok: true });
  });

  // --- inbound: receive an offer (authed by the offer/link secret) ---
  app.post('/offers/inbound', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      from?: string; // the recipient-local addressee (the `user` of the offer's `to`)
      from_address?: string;
      from_label?: string;
      root_label?: string;
      permission?: Permission;
      callback_base_url?: string;
      link_secret?: string;
      offer_secret?: string;
    };
    // Secret-authed (not session/token): the presence of link_secret + offer_secret is
    // the credential. Reject if absent.
    if (!body.link_secret || !body.offer_secret || !body.callback_base_url) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    // Derive the peer's label from the callback base (its own subdomain).
    const peerLabel = body.callback_base_url;
    // Origin verification (before ANY policy decision): `callback_base_url` is entirely
    // attacker-controllable yet is what `tierForLabel`/`peerWhitelisted`/`peerDenied` gate on
    // and what we later deliver secrets to. Challenge it — POST the offer_secret back to that
    // origin's /offers/verify — and require it to confirm it actually minted this offer. A
    // caller can only pass for a host it truly controls, so it cannot forge a benign label to
    // slip past the deny list. Unreachable / non-confirming ⇒ reject before trusting anything.
    let originVerified = false;
    try {
      const vr = await deps.deliverToPeer(peerLabel, '/api/federation/offers/verify', {
        offer_secret: body.offer_secret,
      });
      originVerified = vr.ok;
    } catch {
      originVerified = false;
    }
    if (!originVerified) return c.json({ error: 'unverified_origin' }, 403);

    const tier = tierForLabel(peerLabel);
    const gate = canAccept({
      mode: deps.resolveMode(),
      policy: getFederationPolicy(db),
      tier,
      peerOnAllowlist: peerWhitelisted(db, peerLabel),
      peerOnDenylist: peerDenied(db, peerLabel),
    });
    if (!gate.ok) return c.json({ error: 'federation_denied', reason: gate.reason }, 403);

    // Resolve the addressed local user (the `user` part of the offer's `to`). 404 if unknown.
    const addressedName = (body.from ?? '').trim();
    const addressed = addressedName ? getUserByUsernameLocal(db, addressedName) : undefined;
    if (!addressed) return c.json({ error: 'no_such_user' }, 404);

    const permission: Permission = body.permission === 'write' ? 'write' : 'read';
    // Mint the recipient-side pending inbound link, keyed by the peer's link_secret so
    // our future /sync pull authenticates and the roots resolve. The root id is the
    // PEER's item id — we'll materialize it under that id on ingest.
    const link = createLink(db, {
      peerBaseUrl: peerLabel,
      peerLabel,
      direction: 'inbound',
      secret: body.link_secret,
      status: 'pending',
    });
    // Root id is unknown to us until the pull; we stash the peer callback + offer_secret
    // + the addressed local user id in the cursor's need_json so the accept handler can
    // confirm (telling the issuer whom to share to) then pull.
    setCursor(db, link.id, {
      needJson: JSON.stringify({
        callback_base_url: peerLabel,
        offer_secret: body.offer_secret,
        link_secret: body.link_secret,
        addressee_id: addressed.id,
        permission,
      }),
    });

    const fromLabel = body.from_label || body.from_address || peerLabel;
    const rootLabel = body.root_label || 'a shared item';
    createSystemNotice(db, serverDeviceId, addressed.id, {
      kind: 'federation_offer',
      title: `${fromLabel} wants to share "${rootLabel}" with you`,
      body: `${fromLabel} is offering to share "${rootLabel}" (${permission}-only) with you over federation. Accept to receive a copy in your workspace.`,
      actions: {
        link_id: link.id,
        from: body.from_address ?? fromLabel,
        root_label: rootLabel,
        permission,
      },
    });
    return c.json({ ok: true }, 200);
  });

  // --- outbound confirm: the recipient activates our (issuer) side of the link ---
  // Authed by the per-offer `offer_secret` we minted and delivered (NOT session/token).
  // The recipient tells us WHOM it resolved the offer to (`addressee_id`, a local id in
  // the recipient's workspace); we record the grant as a share to that user's shadow
  // (`remote:<recipientLabel>:<addressee_id>`) on every granted root. When the recipient
  // pulls, `remapUserRef` un-maps that shadow back to its local user — the grant that
  // makes the subtree visible there. (We do NOT mint a separate local share.)
  app.post('/offers/confirm', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      offer_secret?: string;
      addressee_id?: string;
    };
    if (!body.offer_secret) return c.json({ error: 'unauthorized' }, 401);
    const linkId = findLinkByOfferSecret(db, body.offer_secret);
    if (!linkId) return c.json({ error: 'unauthorized' }, 401);
    setLinkStatus(db, linkId, 'active');
    const link = getLink(db, linkId);
    if (link && body.addressee_id) {
      const recipientLabel = link.peer_label ?? link.peer_base_url;
      const shadowRef = shadowUserId(recipientLabel, body.addressee_id);
      for (const r of listLinkRoots(db, linkId)) {
        // shareItem regenerates the deterministic join id (`s:<item>:<user>`) itself.
        shareItem(db, serverDeviceId, r.root_item_id, shadowRef, r.permission);
      }
    }
    return c.json({ ok: true });
  });

  // --- outbound declined: the recipient tore down our (issuer) pending link ---
  // Authed by the per-offer `offer_secret` we minted (same style as `/offers/confirm`).
  // On match we tombstone OUR pending link (+ its roots and any dangling grant shares),
  // drop an informational notice for the local user who made the offer, and delete the
  // offer-correlation row so the offer reaches a clean terminal state on our side too.
  app.post('/offers/declined', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      offer_secret?: string;
      recipient_label?: string;
    };
    if (!body.offer_secret) return c.json({ error: 'unauthorized' }, 401);
    const offer = findOfferBySecret(db, body.offer_secret);
    if (!offer) return c.json({ error: 'unauthorized' }, 401);
    const linkId = offer.link_id;
    const link = getLink(db, linkId);

    // Resolve the notice text BEFORE tombstoning (tombstone drops the roots we read).
    const recipientLabel = link?.peer_label ?? link?.peer_base_url ?? body.recipient_label ?? 'A peer';
    const roots = listLinkRoots(db, linkId);
    const firstRoot = roots[0] ? getItem(db, roots[0].root_item_id) : undefined;
    const rootLabel = firstRoot?.title || 'a shared item';

    tombstoneLink(db, serverDeviceId, linkId);

    // Inform the offerer (if we recorded who they were) — informational, no actions,
    // so the generic Dismiss resolves it (no dedicated handler needed).
    if (offer.offered_by) {
      createSystemNotice(db, serverDeviceId, offer.offered_by, {
        kind: 'federation_declined',
        title: `${recipientLabel} declined your share of "${rootLabel}"`,
        body: `${recipientLabel} declined the offer to share "${rootLabel}". No copy was created on their side; you can offer it again if you like.`,
        actions: null,
      });
    }
    deleteOfferRow(db, linkId);
    return c.json({ ok: true });
  });

  // --- link-authed full exchange (Phase 3: bidirectional push+pull) ---
  // The link secret arrives via header (the L3 shape) OR the loopback body (`__link_secret`),
  // since the narrow `deliverToPeer(base, path, body)` seam has no header channel. Both
  // resolve the SAME active-link check — NOT api_tokens, NOT session.
  const linkAuth: MiddlewareHandler<{ Variables: FedVars }> = async (c, next) => {
    let secret =
      c.req.header('x-federation-secret') ||
      (() => {
        const auth = c.req.header('authorization');
        return auth?.startsWith('Federation ') ? auth.slice('Federation '.length).trim() : undefined;
      })();
    if (!secret) {
      const body = (await c.req.json().catch(() => ({}))) as { __link_secret?: string };
      secret = body.__link_secret;
    }
    if (!secret) return c.json({ error: 'unauthorized' }, 401);
    const link = findActiveLinkBySecret(db, secret);
    if (!link) return c.json({ error: 'unauthorized' }, 401);
    // Deny always wins, even for an already-active link: a peer added to the deny list after
    // its link went active must be blocked on every inbound /sync + /blob request (the peer-
    // driven direction), not just on our own exchange loop. `findActiveLinkBySecret` only
    // checks status, so re-check the deny list here.
    if (peerDenied(db, link.peer_label ?? link.peer_base_url)) {
      return c.json({ error: 'federation_denied' }, 403);
    }
    c.set('fedLink', link);
    return next();
  };

  // Full exchange: apply the peer's PUSH first (write-gated + sanitized), then serve
  // the incremental PULL scoped to the peer's granted roots by its since/rsince cursors
  // (plus a `need` backfill), returning the new high-water rowids. Same route L3 hits.
  app.post('/sync', linkAuth, async (c) => {
    const link = c.get('fedLink')!;
    const peerLabel = link.peer_label ?? link.peer_base_url;
    const body = (await c.req.json().catch(() => ({}))) as {
      push_ops?: Op[];
      push_records?: RecordOp[];
      since?: number;
      rsince?: number;
      need?: string[];
      users?: PulledUser[];
      retract?: string[];
    };

    // ----- retract side: the peer authoritatively says these ids left the shared subtree.
    //       Honored ONLY on an INBOUND link — the peer is then the OWNER of the roots and
    //       we are the grantee, so dropping our materialized shadow copies is correct. On
    //       an OUTBOUND link the caller is a GRANTEE and this field is a grantee→owner
    //       signal we must ignore (a grantee can never make us drop owner data).
    if (link.direction === 'inbound' && Array.isArray(body.retract) && body.retract.length) {
      applyRetraction(db, link, body.retract);
    }

    // ----- push side: the peer's edits to us (write-gated, sanitized, no agents) ---
    if (Array.isArray(body.push_ops) || Array.isArray(body.push_records)) {
      ingestFederatedPush(
        db,
        serverDeviceId,
        link,
        peerLabel,
        myLabel,
        body.push_ops ?? [],
        body.push_records ?? [],
        body.users,
      );
    }

    // ----- pull side: our scoped content, incrementally by the caller's cursor ---
    const roots = listLinkRoots(db, link.id).map((r) => r.root_item_id);
    const { payload, since, rsince } = buildIncrementalPullPayload(
      db,
      roots,
      Number(body.since ?? 0),
      Number(body.rsince ?? 0),
      body.need,
    );
    return c.json({ ...payload, since, rsince });
  });

  // --- link-authed blob serve (Phase 5): raw bytes for a federated attachment ---
  // Serve the bytes ONLY if `hash` is referenced by a LIVE attachment on an item within
  // THIS link's granted subtree (`blobHashInScope` — the scoped analogue of canReadBlob's
  // "referenced by a visible item" rule). A link may NOT fetch an arbitrary blob by hash:
  // out-of-scope OR locally-absent both return 404, so the response never confirms a blob
  // exists outside the shared subtree (no exfiltration). POST + hash-in-body fits the
  // existing `deliverToPeer(base, path, body)` seam; the Response carries the binary body.
  app.post('/blob', linkAuth, async (c) => {
    const link = c.get('fedLink')!;
    const body = (await c.req.json().catch(() => ({}))) as { hash?: string };
    const hash = typeof body.hash === 'string' ? body.hash : '';
    if (!/^[a-f0-9]{64}$/.test(hash)) return c.json({ error: 'bad hash' }, 400);
    const roots = listLinkRoots(db, link.id).map((r) => r.root_item_id);
    if (!blobHashInScope(db, roots, hash)) return c.json({ error: 'not found' }, 404);
    const bytes = deps.blobStore.read(hash);
    if (!bytes) return c.json({ error: 'not found' }, 404); // absent locally too
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });

  return app;
}

// ----- Phase 4: thin REST config surface for the web Federation panel --------
//
// These are the read/admin endpoints the Settings → Federation UI drives. They are
// registered on the tenant's `api` app (so they inherit its global basicAuth) rather
// than the secret-authed federation sub-app: the `session`/`admin` middlewares below
// need the human session `api` establishes. Each is a THIN wrapper over the storage
// helpers above — no governance logic is duplicated (the gates live in the offer
// routes and their `canOffer`/`canAccept` callers).

/** A link projected for the UI: status, direction, peer label, and its granted roots
 *  with each root's local item title resolved where possible. */
export interface FederationLinkView {
  id: string;
  direction: FederationDirection;
  status: FederationStatus;
  peer_label: string;
  roots: { root_item_id: string; permission: Permission; title: string | null }[];
}

/** Project this workspace's links for the UI, labelling each granted root's item
 *  title when the item is resolvable locally (materialized). */
export function listLinkViews(db: Db): FederationLinkView[] {
  return listLinks(db).map((l) => ({
    id: l.id,
    direction: l.direction,
    status: l.status,
    peer_label: l.peer_label ?? l.peer_base_url,
    roots: listLinkRoots(db, l.id).map((r) => {
      const item = getItem(db, r.root_item_id);
      return {
        root_item_id: r.root_item_id,
        permission: r.permission,
        title: item && !item.deleted ? item.title || null : null,
      };
    }),
  }));
}

/** The public projection of a user, as returned by the roster (`publicUser`). Kept
 *  structural so this module needn't import the `auth` projection type. */
export interface PublicUserProjection {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  is_bot: boolean;
  avatar_color: string | null;
  avatar_initial: string | null;
  is_remote: boolean;
  home_server: string | null;
}

/**
 * In-process access to a same-host PEER tenant, used by the directory endpoint to
 * enforce the mutual-whitelist gate WITHOUT a network hop. Returned by the config
 * deps' `sameHostPeer(peerSubdomain)`; `null` when `peerSubdomain` is not a live
 * same-host tenant (a not-loaded/unknown/remote peer). Implemented at the top level
 * in index.ts via `registry.getCtx(peerSubdomain)?.db`.
 */
export interface SameHostPeer {
  /** Whether the peer's `federation_peers` whitelist contains US (matched on our
   *  base_url OR our subdomain label — the same shape `peerWhitelisted` uses). This
   *  is the peer→us half of the mutual-whitelist check. */
  hasWhitelisted(myBaseUrl: string, myLabel: string): boolean;
  /** The peer's roster as the public projection: non-deleted, non-bot, non-shadow
   *  (is_remote=false) users — humans only, capped by the caller. */
  roster(): PublicUserProjection[];
}

/** What the config-routes need beyond the tenant `api`'s own `db`/`serverDeviceId`. */
export interface FederationConfigDeps {
  db: Db;
  /** Resolve the effective host ceiling (Gate 1) for THIS workspace. */
  resolveMode: () => FederationMode;
  /** Session guard (rejects token auth) — the tenant's `requireSession`. */
  sessionAuth: MiddlewareHandler<{ Variables: AuthVars }>;
  /** Admin guard (human, role==='admin') — the tenant's `requireAdmin`. */
  adminAuth: MiddlewareHandler<{ Variables: AuthVars }>;
  /** Peer-delivery seam — supplied so revoking an outbound (owner) link can send a
   *  final retract-all to the grantee before the link is torn down. Optional: without
   *  it, revoke still tombstones the link locally (the grantee just stops receiving). */
  deliverToPeer?: DeliverToPeer;
  /** This workspace's own subdomain label (used to identify US when checking whether
   *  a peer has whitelisted us, and to build `<user>@<peer>` addressable forms). Only
   *  needed for discovery; unset ⇒ discovery routes report nothing available. */
  myLabel?: string;
  /** This workspace's own externally-reachable base (its full host under BASE_DOMAIN),
   *  the other identity a peer may store for us on its whitelist. Unset ⇒ same-host
   *  only, where the bare `myLabel` is our identity. */
  myBaseUrl?: string;
  /** In-process access to a same-host PEER tenant (its whitelist + roster), for the
   *  directory endpoint's mutual-whitelist gate. Returns null for a peer that is not a
   *  live same-host tenant. Optional: without it, same-host discovery is unavailable. */
  sameHostPeer?: (peerSubdomain: string) => SameHostPeer | null;
}

/**
 * Register the Phase-4 REST config endpoints on the tenant's `api` app. Mounted under
 * `/api/federation/*` (the offer/inbound/sync sub-app owns the secret-authed routes;
 * these are the session/admin-authed convenience surface for the web panel):
 *
 *   GET    /federation/config            — session: policy, ceiling, allow+deny lists, canOffer
 *   PATCH  /federation/policy            — admin:  set the workspace policy (Gate 2)
 *   POST   /federation/peers             — admin:  add an allow- or deny-list peer (list_type)
 *   DELETE /federation/peers/:id         — admin:  remove an allow- or deny-list peer
 *   GET    /federation/links             — session: this workspace's links + granted roots
 *   POST   /federation/links/:id/revoke  — admin:  revoke (stop) a link
 *   GET    /federation/directory?peer=   — session: a mutually-whitelisted same-host
 *                                          peer's user roster (recipient discovery)
 *   GET    /federation/peer-status?peer= — session: { mutual, sameHost } for the web
 *                                          layer to gate the in-dialog share affordance
 */
export function registerFederationConfigRoutes(
  api: Hono<{ Variables: AuthVars }>,
  deps: FederationConfigDeps,
): void {
  const { db } = deps;

  // GET /config — everything the UI needs to know what's allowed (session-only).
  api.get('/federation/config', deps.sessionAuth, (c) => {
    const mode = deps.resolveMode();
    const policy = getFederationPolicy(db);
    // Cross-server offers are only possible when the ceiling permits L3 AND the
    // workspace policy isn't `workspace_only`. Intra-server capability is implied by
    // any non-off ceiling + non-workspace_only policy; the UI uses `ceiling` for the
    // plain-language line and `canOfferCrossServer` to gate a dotted (L3) address.
    const canOfferCrossServer =
      hostCeilingAllows(mode, 'cross_server') && policy !== 'workspace_only';
    return c.json({
      policy,
      ceiling: mode,
      // Two admin-managed lists: `allow` gates who users may reach under
      // `admin_whitelist`; `deny` always blocks, under BOTH policies.
      allow: listPeers(db, 'allow'),
      deny: listPeers(db, 'deny'),
      canOfferCrossServer,
    });
  });

  // PATCH /policy — admin sets Gate 2.
  api.patch('/federation/policy', deps.adminAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { policy?: string };
    const policy = body.policy;
    if (!policy || !(FEDERATION_POLICIES as readonly string[]).includes(policy)) {
      return c.json({ error: 'bad_policy' }, 400);
    }
    setFederationPolicy(db, policy as FederationPolicy);
    return c.json({ policy });
  });

  // POST /peers — admin adds an allow- OR deny-list peer (`list_type`, default allow).
  api.post('/federation/peers', deps.adminAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      base_url?: string;
      subdomain?: string;
      label?: string;
      list_type?: string;
    };
    const baseUrl = (body.base_url ?? '').trim();
    if (!baseUrl) return c.json({ error: 'base_url required' }, 400);
    const listType: PeerListType = body.list_type === 'deny' ? 'deny' : 'allow';
    const peer = addPeer(db, {
      baseUrl,
      subdomain: body.subdomain?.trim() || null,
      label: body.label?.trim() || null,
      approvedBy: c.get('userId'),
      listType,
    });
    return c.json({ peer });
  });

  // DELETE /peers/:id — admin removes an allow- or deny-list peer (idempotent tombstone).
  api.delete('/federation/peers/:id', deps.adminAuth, (c) => {
    removePeer(db, c.req.param('id'));
    return c.json({ ok: true });
  });

  // GET /links — this workspace's links, with granted-root titles (session-only).
  api.get('/federation/links', deps.sessionAuth, (c) => {
    return c.json({ links: listLinkViews(db) });
  });

  // Cap on the roster a directory lookup returns (humans only). Defensive: a peer
  // with a huge user table can't turn a discovery request into an unbounded payload.
  const DIRECTORY_ROSTER_CAP = 500;

  /** Whether `peer` (a subdomain label) is on THIS workspace's live whitelist — the
   *  us→peer half of mutuality. Reuses the same match shape as `peerWhitelisted`. */
  const iWhitelist = (peer: string): boolean => peerWhitelisted(db, peer);

  /** The peer→us half of mutuality: does the same-host `peer` have one of OUR identities
   *  on its whitelist? False when we lack an identity to match on (`myLabel` unset). */
  const peerWhitelistsMe = (sh: SameHostPeer): boolean => {
    if (!deps.myLabel) return false;
    return sh.hasWhitelisted(deps.myBaseUrl ?? deps.myLabel, deps.myLabel);
  };

  /** Resolve the mutual/same-host status of a `peer` for the two discovery routes. A
   *  bare same-host subdomain that resolves to a live tenant is `sameHost`; `mutual`
   *  additionally requires the peer to be on my whitelist AND me on the peer's. A
   *  dotted/remote label is never same-host here (L3 discovery is a separate design). */
  function resolvePeerStatus(peer: string): { sameHost: boolean; mutual: boolean } {
    if (tierForLabel(peer) === 'cross_server') return { sameHost: false, mutual: false };
    const sh = deps.sameHostPeer?.(peer);
    if (!sh) return { sameHost: false, mutual: false };
    // Deny wins over mutual whitelist: a denied peer is never mutual (not discoverable).
    if (peerDenied(db, peer)) return { sameHost: true, mutual: false };
    return { sameHost: true, mutual: iWhitelist(peer) && peerWhitelistsMe(sh) };
  }

  // GET /directory?peer=<subdomain> — a mutually-whitelisted same-host peer's roster,
  // for picking a federated share recipient (session-only; token rejected). ALL of
  // these must hold or we return a uniform 403 (never leaking whether the peer exists),
  // EXCEPT a dotted/remote peer, which gets an explicit cross-server-unavailable error:
  //   1. host ceiling allows intra_server (i.e. not `off`);
  //   2. MY workspace policy is not `workspace_only`;
  //   3. `peer` resolves to a live same-host tenant (else 403 / cross-server error);
  //   4. mutual whitelist: peer on my list AND I am on the peer's list.
  api.get('/federation/directory', deps.sessionAuth, (c) => {
    const peer = (c.req.query('peer') ?? '').trim();
    if (!peer) return c.json({ error: 'peer required' }, 400);

    // Gate 1 — host ceiling must permit intra-server. Uniform 403 (no peer leak).
    if (!hostCeilingAllows(deps.resolveMode(), 'intra_server')) {
      return c.json({ error: 'forbidden', reason: 'host ceiling blocks intra-server' }, 403);
    }
    // Gate 2 — a workspace_only workspace does no federation, so no discovery.
    if (getFederationPolicy(db) === 'workspace_only') {
      return c.json({ error: 'forbidden', reason: "workspace policy is 'workspace_only'" }, 403);
    }
    // A dotted/remote peer: cross-server (L3) discovery is a separate design. Return an
    // explicit not-available error (NOT a roster, NOT a peer-existence-leaking 403).
    if (tierForLabel(peer) === 'cross_server') {
      return c.json({ error: 'cross_server_discovery_unavailable' }, 501);
    }
    // Deny wins: a denied peer is never discoverable. Collapses to the SAME uniform
    // 403 (never leaks that the peer exists), even if we mutually whitelisted it.
    if (peerDenied(db, peer)) {
      return c.json({ error: 'forbidden', reason: 'not available' }, 403);
    }
    // Gate 3 — peer must be a live same-host tenant. Gate 4 — mutual whitelist. Both
    // collapse to the SAME uniform 403 so an unauthorized caller can't distinguish "no
    // such peer" from "not mutually whitelisted".
    const sh = deps.sameHostPeer?.(peer);
    if (!sh) return c.json({ error: 'forbidden', reason: 'not available' }, 403);
    if (!(iWhitelist(peer) && peerWhitelistsMe(sh))) {
      return c.json({ error: 'forbidden', reason: 'not available' }, 403);
    }

    // Success — the peer's humans (roster() already excludes bots + shadows), capped and
    // projected to the minimal share-picker shape plus the addressable `<user>@<peer>`.
    const users = sh
      .roster()
      .slice(0, DIRECTORY_ROSTER_CAP)
      .map((u) => ({
        id: u.id,
        username: u.username,
        display_name: u.display_name,
        avatar_color: u.avatar_color,
        address: `${u.username}@${peer}`,
      }));
    return c.json({ users });
  });

  // GET /peer-status?peer=<subdomain> — { mutual, sameHost } WITHOUT exposing the
  // roster, so the web layer can decide whether to enable the in-dialog share
  // affordance. Session-only; returns booleans regardless of the peer (no roster leak),
  // but still requires the host ceiling / policy to permit intra-server discovery at
  // all (else mutual is reported false — the affordance stays off).
  api.get('/federation/peer-status', deps.sessionAuth, (c) => {
    const peer = (c.req.query('peer') ?? '').trim();
    if (!peer) return c.json({ error: 'peer required' }, 400);
    const ceilingOk = hostCeilingAllows(deps.resolveMode(), 'intra_server');
    const policyOk = getFederationPolicy(db) !== 'workspace_only';
    const { sameHost, mutual } = resolvePeerStatus(peer);
    return c.json({ sameHost, mutual: mutual && ceilingOk && policyOk });
  });

  // POST /links/:id/revoke — admin revokes a link (stops the exchange loop; an
  // already-revoked/inactive link is skipped by `runFederationExchange`). For an ACTIVE
  // OUTBOUND (owner) link we first best-effort retract ALL its granted roots to the
  // grantee — over the link's still-active /sync auth — so the grantee drops the whole
  // shared subtree instead of orphaning its last-synced copy; THEN we tombstone locally.
  api.post('/federation/links/:id/revoke', deps.adminAuth, async (c) => {
    const id = c.req.param('id');
    const link = getLink(db, id);
    if (!link) return c.json({ error: 'not found' }, 404);
    if (deps.deliverToPeer && link.status === 'active' && link.direction === 'outbound') {
      await retractAllRoots(db, link, deps.deliverToPeer);
    }
    setLinkStatus(db, id, 'revoked');
    return c.json({ ok: true, status: 'revoked' });
  });
}

/** Constant-time active-link lookup by secret. Guards length first (a length
 *  mismatch short-circuits to a per-link dummy compare of equal length so the scan
 *  itself is not a length oracle), then `crypto.timingSafeEqual` on equal-length
 *  buffers. Keeps the active-link filter. */
export function findActiveLinkBySecret(db: Db, secret: string): FederationLink | undefined {
  const provided = Buffer.from(secret);
  for (const l of listLinks(db)) {
    if (l.status !== 'active') continue;
    const stored = Buffer.from(l.secret);
    if (stored.length !== provided.length) {
      // Length differs ⇒ not a match; still burn a compare of equal length so we
      // don't branch on secret length before doing constant-time work.
      timingSafeEqual(stored, stored);
      continue;
    }
    if (timingSafeEqual(stored, provided)) return l;
  }
  return undefined;
}

/** Local username lookup that avoids importing the core symbol name-collision. */
function getUserByUsernameLocal(db: Db, username: string): User | undefined {
  const r = db.get<{ id: string }>('SELECT id FROM users WHERE username = ? AND deleted = 0', [
    username,
  ]);
  return r ? getUser(db, r.id) : undefined;
}

// ============================================================================
// G. The `federation_offer` notice handler (Gate 3 — accept/decline)
// ============================================================================
//
// Registered via `registerNoticeHandler` (the Phase-0 seam). On accept it activates
// the recipient-side link, pulls the issuer's scoped subtree, ingests it (identity
// remap), and confirms back to the issuer. On decline it tombstones the pending link.
//
// The handler needs a `deliverToPeer` + `myLabel` to reach the issuer; those are
// per-tenant, so we register a resolver the notice dispatch can look up. The dispatch
// passes only (db, notice, action), so we stash the delivery capability keyed by db.

const OFFER_DELIVERY = new WeakMap<Db, { deliverToPeer: DeliverToPeer; myLabel: string }>();

/** Wire the per-tenant delivery capability the `federation_offer` handler needs.
 *  Called from `federationRoutes` at app-build time. */
export function bindOfferDelivery(db: Db, deliverToPeer: DeliverToPeer, myLabel: string): void {
  OFFER_DELIVERY.set(db, { deliverToPeer, myLabel });
}

let offerHandlerRegistered = false;

/** Register the `federation_offer` notice handler exactly once (module-level so it
 *  is present whenever a notice is acted on). Idempotent. */
export function ensureFederationOfferHandler(): void {
  if (offerHandlerRegistered) return;
  offerHandlerRegistered = true;
  registerNoticeHandler('federation_offer', federationOfferHandler);
}

function parsePayload(notice: SystemNotice): {
  link_id?: string;
  from?: string;
  root_label?: string;
  permission?: Permission;
} {
  try {
    const parsed = JSON.parse(notice.payload_json ?? '{}') as { actions?: unknown };
    return (parsed.actions as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

async function federationOfferHandler(
  db: Db,
  notice: SystemNotice,
  action: string,
): Promise<{ state?: NoticeState } | void> {
  const actions = parsePayload(notice);
  const linkId = actions.link_id;
  if (!linkId) return; // malformed; fall back to default mapping

  const link = getLink(db, linkId);
  if (!link) return;

  // Read the stashed issuer callback + secrets (used by both branches).
  const cur = getCursor(db, linkId);
  let stash: { callback_base_url?: string; offer_secret?: string; link_secret?: string } = {};
  try {
    stash = JSON.parse(cur?.need_json ?? '{}');
  } catch {
    /* empty */
  }

  const delivery = OFFER_DELIVERY.get(db);

  if (action !== 'accept') {
    // Decline (or dismiss): tombstone the recipient's pending inbound link and drop
    // any dangling roots/shares, THEN best-effort tell the issuer so its side stops
    // dangling. The local tombstone is authoritative — an unreachable issuer must not
    // throw out of the decline (it re-declines idempotently on the next attempt).
    tombstoneLink(db, ensureDeviceId(db), linkId);
    if (delivery && stash.callback_base_url && stash.offer_secret) {
      try {
        await delivery.deliverToPeer(stash.callback_base_url, '/api/federation/offers/declined', {
          offer_secret: stash.offer_secret,
          // The issuer resolves the recipient label from its own link; we still pass
          // ours so a same-host loopback and an L3 host agree on what to display.
          recipient_label: delivery.myLabel,
        });
      } catch {
        /* best-effort: the local tombstone stands even if the issuer is unreachable */
      }
    }
    return { state: 'declined' };
  }

  // Accept.

  // Activate the recipient-side link so its (about-to-be-set) roots authorize sync.
  setLinkStatus(db, linkId, 'active');

  if (delivery && stash.callback_base_url && stash.link_secret) {
    // Initial pull + confirm, awaited so the subtree is materialized before we return.
    await runInitialPull(db, delivery, linkId, stash);
  }

  return { state: 'accepted' };
}

/**
 * The async initial pull + confirm, split out so the (necessarily-async) loopback
 * can be awaited by the accept path. Pulls the issuer's scoped subtree, records the
 * granted root, ingests with identity remap, then confirms back to the issuer.
 */
export async function runInitialPull(
  db: Db,
  delivery: { deliverToPeer: DeliverToPeer; myLabel: string },
  linkId: string,
  stash: {
    callback_base_url?: string;
    offer_secret?: string;
    link_secret?: string;
    addressee_id?: string;
    permission?: Permission;
  },
): Promise<void> {
  const link = getLink(db, linkId);
  if (!link) return;
  const peerLabel = link.peer_label ?? stash.callback_base_url!;
  const grantedPermission: Permission = stash.permission === 'write' ? 'write' : 'read';

  // 1. Confirm back to the issuer FIRST so it activates its side, records the grant
  //    (a share to a shadow of us — `addressee_id`), and can serve /sync.
  if (stash.offer_secret) {
    await delivery
      .deliverToPeer(stash.callback_base_url!, '/api/federation/offers/confirm', {
        offer_secret: stash.offer_secret,
        addressee_id: stash.addressee_id,
      })
      .catch(() => undefined);
  }

  // 2. Pull the scoped subtree from the issuer.
  const res = await delivery.deliverToPeer(stash.callback_base_url!, '/api/federation/sync', {
    __link_secret: stash.link_secret,
  });
  if (!res.ok) return;
  const payload = (await res.json().catch(() => null)) as PullPayload | null;
  if (!payload) return;

  // The granted root(s) are the top-level item ops in the payload (Phase 2: a single
  // root). Record them so `visibleItemIds`/scope resolve; then ingest. The permission
  // from the offer is recorded so a WRITE grant lets our future pushes back be accepted
  // and (symmetrically) an inbound push from the issuer be write-gated here.
  const rootIds = inferRoots(payload);
  const deviceId = ensureDeviceId(db);
  for (const rootId of rootIds) addLinkRoot(db, linkId, rootId, grantedPermission);

  ingestFederatedPull(db, deviceId, rootIds, peerLabel, delivery.myLabel, payload, linkId);

  // The offer stash lived in `need_json` during pending→accept; now that the roots are
  // recorded and the subtree materialized, free the cursor field for real cursor use.
  setCursor(db, linkId, { needJson: null });
}

// ============================================================================
// H. Phase 3 — the bidirectional per-link exchange loop
// ============================================================================
//
// One round for one active link: push OUR in-scope-since-last-push ops to the peer's
// /api/federation/sync (write-gated on the peer), then ingest the peer's authoritative
// scoped PULL response and advance cursors. Directly callable from tests.
//
// Cursors (all rowids in OUR db):
//   push_since/push_rsince — OUR ops/record_ops already delivered to the peer.
//   since/rsince           — the peer's ops/record_ops high-water we've already pulled
//                            (sent to the peer so it returns only newer rows).
// `need_json` (free after the initial pull) caches the pushed-scope snapshot so a
// move-IN of a pre-cursor item is detected and backfilled via the peer's `need` path.

/** Read the cached pushed-scope snapshot from the cursor's `need_json`. */
function getPushedScope(db: Db, linkId: string): Set<string> {
  const cur = getCursor(db, linkId);
  try {
    const parsed = JSON.parse(cur?.need_json ?? '[]');
    if (Array.isArray(parsed)) return new Set(parsed as string[]);
  } catch {
    /* stale offer stash or empty — treat as no known scope */
  }
  return new Set();
}

/**
 * Grantee-side drop of retracted items — the owner authoritatively says these ids have
 * left the shared subtree (owner moved them out, a root changed, or the link was
 * revoked), so the grantee's materialized shadow copies are HARD-deleted (they are
 * federated shadow-owned copies belonging to this share; nothing local ever depends on
 * them). For each retracted id we take `subtreeIds(db, [id])` — the id AND every
 * descendant materialized under it (so a retracted subtree drops whole) — and remove the
 * `items` row plus every row keyed on it: `ops`, `record_ops` (whose `data.item_id`
 * matches), `shares`, `assignees`, `comments`, and `attachments`.
 *
 * A hard delete (not a `deleted=1` tombstone) is used deliberately: `subtreeIds` — hence
 * `visibleItemIds` — does NOT filter tombstoned rows, so only physically removing the
 * item rows takes the copy out of the grantee's view. This mirrors `ingestFederatedPull`'s
 * defense-in-depth `DELETE FROM ops/items` for strays.
 *
 * Idempotent: an already-dropped id (its subtree empty locally) is a harmless no-op, so a
 * re-sent retraction costs nothing. The caller MUST enforce the direction guard — only an
 * INBOUND link (the peer is the authoritative owner) may drive this; a grantee→owner
 * signal must never reach here.
 *
 * SCOPED to the calling link's granted roots: `itemIds` is raw, attacker-controlled JSON
 * from the peer, so every id (and every descendant it would drag out) is intersected with
 * `subtreeIds(db, <this link's granted roots>)` before ANYTHING is deleted. A peer may only
 * retract inside what it was granted — an id outside the grant is silently ignored, never
 * deleted. This mirrors the scope gate every other ingestion path already applies
 * (`ingestFederatedPull`/`sanitizeFederatedPush` both intersect against the granted subtree).
 */
export function applyRetraction(db: Db, link: FederationLink, itemIds: string[]): void {
  // The scope ceiling: the subtree of THIS link's granted roots as they exist locally. Any
  // id outside this set is out of the peer's grant and must never be touched.
  const roots = listLinkRoots(db, link.id).map((r) => r.root_item_id);
  if (!roots.length) return; // no grant materialized ⇒ nothing this link may retract
  const allowed = subtreeIds(db, roots);

  // Collect the in-scope ids to drop: each retracted id (if in scope) plus every descendant
  // still materialized under it, intersected with `allowed` so a peer can never step outside
  // its granted subtree even via a descendant. Computed BEFORE any delete so a subtree drops
  // whole even as rows are torn out.
  const toDrop = new Set<string>();
  for (const rootId of itemIds) {
    if (typeof rootId !== 'string' || !rootId) continue;
    if (!allowed.has(rootId)) continue; // out-of-scope retract — refuse
    for (const id of subtreeIds(db, [rootId])) {
      if (allowed.has(id)) toDrop.add(id);
    }
  }

  for (const id of toDrop) {
    // record_ops carry the owning item only in their JSON `data.item_id`; match it via the
    // indexed `json_extract` expression (idx_record_ops_item_id) instead of scanning the
    // whole table and JSON-parsing every row per id.
    db.run("DELETE FROM record_ops WHERE json_extract(data, '$.item_id') = ?", [id]);
    db.run('DELETE FROM ops WHERE item_id = ?', [id]);
    // Dependency edges are keyed on the item at EITHER end — a retracted item can sit on the
    // predecessor OR successor side, so drop both (previously leaked as dangling edges).
    db.run('DELETE FROM item_deps WHERE pred_id = ? OR succ_id = ?', [id, id]);
    db.run('DELETE FROM shares WHERE item_id = ?', [id]);
    db.run('DELETE FROM assignees WHERE item_id = ?', [id]);
    db.run('DELETE FROM attachments WHERE item_id = ?', [id]);
    db.run('DELETE FROM comments WHERE item_id = ?', [id]);
    db.run('DELETE FROM items WHERE id = ?', [id]);
  }
}

/**
 * Run ONE bidirectional exchange round for one ACTIVE link. PUSHES our in-scope
 * ops/records (past the push cursor) to the peer, then ingests the peer's scoped pull
 * response and advances all cursors. Idempotent and echo-safe: with no new edits on
 * either side a second call transfers nothing and leaves cursors stable. Directly
 * callable from tests (not buried in a timer).
 *
 * Trust of the pull response is DIRECTIONAL:
 *  - **inbound** link (WE are the grantee; the peer OWNS the roots) → the response is
 *    the peer's authoritative content ⇒ `ingestFederatedPull` (trusted materialization).
 *  - **outbound** link (WE own the roots; the peer is the grantee) → the response is the
 *    grantee's EDITS ⇒ `sanitizeFederatedPush` (write-gated by our root permission, and
 *    owner-protected). A read-only grant thus never lets the grantee's edits land on us,
 *    via EITHER the peer's push to us OR our pull of the peer.
 */
export async function runFederationExchange(
  db: Db,
  link: FederationLink,
  deliverToPeer: DeliverToPeer,
  myLabel: string,
): Promise<void> {
  if (link.status !== 'active') return;
  const peerLabel = link.peer_label ?? link.peer_base_url;
  // Deny always wins, even for an already-active link: `peerDenied` was only ever checked at
  // offer time, so a peer added to the deny list AFTER its link went active kept syncing. Re-
  // check every exchange round so the deny list actually cuts an existing channel — matching
  // the UI's "deny-listed peers are ALWAYS blocked" promise.
  if (peerDenied(db, peerLabel)) return;
  const deviceId = ensureDeviceId(db);
  const roots = listLinkRoots(db, link.id).map((r) => r.root_item_id);
  if (!roots.length) return; // grant not yet materialized (pre-initial-pull)

  const cur = getCursor(db, link.id);
  const pushSince = Number(cur?.push_since ?? 0);
  const pushRsince = Number(cur?.push_rsince ?? 0);
  const pullSince = Number(cur?.since ?? 0);
  const pullRsince = Number(cur?.rsince ?? 0);

  // ----- move-IN detection (both edges): if our in-scope membership GREW vs the cached
  //       snapshot, a pre-cursor item was reparented into scope. Its defining ops predate
  //       our cursor, so (a) we backfill it to the peer via our push `need`, and (b) we
  //       ask the peer to backfill via the pull `need` (in case the move happened THERE).
  //       Backfill is idempotent, so being liberal on the rare scope-change round is safe.
  const scope = subtreeIds(db, roots);
  const known = getPushedScope(db, link.id);
  let scopeGrew = false;
  for (const id of scope) {
    if (!known.has(id)) {
      scopeGrew = true;
      break;
    }
  }

  // ----- move-OUT detection (owner edge only): the authoritative retraction. On an
  //       OUTBOUND link WE own the granted roots, so an id that WAS in the last-synced
  //       scope (`known`) but is no longer under the current subtree left the share (we
  //       reparented it out, or a root changed). Those ids are delivered to the grantee
  //       as `retract` in our push body; the grantee drops its shadow copies. Computed
  //       ONLY for the owner: an inbound link never originates retraction (the owner
  //       stays authoritative; a grantee's local move-out is governed by LWW instead).
  const retract: string[] =
    link.direction === 'outbound' ? [...known].filter((id) => !scope.has(id)) : [];

  // ----- gather OUR push payload: in-scope ops/records with rowid past the push cursor
  //       (plus the full subtree for the roots when scope grew — a local move-in).
  //       Peer-origin ops (ingested FROM this peer, carrying its device ids) are excluded
  //       so we never echo them back; that lets the push cursor advance to the build-time
  //       high-water without re-sending them, while a concurrent local edit below that
  //       high-water is caught next round.
  const peerDevices = getPeerDevices(db, link.id);
  const push = buildIncrementalPullPayload(
    db,
    roots,
    pushSince,
    pushRsince,
    scopeGrew ? roots : undefined,
    peerDevices,
  );

  // ----- POST push + our pull cursors to the peer; get its scoped pull response.
  let res: Response;
  try {
    res = await deliverToPeer(link.peer_base_url, '/api/federation/sync', {
      __link_secret: link.secret,
      push_ops: push.payload.ops,
      push_records: push.payload.records,
      users: push.payload.users,
      since: pullSince,
      rsince: pullRsince,
      need: scopeGrew ? roots : undefined,
      // Owner→grantee retraction: ids that left our shared subtree since last sync. Only
      // ever non-empty on an outbound (owner) link; the grantee honors it only inbound.
      retract: retract.length ? retract : undefined,
    });
  } catch {
    return; // peer unreachable this round; cursors unchanged, retried next tick
  }
  if (!res.ok) return;
  const body = (await res.json().catch(() => null)) as
    | (PullPayload & { since?: number; rsince?: number })
    | null;
  if (!body) return;

  // ----- ingest the peer's scoped content. Trust depends on link direction (above):
  //       grantee (inbound) trusts the owner; owner (outbound) write-gates the grantee.
  if (link.direction === 'inbound') {
    ingestFederatedPull(
      db,
      deviceId,
      roots,
      peerLabel,
      myLabel,
      {
        ops: body.ops ?? [],
        records: body.records ?? [],
        users: body.users ?? [],
      },
      link.id,
    );
  } else {
    ingestFederatedPush(
      db,
      deviceId,
      link,
      peerLabel,
      myLabel,
      body.ops ?? [],
      body.records ?? [],
      body.users ?? [],
    );
  }

  // ----- advance the PUSH cursor to the BUILD-TIME high-water (`push.since`/`push.rsince`),
  //       NOT past the freshly-appended peer-op rowids. Ingesting the peer's ops appended
  //       them to our log ABOVE any local edit committed during the `deliverToPeer` await;
  //       jumping the cursor to those peer rowids would strand that concurrent local edit
  //       (its rowid sits below them and would never be `rowid > push_since` again). Peer-
  //       origin ops are instead kept out of the push by DEVICE exclusion (see the build
  //       above), so the cursor is stable AND the concurrent local edit is caught next round.
  setCursor(db, link.id, {
    pushSince: String(push.since),
    pushRsince: String(push.rsince),
    since: body.since != null ? String(body.since) : cur?.since ?? null,
    rsince: body.rsince != null ? String(body.rsince) : cur?.rsince ?? null,
    needJson: JSON.stringify([...scope]),
  });
}

/**
 * Owner-side revoke-retract-all: before an OUTBOUND (owner) link is torn down, deliver a
 * final retraction of ALL its granted roots to the grantee so it drops the whole shared
 * subtree (no orphaned last-synced copy left behind). Best-effort and idempotent — an
 * unreachable grantee (or a non-outbound/inactive link) simply no-ops and the local
 * revoke still stands. Sends the retraction over the SAME authoritative owner→grantee
 * push path the exchange uses (the grantee's `/sync` honors `retract` only inbound).
 */
export async function retractAllRoots(
  db: Db,
  link: FederationLink,
  deliverToPeer: DeliverToPeer,
): Promise<void> {
  if (link.direction !== 'outbound') return; // only the owner may retract
  const roots = listLinkRoots(db, link.id).map((r) => r.root_item_id);
  if (!roots.length) return;
  try {
    await deliverToPeer(link.peer_base_url, '/api/federation/sync', {
      __link_secret: link.secret,
      retract: roots,
    });
  } catch {
    /* best-effort: an unreachable grantee must not block the local revoke */
  }
}

/**
 * Run one exchange round for EVERY active link across the provided tenant DBs. Wired
 * onto the existing periodic sweep tick (piggybacking the reminder sweep) rather than a
 * competing timer. Errors on one link/tenant don't abort the rest.
 */
export async function runAllFederationExchanges(
  ctxs: () => { db: Db; myLabel: string }[],
  deliverToPeer: DeliverToPeer,
): Promise<void> {
  for (const { db, myLabel } of ctxs()) {
    let links: FederationLink[];
    try {
      links = listLinks(db).filter((l) => l.status === 'active');
    } catch {
      continue; // table absent (non-federation tenant) — skip
    }
    for (const link of links) {
      try {
        await runFederationExchange(db, link, deliverToPeer, myLabel);
      } catch (e) {
        console.error('[carbon] federation exchange failed:', (e as Error).message);
      }
    }
  }
}

/** The root item ids of a pulled payload: items whose parent is null OR whose parent
 *  is not itself present in the payload (the subtree's entry points). */
function inferRoots(payload: PullPayload): string[] {
  const present = new Set(payload.ops.map((o) => o.item_id));
  const parentOf = new Map<string, string | null>();
  for (const op of [...payload.ops].sort((a, b) => a.ts - b.ts)) {
    if ('parent_id' in op.fields) {
      parentOf.set(op.item_id, (op.fields as { parent_id?: string | null }).parent_id ?? null);
    } else if (!parentOf.has(op.item_id)) {
      parentOf.set(op.item_id, null);
    }
  }
  const roots: string[] = [];
  for (const id of present) {
    const p = parentOf.get(id) ?? null;
    if (p === null || !present.has(p)) roots.push(id);
  }
  return roots;
}
