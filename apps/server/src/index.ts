import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import {
  migrate,
  ensureDeviceId,
  ingestOps,
  ingestRecordOps,
  compactNoteOps,
  visibleItemIds,
  subtreeIds,
  hasWriteAccess,
  listUsers,
  getUser,
  getUserByUsername,
  createUser,
  updateUser,
  softDeleteUser,
  createItem,
  updateItem,
  setCompleted,
  addComment,
  addAttachment,
  listComments,
  listAssigneesForItem,
  getItem,
  allItems,
  inbox,
  today,
  flagged,
  tasksInZone,
  tasksAtLocation,
  type Op,
  type RecordOp,
  type ItemPatch,
  type UserRole,
} from '@carbon/core';
import { openDb } from './sqlite';
import { sanitizeOps, sanitizeRecordOps } from './sync-guard';
import {
  ensureServerTables,
  bootstrapUsers,
  basicAuth,
  requireAdmin,
  requireScope,
  publicUser,
  setPassword,
  hashPassword,
  createToken,
  listTokens,
  revokeToken,
  createSession,
  revokeSession,
  getHaPerson,
  setHaPerson,
  resolveUserByHaPerson,
  saveGps,
  getGps,
  saveZone,
  getUserLocation,
  saveDeviceLocation,
  listDeviceLocations,
  deleteDeviceLocation,
  DEVICE_STALE_MS,
  startGpsScheduler,
  type AuthVars,
} from './auth';
import {
  saveSubscription,
  removeSubscription,
  notifyTask,
  startReminderScheduler,
} from './push';
import { saveFcmToken, removeFcmToken } from './fcm';
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  testAgent,
  triggerAgents,
  getNlSettings,
  setNlSettings,
  getAgentUsage,
} from './agents';
import {
  getHostLmConfig,
  buildHostAgentRow,
  resolveAgent as resolveNlAgent,
  isHostAgent,
  checkHostRateLimit,
} from './host-lm';
import { runAgentCommand } from './agent-command';
import { runFilterCommand } from './agent-filter';
import { getUserTimezone, setUserTimezone } from './user-prefs';
import {
  ensureCaldavDeviceId,
  getCaldavConfigRow,
  upsertCaldavConfig,
  deleteCaldavConfig,
  publicCaldavConfig,
  testCaldav,
  runSync,
  startCaldavScheduler,
  type CaldavConfigPatch,
} from './caldav';
import { registerAgentApi } from './agent-api';
import { buildAgentApiDeps } from './agent-ops';
import { listOpenNotices, getNotice, actOnNotice } from './notices';
import { checkPurgeSuggestions } from './purge-notices';
import {
  resolveHostCeiling,
  federationRoutes,
  registerFederationConfigRoutes,
  bindOfferDelivery,
  runAllFederationExchanges,
  fetchFederatedBlob,
  makeDeliverToPeer,
  listPeers,
  type FederationMode,
  type DeliverToPeer,
  type BlobStore,
  type SameHostPeer,
} from './federation';
import {
  ensureTelegramTables,
  startTelegramBot,
  createTelegramCode,
  getTelegramLinkForUser,
  unlinkTelegramUser,
  type TelegramBot,
} from './telegram';
import { safeFetch } from './safe-fetch';
import {
  initTenantDb,
  createTenantRegistry,
  subdomainFromHost,
  hostLabel,
  RESERVED_SUBDOMAINS,
  type TenantCtx,
  type FetchApp,
} from './tenant';
import {
  openControlDb,
  bootstrapHostAdmins,
  hostAdminAuth,
  listTenants,
  listActiveTenants,
  resolveTenantLocation,
  getTenantById,
  getTenantBySubdomain,
  setTenantStatus,
  setTenantPlan,
  setTenantExpiry,
  setTenantLock,
  setTenantBlobQuota,
  setTenantMaxUsers,
  setTenantAdminEmail,
  setTenantAllowPrivate,
  setTenantHostLmAvailable,
  setTenantFederationMode,
  deleteTenant,
  provisionTenant,
  validateSubdomain,
  tenantLockState,
  createPendingSignup,
  verifyPendingSignup,
  deletePendingSignup,
  gcPendingSignups,
  createPendingDelete,
  verifyPendingDelete,
  resolveDeleteToken,
  deletePendingDelete,
  gcPendingDeletes,
  type HostVars,
  type TenantRecord,
} from './control';
import { sendOtcCode, sendBillingReceipt, sendDeleteOtcCode } from './email';
// Version is single-sourced from the repo-root package.json. esbuild inlines this JSON
// into the bundle at build time; tsx resolves it directly in dev.
import rootPkg from '../../../package.json';
import {
  listPlans,
  getPlan,
  getSubscription,
  recordPaidPeriod,
  upsertSubscription,
  setSubscriptionStatus,
  markBillingEvent,
  billingEventSeen,
} from './billing';
import {
  isSquareConfigured,
  squareClientConfig,
  createCustomer,
  updateCustomer,
  createCard,
  createSubscription,
  cancelSubscription,
  retrieveSubscription,
  verifyWebhookSignature,
  planForVariation,
} from './square';

const PORT = Number(process.env.PORT ?? 3069);
const DB_PATH = resolve(process.env.DATABASE_PATH ?? './data/carbon.db');
const BLOBS_DIR = resolve(process.env.BLOBS_DIR ?? join(dirname(DB_PATH), 'blobs'));
const STATIC_DIR = process.env.STATIC_DIR ?? '../web/dist';
const VERSION = rootPkg.version;
// Apex domain that enables subdomain-per-tenant routing (e.g. "carbon.etx.sx").
// Unset => pure single-tenant self-host: every request hits the default tenant.
// Normalised defensively: a scheme/path/port is stripped so BASE_DOMAIN=
// "https://carbon.etx.sx/" still yields the bare host used for Host-header matching.
const BASE_DOMAIN =
  (process.env.BASE_DOMAIN?.trim() || '')
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '')
    .toLowerCase() || undefined;
// Dedicated offline/local-only host (no account, no sync): app.<BASE_DOMAIN>.
const APP_HOST = process.env.APP_HOST?.trim() || 'app';
const CONTROL_DB_PATH = resolve(
  process.env.CONTROL_DB_PATH ?? join(dirname(DB_PATH), 'control.db'),
);
const TENANTS_DIR = resolve(process.env.TENANTS_DIR ?? join(dirname(DB_PATH), 'tenants'));
// Days of access a self-service signup gets before the workspace locks (renew gate).
const SIGNUP_TRIAL_DAYS = Math.max(1, Number(process.env.SIGNUP_TRIAL_DAYS) || 30);

// Federation host ceiling (Gate 1). The maximum federation scope this host permits:
//   off           — L1 only, no federation anywhere on this host (default)
//   intra_server  — same-host cross-tenant (L2) allowed, external (L3) blocked
//   cross_server  — L2 + L3 allowed
// Per-tenant `federation_mode` (control DB) can pin a tenant below this. Single-tenant
// self-host (BASE_DOMAIN unset / the 'default' tenant) has no peer, so it resolves to off.
const FEDERATION_MODE_ENV: 'off' | 'intra_server' | 'cross_server' = (() => {
  const raw = process.env.FEDERATION_MODE?.trim().toLowerCase();
  return raw === 'intra_server' || raw === 'cross_server' ? raw : 'off';
})();

// ----- Telegram bot (optional, per-server) ----------------------------------
// One bot for the whole server. Users link their individual Carbon user via a one-time code
// from Settings → Telegram, then drive the same NL agent over chat. Disabled when the token
// is unset. The webhook is auto-registered at <TELEGRAM_WEBHOOK_URL>/telegram/webhook.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL?.trim() || undefined;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME?.trim() || undefined;
// Assigned once the async startup (getMe + setWebhook) resolves; the webhook route reads it.
let telegramBot: TelegramBot | null = null;

type Env = { Variables: AuthVars };

/**
 * Build the full set of /api/* routes for ONE tenant, bound to its DB. The route
 * bodies are unchanged from the single-tenant server: they close over `db`,
 * `serverDeviceId`, `vapidPublicKey`, and `BLOBS_DIR`, which we destructure from
 * the tenant context here. The returned app is mounted/forwarded per request.
 */
// Max attachment blob size. Override with BLOB_MAX_MB. Default 25 MB.
const MAX_BLOB_BYTES = Math.max(1, Number(process.env.BLOB_MAX_MB) || 25) * 1024 * 1024;

// Default per-workspace blob storage cap (override with BLOB_QUOTA_MB, default 500 MB).
// Host admins can override it per workspace; a tenant's null column uses this default.
const BLOB_QUOTA_DEFAULT_BYTES = Math.max(0, Number(process.env.BLOB_QUOTA_MB) || 500) * 1024 * 1024;

/** Effective blob quota in bytes for a tenant: 0 = unlimited (self-host default tenant,
 *  or an explicit 0 override); a null column falls back to the server default. */
function effectiveBlobQuota(rec: TenantRecord | null): number {
  if (!rec || rec.id === 'default') return 0; // single-tenant self-host is uncapped
  return rec.blob_quota_bytes == null ? BLOB_QUOTA_DEFAULT_BYTES : rec.blob_quota_bytes;
}

// Default human-user cap per hosted workspace (override with MAX_WORKSPACE_USERS,
// default 6). Host admins can override it per workspace; the single-tenant self-host
// is always uncapped.
const WORKSPACE_USERS_DEFAULT = Math.max(0, Number(process.env.MAX_WORKSPACE_USERS) || 6);

/** Effective human-user cap for a tenant: 0 = unlimited (self-host default tenant, or an
 *  explicit 0 override); a null column falls back to the server default. */
function effectiveMaxUsers(rec: TenantRecord | null): number {
  if (!rec || rec.id === 'default') return 0; // single-tenant self-host is uncapped
  return rec.max_users == null ? WORKSPACE_USERS_DEFAULT : rec.max_users;
}

/** Whether THIS tenant's agents may reach private/loopback/LAN endpoints (e.g. a
 *  self-hosted LLM). Single-tenant self-host always may; in multi-tenant mode the SSRF
 *  guard blocks private hosts unless a host admin opts the workspace in, or
 *  ALLOW_PRIVATE_AGENT_ENDPOINTS=1 forces the allow globally. */
function agentsAllowPrivate(rec: TenantRecord | null): boolean {
  if (!BASE_DOMAIN) return true; // single-tenant self-host
  if (process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS === '1') return true; // global override
  if (!rec || rec.id === 'default') return true; // operator's own default tenant
  return !!rec.allow_private_endpoints;
}

/** The resolved federation host ceiling (Gate 1) for a tenant: the per-tenant
 *  `federation_mode` override if set, else the FEDERATION_MODE env default.
 *  Single-tenant self-host (BASE_DOMAIN unset, or the operator's own 'default'
 *  tenant) has no meaningful peer and always resolves to `off`. Mirrors the
 *  `agentsAllowPrivate` env-default-plus-override pattern. */
function resolveFederationMode(rec: TenantRecord | null): FederationMode {
  return resolveHostCeiling({
    override: rec?.federation_mode,
    envDefault: FEDERATION_MODE_ENV,
    // No peer for single-tenant self-host or the operator's own 'default' tenant.
    isSelfHost: !BASE_DOMAIN || !rec || rec.id === 'default',
  });
}

/** Total bytes stored in a (flat) content-addressed blobs directory. */
function blobsDirBytes(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // dir not created yet
  }
  for (const name of names) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      /* file vanished mid-scan — ignore */
    }
  }
  return total;
}

