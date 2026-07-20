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

/** Fire a request against a Hono app without a real HTTP server. */
export function appFetch(
  app: Hono<{ Variables: AuthVars }>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://test${path}`, init)));
}
