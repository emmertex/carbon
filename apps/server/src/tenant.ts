import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, ensureDeviceId, type Db } from '@carbon/core';
import { openDb } from './sqlite';
import { ensureServerTables } from './auth';
import { ensurePushTables, initVapid } from './push';
import { ensureFcmTable } from './fcm';
import { ensureAgentTables, ensureAgentUsageTables } from './agents';
import { ensureCaldavTables } from './caldav';
import { ensureUserPrefsTables } from './user-prefs';

/** Everything a single tenant's request handlers close over. One per family DB. */
export interface TenantCtx {
  id: string;
  subdomain: string;
  db: Db & { raw: DatabaseSync };
  serverDeviceId: string;
  vapidPublicKey: string;
  blobsDir: string;
}

/** Minimal shape of a Hono app we forward requests into (avoids importing Env here). */
export interface FetchApp {
  fetch(req: Request, ...rest: unknown[]): Response | Promise<Response>;
}

/**
 * Open a tenant DB and run the exact per-tenant init the single-tenant server used
 * to run once at startup (migrate + device id + server/push/fcm/agent tables + VAPID).
 * Reused for the default tenant, on-demand tenant loads, and provisioning.
 */
export function initTenantDb(opts: {
  id: string;
  subdomain: string;
  dbPath: string;
  blobsDir: string;
}): TenantCtx {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  mkdirSync(opts.blobsDir, { recursive: true });
  const db = openDb(opts.dbPath);
  migrate(db);
  const serverDeviceId = ensureDeviceId(db);
  ensureServerTables(db);
  ensurePushTables(db);
  ensureFcmTable(db);
  ensureAgentTables(db);
  ensureAgentUsageTables(db);
  ensureCaldavTables(db);
  ensureUserPrefsTables(db);
  const vapidPublicKey = initVapid(db);
  return {
    id: opts.id,
    subdomain: opts.subdomain,
    db,
    serverDeviceId,
    vapidPublicKey,
    blobsDir: opts.blobsDir,
  };
}

/** A resolved-but-not-yet-loaded tenant: where its files live. Null = not a tenant. */
export interface TenantLocation {
  id: string;
  subdomain: string;
  dbPath: string;
  blobsDir: string;
}

interface Loaded {
  ctx: TenantCtx;
  app: FetchApp;
}

export interface TenantRegistry {
  /** Resolve + lazily build the app for a subdomain (null = unknown/suspended). */
  getApp(subdomain: string | null): FetchApp | null;
  /** Open (cache) the tenant ctx for a subdomain without building its app. */
  getCtx(subdomain: string | null): TenantCtx | null;
  /** DBs that the reminder scheduler must sweep: default + every active tenant. */
  activeDbs(): Db[];
  /** Full ctxs (db + serverDeviceId + id) for jobs that need more than the DB
   *  handle — e.g. the CalDAV connector needs each tenant's allow-private flag. */
  activeCtxs(): TenantCtx[];
  /** Drop a tenant from the cache and close its DB handle (suspend/delete). */
  evict(id: string): void;
}

/**
 * Holds open tenant DB handles + built apps, capped by an LRU so a server with
 * thousands of tenants keeps only the hot set in memory. The default (legacy)
 * tenant is pinned and never evicted, preserving single-tenant self-host.
 */
export function createTenantRegistry(opts: {
  defaultCtx: TenantCtx;
  defaultApp: FetchApp;
  /** Look up where a tenant's files live by subdomain; null if unknown/suspended. */
  resolve: (subdomain: string) => TenantLocation | null;
  /** Subdomains of all active tenants (for the reminder sweep). */
  listActive: () => TenantLocation[];
  buildApp: (ctx: TenantCtx) => FetchApp;
  cap?: number;
}): TenantRegistry {
  const cap = opts.cap ?? 200;
  // Map iteration order = insertion order; we delete+reinsert on access for LRU.
  const cache = new Map<string, Loaded>();

  function evictIfNeeded(): void {
    while (cache.size > cap) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const victim = cache.get(oldest);
      cache.delete(oldest);
      try {
        victim?.ctx.db.raw.close();
      } catch {
        /* already closed */
      }
    }
  }

  function load(loc: TenantLocation): Loaded {
    const cached = cache.get(loc.id);
    if (cached) {
      cache.delete(loc.id); // move to most-recently-used
      cache.set(loc.id, cached);
      return cached;
    }
    const ctx = initTenantDb(loc);
    const entry: Loaded = { ctx, app: opts.buildApp(ctx) };
    cache.set(loc.id, entry);
    evictIfNeeded();
    return entry;
  }

  function resolveLoaded(subdomain: string | null): Loaded | null {
    if (subdomain === null) return { ctx: opts.defaultCtx, app: opts.defaultApp };
    const loc = opts.resolve(subdomain);
    if (!loc) return null;
    return load(loc);
  }

  return {
    getApp: (subdomain) => resolveLoaded(subdomain)?.app ?? null,
    getCtx: (subdomain) => resolveLoaded(subdomain)?.ctx ?? null,
    activeDbs() {
      const dbs: Db[] = [opts.defaultCtx.db];
      for (const loc of opts.listActive()) {
        const entry = load(loc);
        dbs.push(entry.ctx.db);
      }
      return dbs;
    },
    activeCtxs() {
      const ctxs: TenantCtx[] = [opts.defaultCtx];
      for (const loc of opts.listActive()) ctxs.push(load(loc).ctx);
      return ctxs;
    },
    evict(id) {
      const entry = cache.get(id);
      if (!entry) return;
      cache.delete(id);
      try {
        entry.ctx.db.raw.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'admin',
  'app',
  'host',
  'static',
  'assets',
  'mail',
  'ns',
  'ns1',
  'ns2',
]);

/**
 * The left-most label of a Host under the apex domain, or null for the apex
 * itself / hosts not under the base / unset base. Does NOT filter reserved labels
 * (callers that need to recognise `app`, `admin`, etc. use this directly).
 * `89eb.carbon.etx.sx` + base `carbon.etx.sx` => `89eb`; `carbon.etx.sx` => null.
 */
export function hostLabel(host: string | undefined, baseDomain: string | undefined): string | null {
  if (!host || !baseDomain) return null;
  const hostname = host.split(':')[0].toLowerCase();
  const base = baseDomain.toLowerCase();
  if (hostname === base) return null;
  if (!hostname.endsWith('.' + base)) return null;
  const label = hostname.slice(0, hostname.length - base.length - 1);
  // Only a single left-most label is meaningful (no nested subdomains).
  if (!label || label.includes('.')) return null;
  return label;
}

/**
 * The tenant subdomain from a Host header, or null for the apex / reserved labels
 * (www, app, admin, …) / non-base hosts / unset base. Null routes to the default
 * tenant, which keeps single-tenant self-host working unchanged.
 */
export function subdomainFromHost(host: string | undefined, baseDomain: string | undefined): string | null {
  const label = hostLabel(host, baseDomain);
  if (!label || RESERVED_SUBDOMAINS.has(label)) return null;
  return label;
}

export { RESERVED_SUBDOMAINS };