function buildTenantApp(ctx: TenantCtx, deliverToPeer: DeliverToPeer): FetchApp {
  const { db, serverDeviceId, vapidPublicKey } = ctx;
  const BLOBS_DIR = ctx.blobsDir;
  // The tenant's content-addressed blob store as a narrow capability, so federation's
  // blob serve/fetch (Phase 5) shares the SAME on-disk store as `GET/POST /api/blobs/:hash`
  // without duplicating the fs/path layout. `store` is only ever reached with already
  // hash-verified bytes (federation.ts `storeVerifiedBlob` re-hashes first, mirroring A4).
  const blobStore: BlobStore = {
    has: (hash) => existsSync(join(BLOBS_DIR, hash)),
    read: (hash) => {
      const path = join(BLOBS_DIR, hash);
      return existsSync(path) ? readFileSync(path) : null;
    },
    store: (hash, bytes) => writeFileSync(join(BLOBS_DIR, hash), bytes),
  };
  // Per-request: may this workspace's agents reach private/LAN endpoints? (host-admin flag)
  const allowPrivate = (): boolean =>
    agentsAllowPrivate(ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id));
  // Per-request: may this workspace select the host-shared LM? Single-tenant self-host
  // (the 'default' tenant) always may — there's no control-DB row to gate it.
  const hostAvailable = (): boolean =>
    ctx.id === 'default' ? true : !!getTenantById(controlDb, ctx.id)?.host_lm_available;

  const api = new Hono<Env>();
  // In multi-tenant mode never fall back to open/no-auth: a provisioned tenant
  // always has an admin, and "open mode" if the last user were deleted would expose
  // the whole workspace to anyone on the subdomain (A2).
  api.use('*', basicAuth(db, !BASE_DOMAIN));

  api.get('/me', (c) => {
    const id = c.get('userId');
    const user = getUser(db, id);
    const base = user
      ? publicUser(user)
      : {
          id,
          username: c.get('username'),
          display_name: null,
          role: c.get('role'),
          is_bot: false,
          avatar_color: null,
          avatar_initial: null,
          plan_startup_min: null,
          plan_default_estimate_min: null,
        };
    return c.json({
      ...base,
      open: id === 'local', // server has no accounts → running open (no login)
      ha_person: id === 'local' ? null : getHaPerson(db, id),
      vapid: vapidPublicKey,
    });
  });

  // Exchange a password (sent once via Basic auth) for an opaque, revocable
  // session token. The client stores the token instead of the password.
  api.post('/login', (c) => {
    const method = c.get('authMethod');
    if (method === 'open') return c.json({ open: true });
    if (method !== 'basic') return c.json({ error: 'password auth required' }, 400);
    const id = c.get('userId');
    const user = getUser(db, id);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ token: createSession(db, id), user: publicUser(user) });
  });

  // Revoke the current session token (sign out). Idempotent.
  api.post('/logout', (c) => {
    const header = c.req.header('Authorization');
    if (header?.startsWith('Bearer ')) revokeSession(db, header.slice(7).trim());
    return c.json({ ok: true });
  });

  api.patch('/me', async (c) => {
    const id = c.get('userId');
    if (id === 'local') return c.json({ error: 'no account' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      ha_person?: string | null;
      display_name?: string | null;
      avatar_color?: string | null;
      avatar_initial?: string | null;
      plan_startup_min?: number | null;
      plan_default_estimate_min?: number | null;
    };
    if ('ha_person' in body) setHaPerson(db, id, body.ha_person ?? null);
    // Self-service profile fields.
    const patch: Parameters<typeof updateUser>[2] = {};
    if ('display_name' in body) patch.display_name = body.display_name?.trim() || null;
    if ('avatar_color' in body) patch.avatar_color = body.avatar_color || null;
    if ('avatar_initial' in body)
      patch.avatar_initial = body.avatar_initial?.trim().slice(0, 2).toUpperCase() || null;
    const clampMin = (v: number | null | undefined) =>
      v == null || !Number.isFinite(v) ? null : Math.max(0, Math.min(600, Math.round(v)));
    if ('plan_startup_min' in body) patch.plan_startup_min = clampMin(body.plan_startup_min);
    if ('plan_default_estimate_min' in body)
      patch.plan_default_estimate_min = clampMin(body.plan_default_estimate_min);
    if (Object.keys(patch).length) updateUser(db, id, patch);
    const u = getUser(db, id);
    return c.json({ ok: true, ...(u ? publicUser(u) : {}), ha_person: getHaPerson(db, id) });
  });

  api.get('/users', (c) => c.json({ users: listUsers(db).map(publicUser) }));

  // ----- admin: user management ----------------------------------------------

  api.post('/admin/users', requireAdmin, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      displayName?: string;
      role?: UserRole;
      isBot?: boolean;
    };
    if (!body.username || !body.password) {
      return c.json({ error: 'username and password required' }, 400);
    }
    if (getUserByUsername(db, body.username)) {
      return c.json({ error: 'username already exists' }, 409);
    }
    // Enforce the per-workspace human-user cap (hosted subscriptions). Bot/agent
    // accounts don't count toward the seat limit, and self-host is uncapped.
    const isBot = body.isBot ?? false;
    if (!isBot && ctx.id !== 'default') {
      const limit = effectiveMaxUsers(getTenantById(controlDb, ctx.id));
      if (limit > 0) {
        const humans = listUsers(db).filter((u) => !u.is_bot).length;
        if (humans >= limit) {
          return c.json({ error: 'workspace_user_limit', limit }, 403);
        }
      }
    }
    const user = createUser(db, {
      username: body.username,
      displayName: body.displayName ?? body.username,
      role: body.role ?? 'member',
      isBot,
    });
    setPassword(db, user.id, hashPassword(body.password));
    return c.json(publicUser(user), 201);
  });

  api.patch('/admin/users/:id', requireAdmin, async (c) => {
    const id = c.req.param('id');
    if (!getUser(db, id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      displayName?: string;
      role?: UserRole;
      password?: string;
      ha_person?: string | null;
    };
    updateUser(db, id, {
      ...(body.displayName !== undefined ? { display_name: body.displayName } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
    });
    if (body.password) setPassword(db, id, hashPassword(body.password));
    // Admins may map any user to their Home Assistant `person.*` entity (the
    // per-user PATCH /api/me only sets the caller's own mapping). This lets one
    // admin token wire up household members' geofence/GPS reminders.
    if ('ha_person' in body) setHaPerson(db, id, body.ha_person ?? null);
    return c.json({ ...publicUser(getUser(db, id)!), ha_person: getHaPerson(db, id) });
  });

  api.delete('/admin/users/:id', requireAdmin, (c) => {
    const id = c.req.param('id');
    if (id === c.get('userId')) return c.json({ error: 'cannot delete yourself' }, 400);
    const target = getUser(db, id);
    if (!target) return c.json({ error: 'not found' }, 404);
    // Refuse to delete the last admin — otherwise the workspace becomes unmanageable
    // (and in single-tenant mode would flip to open/no-auth). (A2)
    if (target.role === 'admin') {
      const admins = listUsers(db).filter((u) => u.role === 'admin' && !u.deleted).length;
      if (admins <= 1) return c.json({ error: 'cannot delete the last admin' }, 400);
    }
    softDeleteUser(db, id);
    return c.json({ ok: true });
  });

  // ----- sync (auth-scoping added in C4) --------------------------------------

  interface OpRow {
    seq: number;
    id: string;
    item_id: string;
    ts: number;
    device_id: string;
    fields: string;
  }
  interface RecRow {
    seq: number;
    id: string;
    entity: string;
    row_id: string;
    ts: number;
    device_id: string;
    data: string;
  }

  api.post('/sync', async (c) => {
    const userId = c.get('userId');
    const open = userId === 'local'; // no-auth single-user mode sees everything
    const body = (await c.req.json().catch(() => ({}))) as {
      since?: number;
      rsince?: number;
      ops?: Op[];
      recordOps?: RecordOp[];
      need?: string[];
    };
    const since = Number(body.since ?? 0);
    const rsince = Number(body.rsince ?? 0);

    // Validate/stamp client-pushed ops before applying (S1). Items first so that a
    // share/assignee pushed alongside a brand-new item sees that item already ingested.
    // Deliberately skipped in open mode: no-auth single-user has exactly one trusted
    // caller, so author_id/user_id/ownership spoofing isn't a threat to guard against.
    if (!open && Array.isArray(body.ops)) body.ops = sanitizeOps(db, userId, body.ops);
    const pushedOps = Array.isArray(body.ops) ? body.ops : [];
    if (pushedOps.length) ingestOps(db, pushedOps, true);
    if (!open && Array.isArray(body.recordOps))
      body.recordOps = sanitizeRecordOps(db, userId, body.recordOps);
    if (Array.isArray(body.recordOps) && body.recordOps.length) {
      const fresh = ingestRecordOps(db, body.recordOps, true);
      triggerAgents(ctx.id, db, serverDeviceId, fresh, allowPrivate()); // @mention / assignment -> agent run
    }

    // Prune superseded note-only ops (see compactNoteOps' safety argument). Runs
    // BEFORE building the outgoing scan so a just-pruned loser is never sent, and
    // AFTER ingest so a client's freshly-pushed note edit is considered. Server ops
    // are all durable at the hub, so no syncedOnly guard — every eligible loser goes.
    // Deletions don't renumber surviving rowids, so this client's (and every peer's,
    // federation included) `since`/push cursor stays monotonic and still returns the
    // retained winner. Gated on the push actually carrying a `note` field: new
    // supersession can only arise from a freshly-ingested note op, so idle sync polls
    // (the common case) skip the full op-log scan entirely.
    const pushedNoteItemIds = [
      ...new Set(
        pushedOps
          .filter((o) => o.fields && 'note' in o.fields)
          .map((o) => o.item_id),
      ),
    ];
    if (pushedNoteItemIds.length) compactNoteOps(db, { itemIds: pushedNoteItemIds });

    const visible = open ? null : visibleItemIds(db, userId);

    // Item ops scoped to items the user can see. cursor advances past scanned rows
    // (even filtered) so the client never re-fetches them.
    const opRows = db.all<OpRow>(
      `SELECT rowid AS seq, id, item_id, ts, device_id, fields FROM ops WHERE rowid > ? ORDER BY rowid`,
      [since],
    );
    const ops: Op[] = [];
    let cursor = since;
    for (const r of opRows) {
      cursor = r.seq;
      if (open || visible!.has(r.item_id)) {
        ops.push({
          id: r.id,
          item_id: r.item_id,
          ts: Number(r.ts),
          device_id: r.device_id,
          fields: JSON.parse(r.fields),
        });
      }
    }

    // Record ops (shares/assignees) for visible items, or those addressed to the user.
    const recRows = db.all<RecRow>(
      `SELECT rowid AS seq, id, entity, row_id, ts, device_id, data FROM record_ops WHERE rowid > ? ORDER BY rowid`,
      [rsince],
    );
    const recordOps: RecordOp[] = [];
    let rcursor = rsince;
    for (const r of recRows) {
      rcursor = r.seq;
      const data = JSON.parse(r.data) as { item_id?: string; user_id?: string };
      const visibleRec =
        open ||
        r.entity === 'tag' || // tags are shared vocabulary — visible to everyone
        data.user_id === userId ||
        (data.item_id ? visible!.has(data.item_id) : false);
      if (visibleRec) {
        recordOps.push({
          id: r.id,
          entity: r.entity,
          row_id: r.row_id,
          ts: Number(r.ts),
          device_id: r.device_id,
          data,
        });
      }
    }

    // Backfill: the client reports shared items it has no content for (access granted
    // after it synced past those ops). Send the full subtree regardless of cursor —
    // applyOp/record merge are idempotent, so re-sent ops are harmless.
    if (!open && Array.isArray(body.need) && body.need.length) {
      const roots = body.need.filter((id) => typeof id === 'string' && visible!.has(id));
      const subtree = subtreeIds(db, roots);
      if (subtree.size) {
        // Filter by item_id in SQL (chunked IN batches under the ~999-param limit) rather
        // than scanning the whole table and filtering in JS (DB-3). Each chunk is ordered
        // by rowid; we re-sort the merged rows by rowid to preserve the exact global order
        // the single ORDER BY rowid scan produced, then dedup in JS as before.
        const BACKFILL_CHUNK = 500;
        const subtreeArr = [...subtree];
        // `ops.item_id` is a real column → filter directly.
        const opRows: OpRow[] = [];
        for (let i = 0; i < subtreeArr.length; i += BACKFILL_CHUNK) {
          const batch = subtreeArr.slice(i, i + BACKFILL_CHUNK);
          const ph = batch.map(() => '?').join(',');
          opRows.push(
            ...db.all<OpRow>(
              `SELECT rowid AS seq, id, item_id, ts, device_id, fields FROM ops WHERE item_id IN (${ph}) ORDER BY rowid`,
              batch,
            ),
          );
        }
        opRows.sort((a, b) => a.seq - b.seq);
        const seenOps = new Set(ops.map((o) => o.id));
        for (const r of opRows) {
          if (seenOps.has(r.id)) continue;
          ops.push({
            id: r.id,
            item_id: r.item_id,
            ts: Number(r.ts),
            device_id: r.device_id,
            fields: JSON.parse(r.fields),
          });
        }
        // `record_ops` carry the owning item only in JSON `data.item_id`; match it via the
        // indexed json_extract expression (idx_record_ops_item_id) instead of scanning.
        const recRowsBackfill: RecRow[] = [];
        for (let i = 0; i < subtreeArr.length; i += BACKFILL_CHUNK) {
          const batch = subtreeArr.slice(i, i + BACKFILL_CHUNK);
          const ph = batch.map(() => '?').join(',');
          recRowsBackfill.push(
            ...db.all<RecRow>(
              `SELECT rowid AS seq, id, entity, row_id, ts, device_id, data FROM record_ops WHERE json_extract(data, '$.item_id') IN (${ph}) ORDER BY rowid`,
              batch,
            ),
          );
        }
        recRowsBackfill.sort((a, b) => a.seq - b.seq);
        const seenRecs = new Set(recordOps.map((o) => o.id));
        for (const r of recRowsBackfill) {
          if (seenRecs.has(r.id)) continue;
          const data = JSON.parse(r.data) as { item_id?: string };
          // json_extract already matched item_id; re-check keeps the shape identical to the
          // prior JS filter (and guards the theoretical NULL-item_id row the index skips).
          if (data.item_id && subtree.has(data.item_id)) {
            recordOps.push({
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
    }

    // Tags are global shared vocabulary — always send the full set, ignoring the
    // cursor, so every client converges regardless of sync history (cheap: few tags,
    // and dedup avoids re-sending ones already included above).
    if (!open) {
      const seen = new Set(recordOps.map((o) => o.id));
      for (const r of db.all<RecRow>(
        "SELECT rowid AS seq, id, entity, row_id, ts, device_id, data FROM record_ops WHERE entity = 'tag' ORDER BY rowid",
      )) {
        if (seen.has(r.id)) continue;
        recordOps.push({
          id: r.id,
          entity: r.entity,
          row_id: r.row_id,
          ts: Number(r.ts),
          device_id: r.device_id,
          data: JSON.parse(r.data),
        });
      }
    }

    // Full user rows (already exclude password_hash) so peers can materialize the roster.
    const users = listUsers(db);
    return c.json({ ops, cursor, recordOps, rcursor, users });
  });

  // ----- content-addressed blob storage ---------------------------------------

  const isHash = (h: string) => /^[a-f0-9]{64}$/.test(h);

  // A blob is content-addressed, so the hash alone grants no access — gate reads on
  // whether the caller can see an item that references it. Otherwise any signed-in
  // user could fetch any other user's attachment by hash. Bots/open see everything
  // (matches `canSee`); a blob no live attachment references is treated as absent.
  function canReadBlob(userId: string, hash: string): boolean {
    if (userId === 'local' || isBot(userId)) return true;
    const rows = db.all<{ item_id: string | null; parent_type: string; parent_id: string }>(
      'SELECT item_id, parent_type, parent_id FROM attachments WHERE hash = ? AND deleted = 0',
      [hash],
    );
    const visible = visibleItemIds(db, userId);
    for (const r of rows) {
      // item_id is denormalized (migration 4); resolve it for older rows.
      const itemId =
        r.item_id ??
        (r.parent_type === 'item'
          ? r.parent_id
          : db.get<{ item_id: string }>('SELECT item_id FROM comments WHERE id = ?', [r.parent_id])
              ?.item_id);
      if (itemId && visible.has(itemId)) return true;
    }
    // Images embedded in a note body reference their blob only via Markdown
    // (`![alt](/api/blobs/{hash})`) — the Notes flow creates no attachments row.
    // The body itself syncs under item visibility, so gate the blob the same way:
    // readable when any live, visible item's note references it. LIKE is
    // case-insensitive for ASCII, matching notesZip's case-insensitive BLOB_REF.
    const noteRefs = db.all<{ id: string }>(
      "SELECT id FROM items WHERE deleted = 0 AND note LIKE '%/api/blobs/' || ? || '%'",
      [hash],
    );
    return noteRefs.some((r) => visible.has(r.id));
  }

  api.get('/blobs/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!isHash(hash)) return c.json({ error: 'bad hash' }, 400);
    // 404 (not 403) on no-access so the response never confirms a blob exists.
    if (!canReadBlob(c.get('userId'), hash)) return c.json({ error: 'not found' }, 404);
    const path = join(BLOBS_DIR, hash);
    // Fetch-from-peer fallback (Phase 5): the blob is absent locally but the caller can
    // see a referencing item. If that hash belongs to a FEDERATED attachment (referenced
    // within an active inbound link's granted subtree — `fetchFederatedBlob` scopes to
    // exactly that), fetch it over the link, hash-verify (A4), cache, and serve. A
    // NON-federated missing blob has no such link, so `fetchFederatedBlob` returns null
    // and we fall through to the unchanged 404 — the local path is byte-for-byte the same.
    if (!existsSync(path)) {
      const fetched = await fetchFederatedBlob(db, deliverToPeer, blobStore, hash);
      if (fetched) {
        return new Response(new Uint8Array(fetched), {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      return c.json({ error: 'not found' }, 404);
    }
    return new Response(new Uint8Array(readFileSync(path)), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });

  api.on('HEAD', '/blobs/:hash', (c) => {
    const hash = c.req.param('hash');
    if (!isHash(hash)) return c.body(null, 400);
    if (!canReadBlob(c.get('userId'), hash)) return c.body(null, 404);
    return c.body(null, existsSync(join(BLOBS_DIR, hash)) ? 200 : 404);
  });

  api.post('/blobs/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!isHash(hash)) return c.json({ error: 'bad hash' }, 400);
    // Reject oversized uploads up front (Content-Length) to avoid buffering a huge
    // body, then again after reading (a client can lie about the header) (A4).
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared && declared > MAX_BLOB_BYTES) return c.json({ error: 'blob too large' }, 413);
    const path = join(BLOBS_DIR, hash);
    if (!existsSync(path)) {
      const buf = Buffer.from(await c.req.arrayBuffer());
      if (buf.length > MAX_BLOB_BYTES) return c.json({ error: 'blob too large' }, 413);
      // Content addressing is only sound if the bytes actually hash to the claimed
      // name — otherwise a client can poison a hash another client will later read.
      const actual = createHash('sha256').update(buf).digest('hex');
      if (actual !== hash) return c.json({ error: 'content does not match hash' }, 400);
      // Per-workspace storage cap: reject a NEW blob that would push the workspace over
      // its quota. Content-addressed dedup means an already-stored hash never gets here,
      // so re-uploads don't count twice. 507 (not 413) so the client keeps it pending and
      // retries once space frees up / the admin raises the cap — 413 is treated permanent.
      const quota = effectiveBlobQuota(ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id));
      if (quota > 0) {
        const used = blobsDirBytes(BLOBS_DIR);
        if (used + buf.length > quota) {
          return c.json({ error: 'workspace_storage_full', used, quota }, 507);
        }
      }
      writeFileSync(path, buf);
    }
    return c.json({ ok: true });
  });

  // ----- integration REST API (token- or human-authed) -----------------------

  function isBot(userId: string): boolean {
    return userId !== 'local' && !!getUser(db, userId)?.is_bot;
  }
  // Bots read everything; humans see only what they own or are shared on.
  function canSee(userId: string, itemId: string): boolean {
    return userId === 'local' || isBot(userId) || visibleItemIds(db, userId).has(itemId);
  }
  function botAssigned(userId: string, itemId: string): boolean {
    return listAssigneesForItem(db, itemId).some((a) => a.user_id === userId);
  }
  function botMentioned(userId: string, itemId: string): boolean {
    return listComments(db, itemId).some((c) => (c.mentions ?? []).includes(userId));
  }

  api.get('/tasks', requireScope('tasks:read'), (c) => {
    const userId = c.get('userId');
    const visible = userId === 'local' || isBot(userId) ? null : visibleItemIds(db, userId);
    let items = allItems(db).filter((i) => i.type === 'task' && (!visible || visible.has(i.id)));
    switch (c.req.query('perspective')) {
      case 'inbox':
        items = inbox(items);
        break;
      case 'today':
        items = today(items);
        break;
      case 'flagged':
        items = flagged(items);
        break;
    }
    const project = c.req.query('project');
    if (project) items = items.filter((i) => i.parent_id === project);
    const status = c.req.query('status');
    if (status) items = items.filter((i) => i.status === status);
    return c.json({ tasks: items });
  });

  api.post('/tasks', requireScope('inbox:write'), async (c) => {
    const userId = c.get('userId');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.title || typeof b.title !== 'string') return c.json({ error: 'title required' }, 400);
    const item = createItem(db, serverDeviceId, {
      title: b.title,
      note: (b.note as string) ?? null,
      parentId: (b.project_id as string) ?? null,
      ownerId: userId === 'local' ? null : userId,
      dueDate: (b.due_date as string) ?? null,
      flagged: !!b.flagged,
      priority: typeof b.priority === 'number' ? b.priority : 0,
      metadata:
        'metadata' in b
          ? ((b.metadata as string | Record<string, unknown> | null) ?? null)
          : undefined,
    });
    return c.json(item, 201);
  });

  api.get('/tasks/:id', requireScope('tasks:read'), (c) => {
    const item = getItem(db, c.req.param('id'));
    if (!item || item.deleted || !canSee(c.get('userId'), item.id)) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(item);
  });

  api.patch('/tasks/:id', requireScope('tasks:write'), async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const item = getItem(db, id);
    if (!item || item.deleted || !canSee(userId, id)) return c.json({ error: 'not found' }, 404);
    if (userId !== 'local' && !hasWriteAccess(db, id, userId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: ItemPatch = {};
    const fields = [
      'title',
      'note',
      'status',
      'due_date',
      'defer_date',
      'flagged',
      'priority',
      'parent_id',
      'geo',
      'color',
      'recurrence',
      'review_interval',
      'metadata',
    ] as const;
    for (const k of fields) if (k in b) (patch as Record<string, unknown>)[k] = b[k];
    if ('metadata' in patch) {
      const m = patch.metadata as unknown;
      if (m != null && typeof m === 'object') {
        (patch as Record<string, unknown>).metadata = JSON.stringify(m);
      } else if (m === '') {
        patch.metadata = null;
      }
    }
    // A raw status patch must keep completed_at in step (mirrors setCompleted) —
    // completed-item age logic (e.g. the purge feature) relies on the stamp.
    if (typeof patch.status === 'string' && patch.status !== item.status) {
      patch.completed_at = patch.status === 'done' ? new Date().toISOString() : null;
    }
    updateItem(db, serverDeviceId, id, patch);
    return c.json(getItem(db, id));
  });

  api.post('/tasks/:id/complete', requireScope('tasks:write'), (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const item = getItem(db, id);
    if (!item || item.deleted || !canSee(userId, id)) return c.json({ error: 'not found' }, 404);
    // Bots may complete only tasks assigned to them; humans need write access.
    const mayComplete =
      userId === 'local' ||
      (isBot(userId) ? botAssigned(userId, id) : hasWriteAccess(db, id, userId));
    if (!mayComplete) return c.json({ error: 'forbidden' }, 403);
    setCompleted(db, serverDeviceId, id, c.req.query('done') !== 'false');
    return c.json(getItem(db, id));
  });

  // Post a comment as the authenticated user (lets agentic frameworks reply).
  api.post('/tasks/:id/comments', requireScope('tasks:write'), async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const item = getItem(db, id);
    if (!item || item.deleted || !canSee(userId, id)) return c.json({ error: 'not found' }, 404);
    // A bot may only comment where it's assigned or @mentioned.
    if (isBot(userId) && !botAssigned(userId, id) && !botMentioned(userId, id)) {
      return c.json({ error: 'agent not assigned or mentioned on this task' }, 403);
    }
    const b = (await c.req.json().catch(() => ({}))) as { body?: string };
    if (!b.body) return c.json({ error: 'body required' }, 400);
    const comment = addComment(db, serverDeviceId, {
      itemId: id,
      authorId: userId === 'local' ? null : userId,
      body: b.body,
    });
    return c.json(comment, 201);
  });

  // Attach a file to a task (upload the blob to /api/blobs/:hash first).
  api.post('/tasks/:id/attachments', requireScope('tasks:write'), async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const item = getItem(db, id);
    if (!item || item.deleted || !canSee(userId, id)) return c.json({ error: 'not found' }, 404);
    if (isBot(userId) && !botAssigned(userId, id) && !botMentioned(userId, id)) {
      return c.json({ error: 'agent not assigned or mentioned on this task' }, 403);
    }
    const b = (await c.req.json().catch(() => ({}))) as {
      filename?: string;
      mimeType?: string;
      size?: number;
      hash?: string;
    };
    if (!b.filename || !b.hash) return c.json({ error: 'filename and hash required' }, 400);
    const att = addAttachment(db, serverDeviceId, {
      parentType: 'item',
      parentId: id,
      itemId: id,
      filename: b.filename,
      mimeType: b.mimeType ?? null,
      size: b.size ?? 0,
      hash: b.hash,
      createdBy: userId === 'local' ? null : userId,
    });
    return c.json(att, 201);
  });

  // ----- natural-language agent API (/api/agent/*) ----------------------------
  // Granular, context-small primitives a tiny LLM (via Hermes) composes for NL task
  // management. Mounts on the same `api` router, inheriting its auth middleware.
  const agentApiDeps = buildAgentApiDeps(db, serverDeviceId, {
    multiTenant: !!BASE_DOMAIN,
    allowPrivate: allowPrivate(),
  });
  registerAgentApi(api, agentApiDeps);

  // In-app NL commands (Stage 2): the Add box posts here when the first word matches a
  // configured keyword. Runs as the user, so created items are owned by and visible to them.
  api.get('/agent/config', requireScope('tasks:read'), (c) => {
    const nl = getNlSettings(db);
    return c.json({ enabled: nl.enabled, keywords: nl.keywords });
  });

  api.post('/agent/command', requireScope('inbox:write'), async (c) => {
    const userId = c.get('userId');
    // Each command drives up to MAX_ITERS billable LLM round-trips, so cap how many a
    // single user/token can fire per hour — a leaked token can't run up unbounded cost.
    if (!hitAllowed(nlCommandHits, userId, NL_COMMAND_PER_USER_HOUR)) {
      return c.json({ error: 'too many commands, try later' }, 429);
    }
    const b = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      timezone?: string;
      currentProjectId?: string | null;
    };
    const text = (b.text ?? '').trim();
    if (!text) return c.json({ error: 'text required' }, 400);
    if (b.timezone) setUserTimezone(db, userId, b.timezone);
    const nl = getNlSettings(db);
    const agent = nl.enabled && nl.agentId ? resolveNlAgent(db, nl.agentId, hostAvailable()) : undefined;
    if (!agent || !agent.enabled || agent.kind === 'webhook') {
      return c.json({ error: 'nl_not_configured' }, 503);
    }
    if (isHostAgent(agent)) {
      const cfg = getHostLmConfig();
      const rl = cfg ? checkHostRateLimit(ctx.id, cfg) : { ok: false };
      if (!rl.ok) return c.json({ reply: rl.message ?? 'Try again later.', executed: [], usage: { input: 0, output: 0 } });
    }
    // The host operator's own endpoint is trusted regardless of this workspace's SSRF flag.
    const allowPrivateForCall = isHostAgent(agent) ? true : allowPrivate();
    try {
      const r = await runAgentCommand(agentApiDeps, agent, userId, text, allowPrivateForCall, {
        now: new Date(),
        timezone: b.timezone ?? getUserTimezone(db, userId),
        currentProjectId: b.currentProjectId ?? null,
      });
      return c.json(r);
    } catch (e) {
      // Log the detail server-side; don't return it — provider exception messages can
      // carry upstream URLs / error bodies that the API caller shouldn't see.
      console.error('[carbon] nl command failed:', e);
      return c.json({ error: 'command_failed' }, 502);
    }
  });

  // NL → advanced filter: the filter builder posts a description, the configured agent
  // returns a FilterExpr tree (validated client-side before it's applied). Reuses the
  // same per-user hourly cap as commands.
  api.post('/agent/filter', requireScope('tasks:read'), async (c) => {
    const userId = c.get('userId');
    if (!hitAllowed(nlCommandHits, userId, NL_COMMAND_PER_USER_HOUR)) {
      return c.json({ error: 'too many requests, try later' }, 429);
    }
    const b = (await c.req.json().catch(() => ({}))) as { text?: string; timezone?: string };
    const text = (b.text ?? '').trim();
    if (!text) return c.json({ error: 'text required' }, 400);
    if (b.timezone) setUserTimezone(db, userId, b.timezone);
    const nl = getNlSettings(db);
    const agent = nl.enabled && nl.agentId ? getAgent(db, nl.agentId) : undefined;
    if (!agent || !agent.enabled || agent.kind === 'webhook') {
      return c.json({ error: 'nl_not_configured' }, 503);
    }
    try {
      const r = await runFilterCommand(
        agentApiDeps,
        agent,
        userId,
        text,
        allowPrivate(),
        new Date(),
        b.timezone ?? getUserTimezone(db, userId),
      );
      return c.json({ expr: r.expr });
    } catch (e) {
      console.error('[carbon] nl filter failed:', e);
      return c.json({ error: 'filter_failed' }, 502);
    }
  });

  // ----- Telegram linking (per-user) ------------------------------------------
  // The bot is per-server; these let the signed-in user connect their *own* chat. The pairing
  // code lives in the control DB keyed by (tenant, user); the user sends it to the bot. Open
  // mode links the synthetic 'local' user. The tenant subdomain is null for self-host ('default').
  const tgSubdomain = (): string | null => (ctx.id === 'default' ? null : ctx.subdomain);

  api.get('/telegram', requireScope('tasks:read'), (c) => {
    const link = getTelegramLinkForUser(controlDb, ctx.id, c.get('userId'));
    return c.json({
      enabled: !!TELEGRAM_BOT_TOKEN,
      botUsername: telegramBot?.botUsername ?? TELEGRAM_BOT_USERNAME ?? null,
      link: link ? { username: link.username } : null,
    });
  });

  api.post('/telegram/code', requireScope('tasks:read'), async (c) => {
    if (!TELEGRAM_BOT_TOKEN) return c.json({ error: 'telegram_not_configured' }, 503);
    const userId = c.get('userId');
    const b = (await c.req.json().catch(() => ({}))) as { timezone?: string };
    // Piggyback the browser's zone here — it's the one browser round-trip every Telegram
    // user makes, so the bot can resolve "tomorrow night" without needing a separate setting.
    if (b.timezone) setUserTimezone(db, userId, b.timezone);
    const { code, expiresAt } = createTelegramCode(controlDb, {
      tenantId: ctx.id,
      subdomain: tgSubdomain(),
      userId,
    });
    return c.json({ code, expiresAt, botUsername: telegramBot?.botUsername ?? TELEGRAM_BOT_USERNAME ?? null });
  });

  api.delete('/telegram', requireScope('tasks:read'), (c) => {
    const removed = unlinkTelegramUser(controlDb, ctx.id, c.get('userId'));
    return c.json({ ok: true, removed });
  });

  // ----- system notices (the reusable "Carbon task" primitive) ----------------
  // Human-user routes: acting on a notice is session-authed to the addressed user
  // only. An API token must never act on someone's notice (a leaked task body
  // can't be actioned by a third party), so both routes reject token auth — the
  // same human-session-only posture as requireAdmin.
  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('authMethod') === 'token') return c.json({ error: 'forbidden' }, 403);
    return next();
  };

  api.get('/notices', requireSession, (c) => {
    const userId = c.get('userId');
    return c.json({ notices: listOpenNotices(db, userId) });
  });

  api.post('/notices/:id/act', requireSession, async (c) => {
    const userId = c.get('userId');
    const notice = getNotice(db, c.req.param('id'));
    if (!notice) return c.json({ error: 'not found' }, 404);
    // Gate 3 posture: only the addressed user may act on their own notice.
    if (notice.user_id !== userId) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { action?: string };
    const action = b.action ?? 'dismiss';
    const resolved = await actOnNotice(db, serverDeviceId, notice, action);
    return c.json({ notice: resolved });
  });

  // ----- federation: the Settings → Federation panel's REST surface -----------
  // Thin session/admin-authed config routes over the federation storage helpers
  // (the secret-authed offer/inbound/sync routes live in the `fedApi` sub-app below).
  registerFederationConfigRoutes(api, {
    db,
    resolveMode: () =>
      resolveFederationMode(ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id)),
    sessionAuth: requireSession,
    adminAuth: requireAdmin,
    // Supplied so revoking an outbound (owner) link sends a final retract-all to the
    // grantee before tearing the link down (the grantee drops the whole shared subtree).
    deliverToPeer,
    // Our identity for the mutual-whitelist check (how a peer stores US on its list).
    myLabel: ctx.subdomain || 'default',
    myBaseUrl: BASE_DOMAIN && ctx.subdomain ? `${ctx.subdomain}.${BASE_DOMAIN}` : undefined,
    // Same-host peer access for the directory route's mutual-whitelist gate, resolved
    // in-process via the registry (no network hop). `registry` is referenced lazily —
    // this closure only runs at request time, well after module init.
    sameHostPeer: (peerSubdomain) => makeSameHostPeer(peerSubdomain),
  });

  // ----- admin: API tokens ----------------------------------------------------

  api.get('/admin/tokens', requireAdmin, (c) => c.json({ tokens: listTokens(db) }));

  api.post('/admin/tokens', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      scopes?: string[];
      userId?: string;
    };
    if (!b.name) return c.json({ error: 'name required' }, 400);
    const scopes =
      Array.isArray(b.scopes) && b.scopes.length
        ? b.scopes
        : ['tasks:read', 'tasks:write', 'inbox:write'];
    const result = createToken(db, { userId: b.userId || c.get('userId'), name: b.name, scopes });
    return c.json({ token: result.token, ...result.row }, 201);
  });

  api.delete('/admin/tokens/:id', requireAdmin, (c) => {
    revokeToken(db, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ----- admin: LLM agents (Hermes / OpenAI / Anthropic bot users) -------------

  api.get('/admin/agents', requireAdmin, (c) => {
    const agents = listAgents(db);
    const hostCfg = getHostLmConfig();
    if (hostCfg && hostAvailable()) {
      const { api_key: _k, ...hostRow } = buildHostAgentRow(hostCfg);
      agents.unshift(hostRow);
    }
    return c.json({ agents });
  });

  api.post('/admin/agents', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      username?: string;
      kind?: 'openai' | 'anthropic' | 'webhook';
      endpoint?: string;
      apiKey?: string;
      model?: string;
      systemPrompt?: string;
    };
    if (!b.name || !b.username || !b.kind) {
      return c.json({ error: 'name, username, kind required' }, 400);
    }
    if (getUserByUsername(db, b.username)) return c.json({ error: 'username already exists' }, 409);
    const agent = createAgent(db, {
      name: b.name,
      username: b.username,
      kind: b.kind,
      endpoint: b.endpoint,
      apiKey: b.apiKey,
      model: b.model,
      systemPrompt: b.systemPrompt,
    });
    // Agentic frameworks act back via the API, so issue them a token (shown once).
    let token: string | undefined;
    if (b.kind === 'webhook') {
      token = createToken(db, {
        userId: agent.user_id,
        name: `${b.name} (agent)`,
        scopes: ['tasks:read', 'tasks:write', 'inbox:write'],
      }).token;
    }
    return c.json({ ...agent, token }, 201);
  });

  api.patch('/admin/agents/:id', requireAdmin, async (c) => {
    const id = c.req.param('id');
    if (!getAgent(db, id)) return c.json({ error: 'not found' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    updateAgent(db, id, b);
    return c.json(listAgents(db).find((a) => a.id === id) ?? {});
  });

  api.post('/admin/agents/:id/test', requireAdmin, async (c) => {
    const result = await testAgent(db, c.req.param('id'), allowPrivate());
    return c.json(result);
  });

  api.delete('/admin/agents/:id', requireAdmin, (c) => {
    const agent = getAgent(db, c.req.param('id'));
    deleteAgent(db, c.req.param('id'));
    if (agent) softDeleteUser(db, agent.user_id);
    return c.json({ ok: true });
  });

  // ----- admin: natural-language command settings + token usage ----------------

  const nlSettingsJson = () => {
    const nl = getNlSettings(db);
    return { agent_id: nl.agentId, keywords: nl.keywords, enabled: nl.enabled };
  };

  api.get('/admin/nl-settings', requireAdmin, (c) => c.json(nlSettingsJson()));

  api.patch('/admin/nl-settings', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      agent_id?: string | null;
      keywords?: string[];
      enabled?: boolean;
    };
    if (b.agent_id) {
      const a = resolveNlAgent(db, b.agent_id, hostAvailable());
      if (!a || a.kind === 'webhook') return c.json({ error: 'pick a direct-LLM agent' }, 400);
    }
    const patch: { agentId?: string | null; keywords?: string[]; enabled?: boolean } = {};
    if (b.agent_id !== undefined) patch.agentId = b.agent_id || null;
    if (Array.isArray(b.keywords)) patch.keywords = b.keywords.filter((k) => typeof k === 'string');
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    setNlSettings(db, patch);
    return c.json(nlSettingsJson());
  });

  api.get('/admin/nl-usage', requireAdmin, (c) => c.json(getAgentUsage(db)));

  // ----- admin: per-project CalDAV two-way sync --------------------------------
  // Config is server-only (holds the CalDAV password) and keyed by the project's
  // item id — deliberately NOT part of the CRDT sync. Requires a configured server.
  const requireProject = (c: import('hono').Context) => {
    const id = c.req.param('id');
    if (!id) return null;
    const proj = getItem(db, id);
    return proj && proj.type === 'project' && !proj.deleted ? proj : null;
  };

  api.get('/projects/:id/caldav', requireAdmin, (c) => {
    if (!requireProject(c)) return c.json({ error: 'project not found' }, 404);
    const row = getCaldavConfigRow(db, c.req.param('id'));
    return c.json({ config: row ? publicCaldavConfig(row) : null });
  });

  api.put('/projects/:id/caldav', requireAdmin, async (c) => {
    if (!requireProject(c)) return c.json({ error: 'project not found' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as CaldavConfigPatch;
    const row = upsertCaldavConfig(db, c.req.param('id'), b);
    return c.json({ config: publicCaldavConfig(row) });
  });

  api.delete('/projects/:id/caldav', requireAdmin, (c) => {
    if (!requireProject(c)) return c.json({ error: 'project not found' }, 404);
    deleteCaldavConfig(db, c.req.param('id'));
    return c.json({ ok: true });
  });

  api.post('/projects/:id/caldav/test', requireAdmin, async (c) => {
    if (!requireProject(c)) return c.json({ error: 'project not found' }, 404);
    return c.json(await testCaldav(db, c.req.param('id'), allowPrivate()));
  });

  api.post('/projects/:id/caldav/sync', requireAdmin, (c) => {
    if (!requireProject(c)) return c.json({ error: 'project not found' }, 404);
    // Fire-and-forget: a full sync makes one network round-trip per changed resource
    // and can outlast the reverse proxy's read timeout (→ 504). runSync serialises per
    // project and records last_status itself, so we kick it off and return at once; the
    // client polls the config's last_sync_at/last_status for the outcome.
    void runSync(db, ensureCaldavDeviceId(db), c.req.param('id'), allowPrivate());
    return c.json({ ok: true, started: true }, 202);
  });

  // ----- Web Push -------------------------------------------------------------

  api.get('/push/vapid', (c) => c.text(vapidPublicKey));

  api.post('/push/subscribe', async (c) => {
    const sub = (await c.req.json().catch(() => null)) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    } | null;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return c.json({ error: 'invalid subscription' }, 400);
    }
    saveSubscription(db, c.get('userId'), {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return c.json({ ok: true });
  });

  api.post('/push/unsubscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
    if (body.endpoint) removeSubscription(db, body.endpoint);
    return c.json({ ok: true });
  });

  // FCM device tokens (Capacitor / Android shell).
  api.post('/push/fcm', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!body.token) return c.json({ error: 'missing token' }, 400);
    saveFcmToken(db, c.get('userId'), body.token);
    return c.json({ ok: true });
  });

  api.post('/push/fcm/unsubscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (body.token) removeFcmToken(db, body.token);
    return c.json({ ok: true });
  });

  // Resolve the Carbon user a location report is about. A named HA `person` must
  // map to a user (returns null if unmapped, so the caller can no-op rather than
  // misattribute); an absent person falls back to the authenticated token's user.
  // Returns null for the anonymous 'local' user too.
  const resolvePerson = (c: Context<Env>, person: string | undefined): string | null => {
    if (person) return resolveUserByHaPerson(db, person);
    const uid = c.get('userId');
    return uid === 'local' ? null : uid;
  };

  // ----- GPS location feed (HA device-tracker tick) ---------------------------
  // Accepts a person's current GPS coordinates from HA.  HA should POST this
  // on a regular cadence (e.g. every 5 minutes) while the person is detected.
  // Carbon stores the latest position and uses it for proximity-based reminders.
  api.post('/gps', requireScope('tasks:write'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      person?: string;
      device_id?: string;
      name?: string;
      lat?: number;
      lng?: number;
      accuracy?: number;
      gps_accuracy?: number;
    };
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number') {
      return c.json({ error: 'lat and lng (numbers) required' }, 400);
    }
    // Resolve which user this is about. If a `person` is given it MUST map to a
    // Carbon user — otherwise we'd misattribute (e.g. a household member's fix
    // saved against the token owner). Only fall back to the token's user when no
    // person is named at all.
    const userId = resolvePerson(c, body.person);
    if (!userId) return c.json({ ok: true, saved: false, reason: 'unmapped person' });
    const accuracy = body.accuracy ?? body.gps_accuracy ?? null;
    // A self-reporting client passes its own device_id (→ source 'device'); HA's
    // single-fix feed has none, so it lands as the reserved `ha:<user>` device.
    // A named-`person` report is *about another user* (HA reporting a household member),
    // so it may only write that user's single `ha:<user>` row — never an arbitrary named
    // device pill. Only an own report (no person) may register a named device source.
    const ownReport = !body.person;
    const isDevice = ownReport && !!body.device_id;
    saveDeviceLocation(db, {
      userId,
      deviceId: isDevice ? body.device_id! : `ha:${userId}`,
      name: isDevice ? (body.name ?? null) : null,
      lat: body.lat,
      lng: body.lng,
      accuracy,
      source: isDevice ? 'device' : 'ha',
    });
    // Keep the legacy single row for the HA path only, so background proximity
    // push (checkGpsProximity) is unchanged and a device fix never clobbers it.
    if (!isDevice) saveGps(db, userId, body.lat, body.lng, accuracy);
    return c.json({ ok: true });
  });

  // ----- geolocation events (Home Assistant zone enter/leave) -----------------

  api.post('/geo/event', requireScope('tasks:write'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      person?: string;
      zone?: string;
      event?: 'enter' | 'leave';
      lat?: number;
      lng?: number;
      accuracy?: number;
      gps_accuracy?: number;
    };
    // Resolve which user this is about. A named `person` must map to a Carbon user
    // (see /gps above); only an absent person falls back to the token's user.
    const userId = resolvePerson(c, body.person);
    if (!userId) return c.json({ ok: true, matched: 0, reason: 'unmapped person' });

    const isEnter = (body.event ?? 'enter') === 'enter';
    // Persist the user's current location so GET /where (and the Nearby view) can
    // read it. Entering a named zone sets it; leaving clears it. Any coords given
    // refresh the latest GPS fix too.
    if (body.zone != null) saveZone(db, userId, isEnter ? body.zone : null);
    if (typeof body.lat === 'number' && typeof body.lng === 'number') {
      saveGps(db, userId, body.lat, body.lng, body.accuracy ?? body.gps_accuracy ?? null);
    }
    if (!isEnter) return c.json({ ok: true, matched: 0 });

    const visible = visibleItemIds(db, userId);
    const items = allItems(db).filter((i) => visible.has(i.id));
    const matched =
      body.zone != null
        ? tasksInZone(items, body.zone)
        : typeof body.lat === 'number' && typeof body.lng === 'number'
          ? tasksAtLocation(items, { lat: body.lat, lng: body.lng })
          : [];
    for (const t of matched) {
      await notifyTask(db, t.id, {
        title: body.zone ? `At ${body.zone}` : 'Nearby task',
        body: t.title || 'Untitled task',
        url: '/today',
        tag: `geo:${t.id}`,
      });
    }
    return c.json({ ok: true, matched: matched.length });
  });

  // The user's current location for the Nearby view: the HA zone plus one entry per
  // fresh device (≤24h). `haGps` is kept as a derived alias (the freshest HA device)
  // so an un-updated client still resolves; it will be dropped once clients roll over.
  api.get('/where', requireScope('tasks:read'), (c) => {
    const userId = c.get('userId');
    if (userId === 'local') return c.json({ zone: null, haGps: null, devices: [] });
    const base = getUserLocation(db, userId); // { zone, haGps } (legacy single-row)
    const devices = listDeviceLocations(db, userId, DEVICE_STALE_MS);
    return c.json({ ...base, devices });
  });

  // Remove one of the caller's devices (a retired phone). Own devices only.
  api.delete('/where/device/:id', requireScope('tasks:write'), (c) => {
    const userId = c.get('userId');
    if (userId === 'local') return c.json({ ok: true });
    deleteDeviceLocation(db, userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  // Map a Carbon user to a Home Assistant `person.*` entity. Unlike Settings →
  // HA person (which only maps the caller), this lets an admin wire up other
  // household members so one HA token can drive everyone's geofence/GPS reminders.
  // Token-usable (so HA automations / scripts can call it) but admin-gated:
  // requireAdmin rejects all token auth, so we check the role directly instead.
  // Body: { user: "<id|username>", person: "person.rachel" | null }.
  api.post('/ha-person', requireScope('tasks:write'), async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'admin only' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      user?: string;
      person?: string | null;
    };
    if (!body.user) return c.json({ error: 'user (id or username) required' }, 400);
    const target = getUser(db, body.user) ?? getUserByUsername(db, body.user);
    if (!target || target.deleted) return c.json({ error: 'user not found' }, 404);
    setHaPerson(db, target.id, body.person ?? null);
    return c.json({ ok: true, user: target.username, ha_person: getHaPerson(db, target.id) });
  });

  // ----- billing (auto-renewing subscriptions) --------------------------------
  // Tenant-admin actions. Reachable even when the workspace is locked (the dispatcher
  // allowlists /api/billing*) so an admin can self-serve a renewal from the gate.
  // Provider: 'square' when SQUARE_* is configured (real card-on-file auto-renew), else
  // 'simulate' (local pending→paid→renew→cancel lifecycle, no external charge).
  // The default/self-host tenant (id 'default') has no control-plane row → no billing.
  const billingProvider = () => (isSquareConfigured() ? 'square' : 'simulate');

  api.get('/billing', requireAdmin, (c) => {
    const rec = ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id);
    const provider = billingProvider();
    return c.json({
      provider,
      plans: listPlans(),
      expiresAt: rec?.expires_at ?? null,
      locked: rec ? tenantLockState(rec) === 'locked' : false,
      subscription: rec ? getSubscription(controlDb, ctx.id) : null,
      billingEmail: rec?.admin_email ?? null,
      square: provider === 'square' ? squareClientConfig() : null,
    });
  });

  // Start (or renew) a subscription. Square: needs a Web Payments SDK card token →
  // customer + card-on-file + subscription (auto-renews; expiry set by the webhook).
  // Simulate: records a pending subscription the client then "pays" via /billing/simulate.
  api.post('/billing/subscribe', requireAdmin, async (c) => {
    const rec = ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id);
    if (!rec) return c.json({ error: 'billing is not available for this workspace' }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      planId?: string;
      cardToken?: string;
      email?: string;
    };
    const plan = b.planId ? getPlan(b.planId) : undefined;
    if (!plan) return c.json({ error: 'unknown plan' }, 400);

    if (billingProvider() === 'square') {
      if (!b.cardToken) return c.json({ error: 'card token required' }, 400);
      // Square requires the customer to have an email (it emails invoices/receipts).
      // Use the workspace email if set, else the one supplied at subscribe time.
      const email = (rec.admin_email || b.email?.trim() || '').toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return c.json({ error: 'a billing email address is required' }, 400);
      }
      // Track which Square objects we created so the catch can compensate: Square
      // create* can succeed while a later step throws, orphaning live objects. (BILL-2)
      let newCustomerId: string | null = null;
      let cardCreated = false;
      let createdSubId: string | null = null;
      try {
        const existing = getSubscription(controlDb, ctx.id);
        let customerId = existing?.square_customer_id ?? null;
        if (customerId) {
          // Reused customer may predate having an email — make sure it has one now.
          await updateCustomer(customerId, { email, name: rec.display_name });
        } else {
          customerId = await createCustomer({ tenantId: ctx.id, email, name: rec.display_name });
          newCustomerId = customerId;
        }
        // Remember the email on the workspace for future receipts/renewals.
        if (!rec.admin_email) setTenantAdminEmail(controlDb, ctx.id, email);
        const cardId = await createCard(customerId, b.cardToken);
        cardCreated = true;
        const sub = await createSubscription({ customerId, cardId, planId: plan.id });
        createdSubId = sub.id;
        upsertSubscription(controlDb, ctx.id, {
          provider: 'square',
          status: sub.status === 'ACTIVE' ? 'active' : 'pending',
          plan_id: plan.id,
          external_id: sub.id,
          square_customer_id: customerId,
          square_subscription_id: sub.id,
          canceled_at: null,
        });
        // If Square already billed (charged_through_date present), reflect it now; else
        // the invoice.payment_made webhook will extend expiry shortly.
        if (sub.chargedThrough) {
          recordPaidPeriod(controlDb, ctx.id, plan, {
            provider: 'square',
            externalId: sub.id,
            chargedThrough: sub.chargedThrough,
            squareCustomerId: customerId,
            squareSubscriptionId: sub.id,
          });
        }
        return c.json({ ok: true, provider: 'square', status: sub.status, subscriptionId: sub.id }, 201);
      } catch (e) {
        console.error('[carbon] billing subscribe failed:', e);
        // Compensate for orphaned Square objects (BILL-2). If the subscription was
        // created but local persistence failed, cancel it — otherwise Square keeps
        // auto-renewing a subscription we have no record of. Customer/card can't be
        // rolled back as cleanly; log loudly so they can be reconciled by hand.
        if (createdSubId) {
          try {
            await cancelSubscription(createdSubId);
            console.error(
              `[carbon] billing subscribe: canceled orphaned Square subscription ${createdSubId} after local failure`,
            );
          } catch (ce) {
            console.error(
              `[carbon] billing subscribe: FAILED to cancel orphaned Square subscription ${createdSubId} — reconcile manually:`,
              ce,
            );
          }
        } else if (cardCreated || newCustomerId) {
          console.error(
            `[carbon] billing subscribe: left orphaned Square objects (customer=${newCustomerId ?? '(reused)'}, cardCreated=${cardCreated}) with no subscription — reconcile/clean up manually`,
          );
        }
        // Don't return the raw thrown message — it can carry Square error bodies. (API-3)
        return c.json({ error: 'subscribe_failed' }, 400);
      }
    }

    // Simulate provider: stage a pending subscription; the client confirms via /simulate.
    const externalId = `sim_${randomUUID()}`;
    upsertSubscription(controlDb, ctx.id, {
      provider: 'simulate',
      status: 'pending',
      plan_id: plan.id,
      external_id: externalId,
      canceled_at: null,
    });
    return c.json({ ok: true, provider: 'simulate', status: 'pending', subscriptionId: externalId }, 201);
  });

  // Dev/local only: stand in for the Square "invoice.payment_made" webhook so the
  // simulate provider's full pending→paid→renew flow is testable without Square.
  api.post('/billing/simulate', requireAdmin, async (c) => {
    if (billingProvider() !== 'simulate') {
      return c.json({ error: 'simulate is unavailable when a real payment provider is configured' }, 400);
    }
    const rec = ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id);
    if (!rec) return c.json({ error: 'billing is not available for this workspace' }, 400);
    const sub = getSubscription(controlDb, ctx.id);
    const plan = sub?.plan_id ? getPlan(sub.plan_id) : undefined;
    if (!sub || !plan) return c.json({ error: 'no subscription to charge — subscribe first' }, 400);
    const newExpiry = recordPaidPeriod(controlDb, ctx.id, plan, {
      provider: 'simulate',
      externalId: sub.external_id ?? `sim_${randomUUID()}`,
    });
    if (rec.admin_email) {
      void sendBillingReceipt(rec.admin_email, plan.label, newExpiry).catch((e) =>
        console.error('[carbon] billing receipt failed:', e),
      );
    }
    return c.json({ ok: true, expiresAt: newExpiry }, 201);
  });

  // Cancel: stop auto-renewal. Access remains until the current period end (expiry).
  api.post('/billing/cancel', requireAdmin, async (c) => {
    const rec = ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id);
    if (!rec) return c.json({ error: 'billing is not available for this workspace' }, 400);
    const sub = getSubscription(controlDb, ctx.id);
    if (!sub) return c.json({ error: 'no active subscription' }, 400);
    try {
      if (billingProvider() === 'square' && sub.square_subscription_id) {
        await cancelSubscription(sub.square_subscription_id);
      }
      setSubscriptionStatus(controlDb, ctx.id, 'canceled', { canceledAt: new Date().toISOString() });
      return c.json({ ok: true });
    } catch (e) {
      // Log the detail server-side; don't return it — a Square exception can carry
      // upstream error bodies the admin shouldn't see. (API-3)
      console.error('[carbon] billing cancel failed:', e);
      return c.json({ error: 'cancel_failed' }, 400);
    }
  });

  // Federation routes (Phase 2): mounted under /api/federation as their OWN sub-app
  // so the secret-authed inbound/confirm/sync routes bypass the tenant `api`'s global
  // basicAuth; the outbound /offers route re-applies basicAuth internally (sessionAuth)
  // to identify the human caller.
  const fedApi = federationRoutes({
    db,
    serverDeviceId,
    myLabel: ctx.subdomain || 'default',
    // Our externally-reachable base for an L3 callback: `https://<subdomain>.<apex>`.
    // Only meaningful on a multi-tenant host (BASE_DOMAIN set); unset for self-host.
    myBaseUrl: BASE_DOMAIN && ctx.subdomain ? `${ctx.subdomain}.${BASE_DOMAIN}` : undefined,
    resolveMode: () =>
      resolveFederationMode(ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id)),
    deliverToPeer,
    blobStore,
    sessionAuth: basicAuth(db, !BASE_DOMAIN),
  });

  const tenantApp = new Hono<Env>();
  tenantApp.route('/api', api);
  tenantApp.route('/api/federation', fedApi);
  // Catch-all for anything a tenant handler throws without its own try/catch: log the
  // full error server-side, return a generic 500 so no internal detail leaks. tenantApp
  // is a standalone fetch entry point (invoked via tApp.fetch in the /api dispatcher),
  // so it needs its own handler — the host app's onError never sees these. (API-4)
  tenantApp.onError((err, c) => {
    console.error('[carbon] unhandled tenant error:', err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return tenantApp;
}

// ----- host bootstrap: default tenant + control plane + registry -------------

mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(BLOBS_DIR, { recursive: true });

// Default (legacy) tenant — the single-tenant self-host DB. Pinned, never evicted.
const defaultCtx = initTenantDb({
  id: 'default',
  subdomain: '',
  dbPath: DB_PATH,
  blobsDir: BLOBS_DIR,
});
bootstrapUsers(defaultCtx.db, process.env.AUTH_USERS);

/** Whether federation's L3 transport may reach a private/loopback/LAN peer over
 *  HTTPS. `deliverToPeer` is a server-wide seam (it carries no per-request tenant
 *  identity), so we resolve the allowance globally, reusing the first two clauses of
 *  `agentsAllowPrivate`: single-tenant self-host always allows (a self-hoster
 *  federating to a Tailscale/LAN peer), and ALLOW_PRIVATE_AGENT_ENDPOINTS=1 forces it
 *  on globally. A public multi-tenant host stays SSRF-guarded — `cross_server` is the
 *  gated advanced tier there anyway, and private/loopback peers are refused. */
function federationAllowPrivate(): boolean {
  if (!BASE_DOMAIN) return true; // single-tenant self-host
  if (process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS === '1') return true; // global override
  return false;
}

/**
 * Same-host peer access for the directory route's mutual-whitelist gate: resolve a
 * peer subdomain to its LIVE tenant ctx via the registry and expose the two reads the
 * gate needs — whether the peer's whitelist contains US, and its human roster. Returns
 * null when the subdomain is not a loadable same-host tenant. A `function` declaration
 * (hoisted) so `buildTenantApp` below can reference it; `registry` is read lazily inside
 * the returned closures (they only run at request time, well after module init).
 */
function makeSameHostPeer(peerSubdomain: string): SameHostPeer | null {
  const peerCtx = registry.getCtx(peerSubdomain);
  if (!peerCtx) return null;
  const peerDb = peerCtx.db;
  return {
    // The peer→us half of mutuality: is one of OUR identities on the peer's ALLOW-list?
    // Matched on either our base_url or our subdomain label, the same shape the offer
    // gate's `peerWhitelisted` uses (peers may be stored by base_url OR subdomain). Deny
    // rows live in the same table but must not count as a whitelist ⇒ filter to 'allow'.
    hasWhitelisted: (myBaseUrl, myLabel) =>
      listPeers(peerDb, 'allow').some(
        (p) =>
          p.subdomain === myLabel ||
          p.subdomain === myBaseUrl ||
          p.base_url === myBaseUrl ||
          p.base_url === myLabel,
      ),
    // Humans only: non-deleted (listUsers), non-bot, and non-shadow (is_remote) — we do
    // not surface a peer's own mirrored remote users. Projected via the shared `publicUser`.
    roster: () =>
      listUsers(peerDb)
        .filter((u) => !u.is_bot && !u.is_remote)
        .map(publicUser),
  };
}

// The peer-delivery seam is built by `makeDeliverToPeer` (federation.ts): one code
// path for L2 (same-host in-process loopback) and L3 (cross-server HTTPS via safeFetch,
// SSRF-guarded unless allowPrivate). `registry` is referenced lazily below; this closure
// only runs at request time, well after module init, so the reference is safe.
const deliverToPeer: DeliverToPeer = makeDeliverToPeer({
  getApp: (subdomain) => registry.getApp(subdomain),
  baseDomain: BASE_DOMAIN,
  httpFetch: safeFetch,
  allowPrivate: federationAllowPrivate,
});

const defaultApp = buildTenantApp(defaultCtx, deliverToPeer);

const controlDb = openControlDb(CONTROL_DB_PATH);
bootstrapHostAdmins(controlDb, process.env.HOST_ADMINS);
// Telegram state (links, pending codes, FSM) is server-wide, so it lives in the control DB.
// Ensure the tables exist before any /api/telegram route can write a pairing code.
ensureTelegramTables(controlDb);

const registry = createTenantRegistry({
  defaultCtx,
  defaultApp,
  resolve: (subdomain) => resolveTenantLocation(controlDb, subdomain),
  listActive: () => listActiveTenants(controlDb),
  buildApp: (ctx) => buildTenantApp(ctx, deliverToPeer),
  cap: Number(process.env.TENANT_CACHE_CAP ?? 200),
});

// Federation exchange sweep and the "completed items piling up" nudge both piggyback
// the reminder-sweep tick (no competing timer). Federation runs one bidirectional
// exchange round for every active link across active tenant DBs; same-host
// both-tenants-in-one-process is fine (deliverToPeer loops back). The purge-suggestion
// check is synchronous per-tenant and runs first since it's cheap and unrelated.
startReminderScheduler(
  () => registry.activeDbs(),
  () => {
    for (const ctx of registry.activeCtxs()) {
      try {
        checkPurgeSuggestions(ctx.db, ctx.serverDeviceId);
      } catch (e) {
        console.error('[carbon] purge-suggestion sweep failed:', e);
      }
    }
    return runAllFederationExchanges(
      () => registry.activeCtxs().map((ctx) => ({ db: ctx.db, myLabel: ctx.subdomain || 'default' })),
      deliverToPeer,
    );
  },
);
startGpsScheduler(() => registry.activeDbs());
startCaldavScheduler(() =>
  registry.activeCtxs().map((ctx) => ({
    db: ctx.db,
    deviceId: ensureCaldavDeviceId(ctx.db),
    allowPrivate: agentsAllowPrivate(ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id)),
  })),
);

// Per-server Telegram bot: confirm the token, register the webhook, and expose the handler the
// /telegram/webhook route calls. Fire-and-forget (getMe/setWebhook are network calls); no-ops
// when TELEGRAM_BOT_TOKEN is unset.
startTelegramBot({
  controlDb,
  registry,
  botToken: TELEGRAM_BOT_TOKEN,
  botUsername: TELEGRAM_BOT_USERNAME,
  baseDomain: BASE_DOMAIN,
  webhookUrl: TELEGRAM_WEBHOOK_URL,
  webhookSecret: TELEGRAM_WEBHOOK_SECRET,
  resolveSubdomain: (sub) => resolveTenantLocation(controlDb, sub)?.subdomain ?? null,
  allowPrivateFor: (tenantId) =>
    agentsAllowPrivate(tenantId === 'default' ? null : getTenantById(controlDb, tenantId)),
  hostLmAvailableFor: (tenantId) =>
    tenantId === 'default' ? true : !!getTenantById(controlDb, tenantId)?.host_lm_available,
})
  .then((bot) => {
    telegramBot = bot;
  })
  .catch((e) => console.error('[carbon] telegram bot failed to start:', e));

// Lock is derived (no write fires at expiry — the dispatcher recomputes per request),
// so the only control-plane housekeeping is GCing expired pending signups. Hourly.
setInterval(() => {
  try {
    gcPendingSignups(controlDb);
    gcPendingDeletes(controlDb);
  } catch (e) {
    console.error('[carbon] pending-signup gc failed:', e);
  }
}, 3_600_000);

console.log(
  `[carbon] default db=${DB_PATH} users=${listUsers(defaultCtx.db).length} ` +
    `tenants=${listTenants(controlDb).length} base=${BASE_DOMAIN ?? '(single-tenant)'}`,
);

// BILL-4: with no Square config, billingProvider() falls back to 'simulate', where a
// workspace admin can self-grant paid periods via /billing/simulate. That's intended for
// self-hosters, but on a production multi-tenant host it means billing isn't actually
// charging anyone. Warn loudly (don't hard-fail — self-host is a legitimate config).
if (
  (process.env.NODE_ENV === 'production' || process.env.ENV === 'production') &&
  !isSquareConfigured()
) {
  console.warn(
    '[carbon] WARNING: running in production but SQUARE_* is unconfigured — billing is in ' +
      "'simulate' mode, so workspace admins can self-grant paid periods via /billing/simulate. " +
      'Configure the Square provider (SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_APP_ID, ' +
      'SQUARE_PLAN_Q3M, SQUARE_PLAN_Y1) to take real payments.',
  );
}

// ----- host app: CORS, health, control plane, tenant dispatch ----------------

const app = new Hono();

// Catch-all for anything a host-level handler (or the mounted `host` sub-app) throws
// without its own try/catch: log the full error server-side, return a generic 500 so no
// internal detail leaks to the client. `app` is the top-level fetch entry point. (API-4)
app.onError((err, c) => {
  console.error('[carbon] unhandled server error:', err);
  return c.json({ error: 'internal_error' }, 500);
});

// CORS: defaults to wildcard (auth is via the Authorization header, not cookies,
// so there is no CSRF surface). Set CORS_ORIGINS to a comma-separated allowlist to
// lock it down — native shells send these origins:
//   Tauri  → tauri://localhost (Linux/macOS), http://tauri.localhost (Windows)
//   Capacitor Android → https://localhost
//   dev → http://localhost:3042
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const corsMw = cors({ origin: corsOrigins.length ? corsOrigins : '*' });
app.use('/api/*', corsMw);
app.use('/host/*', corsMw);

// Health is host-level; also used by the web client to (a) auto-discover its sync
// server from window.location.origin and (b) learn whether this host is the apex
// (landing page), a real tenant workspace, or an unknown subdomain.
app.get('/api/health', (c) => {
  let role: 'single' | 'apex' | 'app' | 'tenant' | 'unknown' = 'single';
  // Lock/expiry are surfaced (unauthenticated) so the SPA can render a renew gate for a
  // locked workspace. Only these two fields are exposed here — never subscription/email.
  let locked = false;
  let expiresAt: string | null = null;
  if (BASE_DOMAIN) {
    const label = hostLabel(c.req.header('host'), BASE_DOMAIN);
    if (label === null) role = 'apex'; // the bare apex
    else if (label === APP_HOST) role = 'app'; // dedicated offline/local-only host
    else if (RESERVED_SUBDOMAINS.has(label)) role = 'apex'; // www/admin/… → landing
    else {
      // resolveTenantLocation only resolves active/provisional, so a suspended tenant
      // still reads as 'unknown' (hard off). A locked tenant is active → 'tenant'.
      role = resolveTenantLocation(controlDb, label) ? 'tenant' : 'unknown';
      if (role === 'tenant') {
        const rec = getTenantBySubdomain(controlDb, label);
        if (rec) {
          locked = tenantLockState(rec) === 'locked';
          expiresAt = rec.expires_at;
        }
      }
    }
  }
  return c.json({
    status: 'ok',
    version: VERSION,
    name: 'carbon',
    baseDomain: BASE_DOMAIN ?? null,
    appHost: BASE_DOMAIN ? APP_HOST : null,
    role,
    locked,
    expiresAt,
  });
});

// ----- control plane: /host/* (signup public; rest host-admin-guarded) -------

const tenantUrl = (subdomain: string) =>
  BASE_DOMAIN ? `https://${subdomain}.${BASE_DOMAIN}` : `(set BASE_DOMAIN) /${subdomain}`;

// In-memory signup rate limit. Per-IP keys on clientIp() (the last, proxy-appended
// X-Forwarded-For hop — the only non-spoofable one); the global cap is the backstop if
// a caller still manages to vary their apparent IP. Stale buckets are pruned each call
// so the map can't grow without bound (A6).
const signupHits = new Map<string, number[]>();
let globalSignups: number[] = [];
const SIGNUP_PER_IP_HOUR = 5;
const SIGNUP_GLOBAL_HOUR = Math.max(1, Number(process.env.SIGNUP_GLOBAL_HOUR) || 50);
function signupAllowed(ip: string): boolean {
  const now = Date.now();
  const win = now - 3_600_000;
  for (const [k, v] of signupHits) {
    const fresh = v.filter((t) => t > win);
    if (fresh.length) signupHits.set(k, fresh);
    else signupHits.delete(k);
  }
  globalSignups = globalSignups.filter((t) => t > win);
  if (globalSignups.length >= SIGNUP_GLOBAL_HOUR) return false;
  const hits = signupHits.get(ip) ?? [];
  if (hits.length >= SIGNUP_PER_IP_HOUR) return false;
  hits.push(now);
  signupHits.set(ip, hits);
  globalSignups.push(now);
  return true;
}

// Narrower per-email cap on /signup/start so one address can't be code-bombed, plus a
// lenient per-IP cap on /signup/verify to bound brute-forcing the 6-digit code space.
const emailStartHits = new Map<string, number[]>();
const SIGNUP_PER_EMAIL_HOUR = Math.max(1, Number(process.env.SIGNUP_PER_EMAIL_HOUR) || 3);
const verifyHits = new Map<string, number[]>();
const VERIFY_PER_IP_HOUR = Math.max(1, Number(process.env.VERIFY_PER_IP_HOUR) || 30);

// Deletion OTC: a per-workspace cap on requesting a code (can't code-bomb a contact
// address) and a per-IP cap on verifying it (bounds brute-forcing the 6-digit code).
const deleteStartHits = new Map<string, number[]>();
const DELETE_START_PER_WS_HOUR = Math.max(1, Number(process.env.DELETE_START_PER_WS_HOUR) || 3);
const deleteVerifyHits = new Map<string, number[]>();
const DELETE_VERIFY_PER_IP_HOUR = Math.max(1, Number(process.env.DELETE_VERIFY_PER_IP_HOUR) || 30);

// Per-user cap on the LLM-backed NL command endpoint (each call = up to MAX_ITERS
// provider round-trips). Keyed on the resolved user id, not IP.
const nlCommandHits = new Map<string, number[]>();
const NL_COMMAND_PER_USER_HOUR = Math.max(1, Number(process.env.NL_COMMAND_PER_USER_HOUR) || 120);
function hitAllowed(map: Map<string, number[]>, key: string, cap: number): boolean {
  const now = Date.now();
  const win = now - 3_600_000;
  for (const [k, v] of map) {
    const fresh = v.filter((t) => t > win);
    if (fresh.length) map.set(k, fresh);
    else map.delete(k);
  }
  const hits = map.get(key) ?? [];
  if (hits.length >= cap) return false;
  hits.push(now);
  map.set(key, hits);
  return true;
}

// Client IP for per-IP rate limits. X-Forwarded-For is a client-controllable list —
// a caller can prepend arbitrary hops — so the FIRST hop is spoofable. Only the LAST
// hop is trustworthy: it's the peer address our own nginx reverse proxy appends. Use
// that (fallback 'unknown' when the header is absent). (A?/API-2)
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (!xff) return 'unknown';
  const hops = xff.split(',');
  return hops[hops.length - 1].trim() || 'unknown';
}

