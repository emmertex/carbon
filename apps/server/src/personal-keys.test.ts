import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createItem, shareItem } from '@carbon/core';
import { makeTestDb, appFetch } from './test-app';

const tmp = mkdtempSync(join(tmpdir(), 'carbon-key-tests-'));
Object.assign(process.env, { CARBON_NO_AUTOSTART: '1', DATABASE_PATH: join(tmp, 'default.db'), CONTROL_DB_PATH: join(tmp, 'control.db'), BLOBS_DIR: join(tmp, 'blobs') });

test('personal REST keys intersect scope, subtree, live permissions, expiry and revocation', async () => {
  const t = makeTestDb();
  const admin = t.addUser('owner', 'password', 'admin');
  const member = t.addUser('member', 'password');
  const project = createItem(t.db, t.deviceId, { type: 'project', title: 'shared', ownerId: admin.id });
  const inside = createItem(t.db, t.deviceId, { title: 'inside', parentId: project.id, ownerId: admin.id });
  const outside = createItem(t.db, t.deviceId, { title: 'outside', ownerId: member.id });
  shareItem(t.db, t.deviceId, project.id, member.id, 'write');
  const { buildTenantApp } = await import('./index');
  const app = buildTenantApp({ id: 'default', subdomain: '', db: t.db, serverDeviceId: t.deviceId, vapidPublicKey: t.vapidPublicKey, blobsDir: join(tmp, 'blobs') }, async () => new Response('', { status: 501 }));
  const request = (token: string, path: string, method = 'GET', body?: unknown) => appFetch(app, `/api${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request(member.token, '/keys', 'POST', null)).status, 400);
  assert.equal((await request(admin.token, '/admin/key-policy', 'PUT', null)).status, 400);
  const created = await request(member.token, '/keys', 'POST', { name: 'client', scopes: ['tasks:read', 'tasks:write', 'inbox:write'], projectIds: [project.id], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(created.status, 201);
  const key = await created.json() as { id: string; token: string };
  const page = await (await request(key.token, '/tasks')).json() as { tasks: {id: string}[]; total: number };
  assert.deepEqual(page.tasks.map((r) => r.id), [inside.id]);
  assert.equal(page.total, 1);
  assert.equal((await request(key.token, `/tasks/${outside.id}`)).status, 403);
  assert.equal((await request(key.token, `/tasks/${inside.id}`, 'PATCH', { parent_id: null })).status, 403);
  assert.equal((await request(key.token, '/tasks', 'POST', { title: 'escaped' })).status, 403);
  assert.equal((await request(key.token, '/tasks', 'POST', { title: 'new', project_id: project.id })).status, 201);
  assert.equal((await request(key.token, `/tasks/${inside.id}`, 'PATCH', { title: 'allowed' })).status, 200);
  for (const path of ['/sync', '/admin/tokens', '/keys', '/agent/command', '/me', '/blobs/' + 'a'.repeat(64)])
    assert.equal((await request(key.token, path, 'POST', {})).status, 403, path);
  const read = await (await request(member.token, '/keys', 'POST', { name: 'reader', scopes: ['tasks:read'], projectIds: [project.id] })).json() as {token:string};
  assert.equal((await request(read.token, `/tasks/${inside.id}`, 'PATCH', { title: 'denied' })).status, 403);
  shareItem(t.db, t.deviceId, project.id, member.id, 'read');
  assert.equal((await request(key.token, `/tasks/${inside.id}`, 'PATCH', { title: 'denied' })).status, 403);
  t.db.run('UPDATE shares SET deleted = 1 WHERE item_id = ? AND user_id = ?', [project.id, member.id]);
  assert.equal((await request(key.token, `/tasks/${inside.id}`)).status, 404);
  t.db.run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00Z', key.id]);
  assert.equal((await request(key.token, '/tasks')).status, 401);
  t.db.run('UPDATE api_tokens SET expires_at = NULL WHERE id = ?', [key.id]);
  assert.equal((await request(member.token, `/keys/${key.id}`, 'DELETE')).status, 200);
  assert.equal((await request(key.token, '/tasks')).status, 401);
  assert.equal((await request(admin.token, '/admin/key-policy', 'PUT', { membersAllowed: false })).status, 200);
  assert.equal((await request(member.token, '/keys', 'POST', { name: 'disabled', scopes: ['tasks:read'] })).status, 403);
  assert.equal((await request(admin.token, '/admin/agents', 'POST', { name: 'old', username: 'old', kind: 'webhook' })).status, 201);
});
