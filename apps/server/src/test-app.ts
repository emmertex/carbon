import { Hono } from 'hono';
import { openDb } from './sqlite';
import { migrate, createUser } from '@carbon/core';
import {
  ensureServerTables,
  basicAuth,
  hashPassword,
  setPassword,
  createSession,
  type AuthVars,
} from './auth';
import { ensureCaldavTables, ensureCaldavDeviceId } from './caldav';
import { ensurePushTables, initVapid } from './push';
import { ensureFcmTable } from './fcm';
import { ensureAgentTables, ensureAgentUsageTables } from './agents';
import { ensureUserPrefsTables } from './user-prefs';
import { ensureNoticeTables } from './notices';
import { ensureFederationTables, ensureGovernanceTables } from './federation';
import { ensurePurgeNoticeTable } from './purge-notices';
import type { FetchApp } from './tenant';

export type TestDb = ReturnType<typeof openDb>;

export interface TestCtx {
  db: TestDb;
  deviceId: string;
  vapidPublicKey: string;
  addUser(
    username: string,
    password: string,
    role?: 'admin' | 'member',
  ): { id: string; username: string; token: string; basic: string };
}

/** Open an in-memory DB with the full schema + server tables. */
export function makeTestDb(): TestCtx {
  const db = openDb(':memory:');
  migrate(db);
  ensureServerTables(db);
  ensurePushTables(db);
  ensureFcmTable(db);
  ensureAgentTables(db);
  ensureAgentUsageTables(db);
  ensureCaldavTables(db);
  ensureUserPrefsTables(db);
  ensureNoticeTables(db);
  ensurePurgeNoticeTable(db);
  ensureFederationTables(db);
  ensureGovernanceTables(db);
  const deviceId = ensureCaldavDeviceId(db);
  const vapidPublicKey = initVapid(db);

  function addUser(username: string, password: string, role: 'admin' | 'member' = 'member') {
    const user = createUser(db, { username, displayName: username, role });
    setPassword(db, user.id, hashPassword(password));
    const token = createSession(db, user.id);
    const basic = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    return { id: user.id, username, token, basic };
  }

  return { db, deviceId, vapidPublicKey, addUser };
}

/** Build a Hono app with basicAuth wired to `db`. Routes are added by the caller.
 *  Tests allow Basic everywhere; production restricts Basic to `/login` only. */
export function makeHono(db: TestDb, allowOpen = true) {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', basicAuth(db, { allowOpen, basicPaths: null }));
  return app;
}

export interface WorkspaceDb {
  db: TestDb;
  deviceId: string;
  vapidPublicKey: string;
}

/** N independent, current-version in-memory workspace (tenant) DBs — the
 *  "multiple workspaces" fixture. Each is a valid tenant DB (schema + server
 *  tables + its own device id / VAPID key), so integration tests can exercise
 *  cross-tenant / multi-workspace flows (federation, tenant isolation, …)
 *  without spinning up real tenants. */
export function makeWorkspaceDbs(n: number): WorkspaceDb[] {
  return Array.from({ length: n }, () => {
    const { db, deviceId, vapidPublicKey } = makeTestDb();
    return { db, deviceId, vapidPublicKey };
  });
}

/** Fire a request against an app without a real HTTP server. Accepts any
 *  FetchApp (a Hono instance, or the real per-tenant app returned by
 *  buildTenantApp in index.ts) so tests can reach the production route table. */
export function appFetch(
  app: FetchApp,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://test${path}`, init)));
}