const host = new Hono<{ Variables: HostVars }>();

// ----- Square webhooks (public, HMAC-verified) ------------------------------
// One global endpoint for all tenants; the tenant is resolved from the subscription
// id carried by the event. Must be reachable at exactly SQUARE_WEBHOOK_URL (the URL is
// part of the HMAC). Not behind host-admin auth — Square authenticates via the signature.

function tenantBySquareSub(subscriptionId: string): string | null {
  return (
    controlDb.get<{ tenant_id: string }>(
      'SELECT tenant_id FROM subscriptions WHERE square_subscription_id = ?',
      [subscriptionId],
    )?.tenant_id ?? null
  );
}

// Returns false when the subscription id maps to no known tenant — the caller must NOT
// mark the event processed in that case, so Square keeps retrying (the mapping may just
// not have been persisted yet by a racing /billing/subscribe). Returns true once the
// paid period has been applied (or the event is safely ignorable for a known tenant).
async function applySquareInvoicePaid(subscriptionId: string): Promise<boolean> {
  const tenantId = tenantBySquareSub(subscriptionId);
  if (!tenantId) return false; // unknown subscription — signal retry, don't lose it
  const sub = await retrieveSubscription(subscriptionId);
  const planId = (sub.planVariationId && planForVariation(sub.planVariationId)) ||
    getSubscription(controlDb, tenantId)?.plan_id ||
    '';
  const plan = getPlan(planId);
  if (!plan) {
    console.error(`[carbon] webhook: no plan for subscription ${subscriptionId} (variation ${sub.planVariationId})`);
    return true; // known tenant, unmappable plan — retrying won't help; treat as handled
  }
  // chargedThrough makes this idempotent: re-processing sets expiry to the same date.
  const newExpiry = recordPaidPeriod(controlDb, tenantId, plan, {
    provider: 'square',
    externalId: subscriptionId,
    chargedThrough: sub.chargedThrough,
    squareSubscriptionId: subscriptionId,
  });
  const rec = getTenantById(controlDb, tenantId);
  if (rec?.admin_email) {
    void sendBillingReceipt(rec.admin_email, plan.label, newExpiry).catch((e) =>
      console.error('[carbon] billing receipt failed:', e),
    );
  }
  return true;
}

