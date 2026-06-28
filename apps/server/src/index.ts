import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  migrate,
  ensureDeviceId,
  ingestOps,
  ingestRecordOps,
  visibleItemIds,
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
} from './agents';
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
  deleteTenant,
  provisionTenant,
  validateSubdomain,
  tenantLockState,
  createPendingSignup,
  verifyPendingSignup,
  deletePendingSignup,
  gcPendingSignups,
  type HostVars,
  type TenantRecord,
} from './control';
import { sendOtcCode, sendBillingReceipt } from './email';
import { listPlans, getPlan, extendExpiry, getSubscription } from './billing';

const PORT = Number(process.env.PORT ?? 3069);
const DB_PATH = resolve(process.env.DATABASE_PATH ?? './data/carbon.db');
const BLOBS_DIR = resolve(process.env.BLOBS_DIR ?? join(dirname(DB_PATH), 'blobs'));
const STATIC_DIR = process.env.STATIC_DIR ?? '../web/dist';
const VERSION = '0.1.0';
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

function buildTenantApp(ctx: TenantCtx): FetchApp {
  const { db, serverDeviceId, vapidPublicKey } = ctx;
  const BLOBS_DIR = ctx.blobsDir;

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
    const user = createUser(db, {
      username: body.username,
      displayName: body.displayName ?? body.username,
      role: body.role ?? 'member',
      isBot: body.isBot ?? false,
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
    };
    updateUser(db, id, {
      ...(body.displayName !== undefined ? { display_name: body.displayName } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
    });
    if (body.password) setPassword(db, id, hashPassword(body.password));
    return c.json(publicUser(getUser(db, id)!));
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
    if (!open && Array.isArray(body.ops)) body.ops = sanitizeOps(db, userId, body.ops);
    if (Array.isArray(body.ops) && body.ops.length) ingestOps(db, body.ops, true);
    if (!open && Array.isArray(body.recordOps))
      body.recordOps = sanitizeRecordOps(db, userId, body.recordOps);
    if (Array.isArray(body.recordOps) && body.recordOps.length) {
      const fresh = ingestRecordOps(db, body.recordOps, true);
      triggerAgents(db, serverDeviceId, fresh); // @mention / assignment -> agent run
    }

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
      const subtree = new Set<string>();
      const queue = body.need.filter((id) => typeof id === 'string' && visible!.has(id));
      queue.forEach((id) => subtree.add(id));
      while (queue.length) {
        const parent = queue.shift()!;
        for (const k of db.all<{ id: string }>('SELECT id FROM items WHERE parent_id = ?', [parent])) {
          if (!subtree.has(k.id)) {
            subtree.add(k.id);
            queue.push(k.id);
          }
        }
      }
      if (subtree.size) {
        const seenOps = new Set(ops.map((o) => o.id));
        for (const r of db.all<OpRow>(
          'SELECT rowid AS seq, id, item_id, ts, device_id, fields FROM ops ORDER BY rowid',
        )) {
          if (!subtree.has(r.item_id) || seenOps.has(r.id)) continue;
          ops.push({
            id: r.id,
            item_id: r.item_id,
            ts: Number(r.ts),
            device_id: r.device_id,
            fields: JSON.parse(r.fields),
          });
        }
        const seenRecs = new Set(recordOps.map((o) => o.id));
        for (const r of db.all<RecRow>(
          'SELECT rowid AS seq, id, entity, row_id, ts, device_id, data FROM record_ops ORDER BY rowid',
        )) {
          if (seenRecs.has(r.id)) continue;
          const data = JSON.parse(r.data) as { item_id?: string };
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
    if (rows.length === 0) return false;
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
    return false;
  }

  api.get('/blobs/:hash', (c) => {
    const hash = c.req.param('hash');
    if (!isHash(hash)) return c.json({ error: 'bad hash' }, 400);
    // 404 (not 403) on no-access so the response never confirms a blob exists.
    if (!canReadBlob(c.get('userId'), hash)) return c.json({ error: 'not found' }, 404);
    const path = join(BLOBS_DIR, hash);
    if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
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
    ] as const;
    for (const k of fields) if (k in b) (patch as Record<string, unknown>)[k] = b[k];
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

  api.get('/admin/agents', requireAdmin, (c) => c.json({ agents: listAgents(db) }));

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
    const result = await testAgent(db, c.req.param('id'));
    return c.json(result);
  });

  api.delete('/admin/agents/:id', requireAdmin, (c) => {
    const agent = getAgent(db, c.req.param('id'));
    deleteAgent(db, c.req.param('id'));
    if (agent) softDeleteUser(db, agent.user_id);
    return c.json({ ok: true });
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

  // ----- GPS location feed (HA device-tracker tick) ---------------------------
  // Accepts a person's current GPS coordinates from HA.  HA should POST this
  // on a regular cadence (e.g. every 5 minutes) while the person is detected.
  // Carbon stores the latest position and uses it for proximity-based reminders.
  api.post('/gps', requireScope('tasks:write'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      person?: string;
      lat?: number;
      lng?: number;
    };
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number') {
      return c.json({ error: 'lat and lng (numbers) required' }, 400);
    }
    // Resolve which user: person mapping wins, else the token's user.
    const userId =
      (body.person ? resolveUserByHaPerson(db, body.person) : null) ?? c.get('userId');
    if (userId === 'local') return c.json({ error: 'no user' }, 400);
    saveGps(db, userId, body.lat, body.lng);
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
    };
    // Resolve which user this is about: an HA person mapping wins, else the token's user.
    const userId =
      (body.person ? resolveUserByHaPerson(db, body.person) : null) ?? c.get('userId');
    if (userId === 'local') return c.json({ error: 'no user' }, 400);
    if ((body.event ?? 'enter') !== 'enter') return c.json({ ok: true, matched: 0 });

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

  // ----- billing (subscription / renew) ---------------------------------------
  // Tenant-admin actions. Reachable even when the workspace is locked (the dispatcher
  // allowlists /api/billing*) so an admin can self-serve a renewal from the gate.
  // The default/self-host tenant (id 'default') has no control-plane row → no billing.
  api.get('/billing', requireAdmin, (c) => {
    const rec = ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id);
    return c.json({
      plans: listPlans(),
      expiresAt: rec?.expires_at ?? null,
      locked: rec ? tenantLockState(rec) === 'locked' : false,
      subscription: rec ? getSubscription(controlDb, ctx.id) : null,
    });
  });

  api.post('/billing/checkout', requireAdmin, async (c) => {
    const rec = ctx.id === 'default' ? null : getTenantById(controlDb, ctx.id);
    if (!rec) return c.json({ error: 'billing is not available for this workspace' }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { planId?: string };
    const plan = b.planId ? getPlan(b.planId) : undefined;
    if (!plan) return c.json({ error: 'unknown plan' }, 400);
    // Dummy provider: treat as an immediate success (no external redirect). A real
    // provider (Square) replaces this with a checkout redirect + a webhook that calls
    // the same extendExpiry() once payment confirms.
    const externalId = `dummy_${randomUUID()}`;
    const newExpiry = extendExpiry(controlDb, ctx.id, plan, { provider: 'dummy', externalId });
    if (rec.admin_email) {
      void sendBillingReceipt(rec.admin_email, plan.label, newExpiry).catch((e) =>
        console.error('[carbon] billing receipt failed:', e),
      );
    }
    return c.json({ ok: true, expiresAt: newExpiry, plan: plan.id }, 201);
  });

  const tenantApp = new Hono<Env>();
  tenantApp.route('/api', api);
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
const defaultApp = buildTenantApp(defaultCtx);

const controlDb = openControlDb(CONTROL_DB_PATH);
bootstrapHostAdmins(controlDb, process.env.HOST_ADMINS);

const registry = createTenantRegistry({
  defaultCtx,
  defaultApp,
  resolve: (subdomain) => resolveTenantLocation(controlDb, subdomain),
  listActive: () => listActiveTenants(controlDb),
  buildApp: buildTenantApp,
  cap: Number(process.env.TENANT_CACHE_CAP ?? 200),
});

startReminderScheduler(() => registry.activeDbs());
startGpsScheduler(() => registry.activeDbs());

// Lock is derived (no write fires at expiry — the dispatcher recomputes per request),
// so the only control-plane housekeeping is GCing expired pending signups. Hourly.
setInterval(() => {
  try {
    gcPendingSignups(controlDb);
  } catch (e) {
    console.error('[carbon] pending-signup gc failed:', e);
  }
}, 3_600_000);

console.log(
  `[carbon] default db=${DB_PATH} users=${listUsers(defaultCtx.db).length} ` +
    `tenants=${listTenants(controlDb).length} base=${BASE_DOMAIN ?? '(single-tenant)'}`,
);

// ----- host app: CORS, health, control plane, tenant dispatch ----------------

const app = new Hono();

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

// In-memory signup rate limit. Per-IP relies on the reverse proxy overwriting
// X-Forwarded-For (Nginx Proxy Manager does); the global cap is the backstop if the
// header is spoofed. Stale buckets are pruned each call so the map can't grow without
// bound (A6).
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

const host = new Hono<{ Variables: HostVars }>();

// Self-service signup, step 1: stage the workspace + email a one-time code. The tenant
// is NOT created yet — only on /signup/verify once the email is proven.
host.post('/signup/start', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
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
    return c.json({ error: (e as Error).message }, 400);
  }
});

// Self-service signup, step 2: verify the code, then provision the workspace with a
// trial expiry. The pending row is kept if provisioning fails so the user can retry.
host.post('/signup/verify', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
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
    // Keep the pending row so the user can retry (e.g. pick a free subdomain).
    return c.json({ error: (e as Error).message }, 400);
  }
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
    return c.json({ error: (e as Error).message }, 400);
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
    dbBytes,
    lastActivity,
    blobBytes,
    blobQuota: effectiveBlobQuota(rec),
  });
});

app.route('/host', host);

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