host.post('/billing/webhook', async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header('x-square-hmacsha256-signature');
  if (!verifyWebhookSignature(raw, sig)) return c.json({ error: 'bad signature' }, 401);
  let event: {
    event_id?: string;
    type?: string;
    data?: { object?: { invoice?: { subscription_id?: string }; subscription?: { id?: string; status?: string } } };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  const eventId = event.event_id;
  const type = event.type ?? '';
  if (!eventId) return c.json({ error: 'no event id' }, 400);
  // Dedup BEFORE running any side effect: if we've already recorded this event_id, it's
  // a Square retry of something we finished — ack 200 and do nothing. (BILL-3)
  if (billingEventSeen(controlDb, eventId)) return c.json({ ok: true });
  const obj = event.data?.object ?? {};
  try {
    if (type === 'invoice.payment_made') {
      const subId = obj.invoice?.subscription_id;
      // applySquareInvoicePaid returns false when the subscription maps to no known
      // tenant — do NOT mark the event; return 5xx so Square retries rather than
      // permanently dropping a paid invoice for a not-yet-persisted subscription. (BILL-1)
      if (subId && !(await applySquareInvoicePaid(subId))) {
        console.error(`[carbon] webhook: paid invoice for unknown subscription ${subId} — asking Square to retry`);
        return c.json({ error: 'unknown subscription' }, 503); // 5xx → Square retries
      }
    } else if (type === 'invoice.payment_failed') {
      const tId = obj.invoice?.subscription_id ? tenantBySquareSub(obj.invoice.subscription_id) : null;
      if (tId) setSubscriptionStatus(controlDb, tId, 'past_due');
    } else if (type === 'subscription.updated') {
      const s = obj.subscription;
      if (s?.id && (s.status === 'CANCELED' || s.status === 'DEACTIVATED')) {
        const tId = tenantBySquareSub(s.id);
        if (tId) setSubscriptionStatus(controlDb, tId, 'canceled', { canceledAt: new Date().toISOString() });
      }
    }
    // Mark only after successful handling so a transient failure (thrown above, or the
    // unknown-subscription early return) lets Square retry the same event_id. The pre-
    // check above makes a genuine retry a no-op; recordPaidPeriod stays idempotent
    // (absolute expiry) as a second line of defence against a rare race.
    markBillingEvent(controlDb, eventId, type);
  } catch (e) {
    console.error('[carbon] webhook handling failed:', e);
    return c.json({ error: 'handling failed' }, 500); // 5xx → Square retries
  }
  return c.json({ ok: true });
});

// Self-service signup, step 1: stage the workspace + email a one-time code. The tenant
// is NOT created yet — only on /signup/verify once the email is proven.
host.post('/signup/start', async (c) => {
  const ip = clientIp(c);
  if (!signupAllowed(ip)) return c.json({ error: 'too many signups, try later' }, 429);
  const b = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    subdomain?: string;
    adminUsername?: string;
    adminPassword?: string;
    displayName?: string;
  };
  const email = b.email?.trim().toLowerCase() || '';
  if (!email) return c.json({ error: 'email required' }, 400);
  if (!b.adminUsername || !b.adminPassword) {
    return c.json({ error: 'adminUsername and adminPassword required' }, 400);
  }
  if (!hitAllowed(emailStartHits, email, SIGNUP_PER_EMAIL_HOUR)) {
    return c.json({ error: 'too many codes requested for this email, try later' }, 429);
  }
  try {
    const { code } = createPendingSignup(controlDb, {
      email,
      subdomain: b.subdomain,
      displayName: b.displayName,
      adminUsername: b.adminUsername,
      adminPassword: b.adminPassword,
    });
    await sendOtcCode(email, code);
    return c.json({ pending: true, email }, 201);
  } catch (e) {
    // Log the detail server-side; return a stable code — the thrown message can carry
    // internal (e.g. email-provider) error bodies. (API-3)
    console.error('[carbon] signup/start failed:', e);
    return c.json({ error: 'signup_failed' }, 400);
  }
});

// Self-service signup, step 2: verify the code, then provision the workspace with a
// trial expiry. The pending row is kept if provisioning fails so the user can retry.
host.post('/signup/verify', async (c) => {
  const ip = clientIp(c);
  if (!hitAllowed(verifyHits, ip, VERIFY_PER_IP_HOUR)) {
    return c.json({ error: 'too many attempts, try later' }, 429);
  }
  const b = (await c.req.json().catch(() => ({}))) as { email?: string; code?: string };
  if (!b.email || !b.code) return c.json({ error: 'email and code required' }, 400);
  const result = verifyPendingSignup(controlDb, b.email, String(b.code));
  if (!result.ok) return c.json({ error: result.error }, 400);
  const p = result.pending;
  try {
    const rec = provisionTenant(controlDb, TENANTS_DIR, {
      subdomain: p.subdomain ?? undefined,
      adminUsername: p.admin_username,
      adminPasswordHash: p.password_hash,
      displayName: p.display_name ?? undefined,
      adminEmail: p.email,
      // SIGNUP_REQUIRE_APPROVAL=1 holds new workspaces in 'provisional' until a host
      // admin/payment hook flips them to 'active' (still routable, seam for billing).
      status: process.env.SIGNUP_REQUIRE_APPROVAL === '1' ? 'provisional' : 'active',
      expiresAt: new Date(Date.now() + SIGNUP_TRIAL_DAYS * 86_400_000).toISOString(),
    });
    deletePendingSignup(controlDb, p.id);
    return c.json({ subdomain: rec.subdomain, url: tenantUrl(rec.subdomain), status: rec.status }, 201);
  } catch (e) {
    // Keep the pending row so the user can retry (e.g. pick a free subdomain). Log the
    // detail server-side; return a stable code rather than the raw thrown message. (API-3)
    console.error('[carbon] signup/verify provisioning failed:', e);
    return c.json({ error: 'provision_failed' }, 400);
  }
});

// ----- self-service workspace deletion (public, email-OTC verified) ----------
// Reachable without a session: identity is proven by receiving the workspace's
// contact email, not by being signed in. Mirrors the signup OTC flow in reverse.

/** Resolve a deletable workspace whose contact email matches `email`, else null.
 *  The default/self-host tenant has no control-plane row, so it is never deletable. */
function deletableTenant(workspace: string, email: string): TenantRecord | null {
  const sub = workspace.trim().toLowerCase();
  if (!sub) return null;
  const rec = getTenantBySubdomain(controlDb, sub);
  if (!rec || rec.status === 'deleted') return null;
  if (!rec.admin_email || rec.admin_email.trim().toLowerCase() !== email.trim().toLowerCase()) {
    return null;
  }
  return rec;
}

/** Build the portable `carbon-backup` bundle for a workspace: the SQLite bytes plus
 *  every attachment blob, base64-encoded — the same format the web Import accepts. */
function buildWorkspaceBundle(rec: TenantRecord): string {
  // Fold the WAL into the main db file so the on-disk bytes are current before we read
  // them (the tenant may have unflushed writes). Best-effort: skip if not loadable.
  try {
    registry.getCtx(rec.subdomain)?.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* not loaded / locked — fall back to whatever is on disk */
  }
  const blobs: Record<string, string> = {};
  try {
    for (const name of readdirSync(rec.blobs_dir)) {
      try {
        blobs[name] = readFileSync(join(rec.blobs_dir, name)).toString('base64');
      } catch {
        /* file vanished mid-scan — skip */
      }
    }
  } catch {
    /* no blobs dir yet */
  }
  return JSON.stringify({
    format: 'carbon-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    db: readFileSync(rec.db_path).toString('base64'),
    blobs,
  });
}

// Step 1: stage a deletion + email a one-time code — but only if the workspace exists
// and the supplied email is its contact address. Always answers 200 with the same
// generic body so the endpoint can't be used to probe which workspaces/emails exist.
host.post('/delete/start', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { workspace?: string; email?: string };
  const workspace = (b.workspace ?? '').trim().toLowerCase();
  const email = (b.email ?? '').trim().toLowerCase();
  const generic = { ok: true } as const;
  if (!workspace || !email) return c.json({ error: 'workspace and email required' }, 400);
  if (!hitAllowed(deleteStartHits, workspace, DELETE_START_PER_WS_HOUR)) {
    return c.json({ error: 'too many codes requested for this workspace, try later' }, 429);
  }
  const rec = deletableTenant(workspace, email);
  if (!rec) return c.json(generic); // no match — say nothing, send nothing
  try {
    const { code } = createPendingDelete(controlDb, { tenantId: rec.id, email: rec.admin_email! });
    await sendDeleteOtcCode(rec.admin_email!, code, rec.subdomain);
  } catch (e) {
    console.error('[carbon] delete/start failed:', e);
  }
  return c.json(generic);
});

// Step 2: verify the code, returning a short-lived token that authorizes the export
// and the final delete. The workspace+email must still match (the code alone is scoped
// to the tenant, but re-checking keeps the contract obvious and tolerates email reuse).
host.post('/delete/verify', async (c) => {
  const ip = clientIp(c);
  if (!hitAllowed(deleteVerifyHits, ip, DELETE_VERIFY_PER_IP_HOUR)) {
    return c.json({ error: 'too many attempts, try later' }, 429);
  }
  const b = (await c.req.json().catch(() => ({}))) as {
    workspace?: string;
    email?: string;
    code?: string;
  };
  if (!b.workspace || !b.email || !b.code) {
    return c.json({ error: 'workspace, email and code required' }, 400);
  }
  const rec = deletableTenant(b.workspace, b.email);
  if (!rec) return c.json({ error: 'invalid code' }, 400);
  const result = verifyPendingDelete(controlDb, rec.id, String(b.code));
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ token: result.token });
});

// Download a full backup of the workspace. Authorized by the verified delete token, so
// the same proof-of-email that allows deletion lets the owner take their data first.
host.post('/delete/export', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { token?: string };
  const row = resolveDeleteToken(controlDb, b.token ?? '');
  if (!row) return c.json({ error: 'session expired — request a new code' }, 401);
  const rec = getTenantById(controlDb, row.tenant_id);
  if (!rec || rec.status === 'deleted') return c.json({ error: 'workspace not found' }, 404);
  const bundle = buildWorkspaceBundle(rec);
  return new Response(bundle, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="carbon-${rec.subdomain}-backup.json"`,
    },
  });
});

// Step 3: permanently delete the workspace (and its data dir). Irreversible.
host.post('/delete/confirm', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { token?: string };
  const row = resolveDeleteToken(controlDb, b.token ?? '');
  if (!row) return c.json({ error: 'session expired — request a new code' }, 401);
  const rec = getTenantById(controlDb, row.tenant_id);
  deletePendingDelete(controlDb, row.id);
  if (!rec || rec.status === 'deleted') return c.json({ ok: true }); // already gone
  registry.evict(rec.id); // close the open handle before removing files
  deleteTenant(controlDb, rec.id);
  return c.json({ ok: true });
});

host.use('/tenants', hostAdminAuth(controlDb));
host.use('/tenants/*', hostAdminAuth(controlDb));

host.get('/tenants', (c) =>
  c.json({
    tenants: listTenants(controlDb).map((t) => ({ ...t, url: tenantUrl(t.subdomain) })),
  }),
);

host.post('/tenants', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as {
    subdomain?: string;
    adminUsername?: string;
    adminPassword?: string;
    displayName?: string;
    plan?: string;
  };
  if (!b.adminUsername || !b.adminPassword) {
    return c.json({ error: 'adminUsername and adminPassword required' }, 400);
  }
  try {
    const rec = provisionTenant(controlDb, TENANTS_DIR, {
      subdomain: b.subdomain,
      adminUsername: b.adminUsername,
      adminPassword: b.adminPassword,
      displayName: b.displayName,
      plan: b.plan,
    });
    return c.json({ ...rec, url: tenantUrl(rec.subdomain) }, 201);
  } catch (e) {
    // Log the detail server-side; return a stable code rather than the raw thrown
    // message (avoids leaking internal provisioning errors). (API-3)
    console.error('[carbon] tenant provisioning failed:', e);
    return c.json({ error: 'provision_failed' }, 400);
  }
});

host.patch('/tenants/:id', async (c) => {
  const id = c.req.param('id');
  if (!getTenantById(controlDb, id)) return c.json({ error: 'not found' }, 404);
  const b = (await c.req.json().catch(() => ({}))) as {
    status?: 'active' | 'provisional' | 'suspended';
    plan?: string | null;
    expiresAt?: string | null; // "Set Expiry" — when the workspace locks (null = never)
    locked?: boolean; // "Lock"/"Unlock" — manual operator lock (soft gate, still resolves)
    blobQuotaMb?: number | null; // storage cap in MB (null = server default, 0 = unlimited)
    maxUsers?: number | null; // human-user cap (null = server default, 0 = unlimited)
    allowPrivateEndpoints?: boolean; // let this workspace's agents reach private/LAN hosts
    hostLmAvailable?: boolean; // let this workspace select the host-shared LM
    federationMode?: 'off' | 'intra_server' | 'cross_server' | null; // Gate 1 override (null = env default)
  };
  if (b.status) {
    setTenantStatus(controlDb, id, b.status);
    if (b.status === 'suspended') registry.evict(id); // stop serving immediately
    // Note: a locked tenant is NOT evicted — it must stay loadable to serve the gate.
  }
  if ('plan' in b) setTenantPlan(controlDb, id, b.plan ?? null);
  if ('expiresAt' in b) setTenantExpiry(controlDb, id, b.expiresAt ?? null);
  if ('locked' in b) setTenantLock(controlDb, id, !!b.locked);
  if ('blobQuotaMb' in b) {
    setTenantBlobQuota(
      controlDb,
      id,
      b.blobQuotaMb == null ? null : Math.max(0, Math.round(b.blobQuotaMb)) * 1024 * 1024,
    );
  }
  if ('maxUsers' in b) {
    setTenantMaxUsers(controlDb, id, b.maxUsers == null ? null : Math.max(0, Math.round(b.maxUsers)));
  }
  if ('allowPrivateEndpoints' in b) {
    setTenantAllowPrivate(controlDb, id, !!b.allowPrivateEndpoints);
  }
  if ('hostLmAvailable' in b) {
    setTenantHostLmAvailable(controlDb, id, !!b.hostLmAvailable);
  }
  if ('federationMode' in b) {
    const m = b.federationMode;
    setTenantFederationMode(
      controlDb,
      id,
      m === 'off' || m === 'intra_server' || m === 'cross_server' ? m : null,
    );
  }
  return c.json({ ...getTenantById(controlDb, id) });
});

host.delete('/tenants/:id', (c) => {
  const id = c.req.param('id');
  if (!getTenantById(controlDb, id)) return c.json({ error: 'not found' }, 404);
  registry.evict(id); // close the open handle before removing files
  deleteTenant(controlDb, id);
  return c.json({ ok: true });
});

host.get('/tenants/:id/usage', (c) => {
  const id = c.req.param('id');
  const rec = getTenantById(controlDb, id);
  if (!rec) return c.json({ error: 'not found' }, 404);
  const ctx = registry.getCtx(rec.subdomain);
  const users = ctx ? listUsers(ctx.db).length : 0;
  const humanUsers = ctx ? listUsers(ctx.db).filter((u) => !u.is_bot).length : 0;
  const lastActivity = ctx
    ? (ctx.db.get<{ m: string | null }>('SELECT MAX(updated_at) AS m FROM items')?.m ?? null)
    : null;
  let dbBytes = 0;
  try {
    dbBytes = statSync(rec.db_path).size;
  } catch {
    /* file may not exist yet */
  }
  const blobBytes = blobsDirBytes(rec.blobs_dir);
  return c.json({
    id,
    subdomain: rec.subdomain,
    users,
    humanUsers,
    maxUsers: effectiveMaxUsers(rec),
    dbBytes,
    lastActivity,
    blobBytes,
    blobQuota: effectiveBlobQuota(rec),
  });
});

app.route('/host', host);

// ----- Telegram webhook (per-server, outside tenant dispatch) ----------------
// Telegram POSTs updates here. The bot maps the chat → (workspace, user) via the control DB,
// so this is a single server-level endpoint, not per-subdomain. Verify the secret token header
// (only Telegram knows it) and always answer 200 fast — work happens in the handler.
app.post('/telegram/webhook', async (c) => {
  if (TELEGRAM_WEBHOOK_SECRET) {
    const got = c.req.header('x-telegram-bot-api-secret-token');
    if (got !== TELEGRAM_WEBHOOK_SECRET) return c.json({ error: 'forbidden' }, 403);
  }
  if (!telegramBot) return c.json({ ok: true }); // bot disabled / not ready yet — Telegram retries
  const update = await c.req.json().catch(() => null);
  if (update) {
    // Don't make Telegram wait on the LLM round-trip; process after responding.
    void telegramBot.handle(update).catch((e) => console.error('[carbon] telegram handle error:', e));
  }
  return c.json({ ok: true });
});

// ----- tenant dispatch: forward /api/* to the per-subdomain tenant app -------

app.all('/api/*', async (c) => {
  const subdomain = subdomainFromHost(c.req.header('host'), BASE_DOMAIN);
  // Lock gate (soft): a locked workspace still resolves and serves reads + billing so
  // the admin can renew, but every mutation/sync is refused. Checked here (not inside
  // the cached tenant app) because lock state is time-varying and lives in control.db.
  // The default tenant (subdomain === null) has no control-plane row and never locks.
  if (subdomain !== null) {
    const rec = getTenantBySubdomain(controlDb, subdomain);
    if (rec && tenantLockState(rec) === 'locked') {
      const path = c.req.path;
      const isBilling = path === '/api/billing' || path.startsWith('/api/billing/');
      if (!isBilling && c.req.method !== 'GET') {
        return c.json({ error: 'workspace_locked', expiresAt: rec.expires_at }, 403);
      }
    }
  }
  const tApp = registry.getApp(subdomain);
  if (!tApp) return c.json({ error: 'unknown workspace' }, 404);
  return tApp.fetch(c.req.raw);
});

// ----- static SPA -----------------------------------------------------------

const staticRoot = resolve(STATIC_DIR);
if (existsSync(staticRoot)) {
  app.use('/*', serveStatic({ root: STATIC_DIR }));
  app.get('/*', serveStatic({ path: `${STATIC_DIR}/index.html` }));
  console.log(`[carbon] serving web from ${staticRoot}`);
}

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[carbon] listening on http://localhost:${info.port}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[carbon] port ${PORT} is already in use — another Carbon server is probably running. ` +
        `Stop it, or set PORT to a free port.`,
    );
    process.exit(1);
  }
  throw err;
});
