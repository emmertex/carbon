import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createItem } from '@carbon/core';
import { makeWorkspaceDbs } from './test-app';

/** "Multiple workspaces" fixture: N independent, current-version tenant DBs usable
 *  from integration tests (cross-tenant / tenant-isolation / federation flows)
 *  without spinning up real tenants. */
describe('multiple workspaces fixture', () => {
  test('makeWorkspaceDbs returns independent, current-version tenant DBs', () => {
    const [a, b, c] = makeWorkspaceDbs(3);

    assert.ok(a.db && b.db && c.db, 'three workspace DBs');
    // Each workspace has its own device id (identities don't collide).
    assert.notEqual(a.deviceId, b.deviceId);
    assert.notEqual(b.deviceId, c.deviceId);
    assert.ok(a.vapidPublicKey && b.vapidPublicKey, 'each workspace initialised VAPID');

    // Workspaces are independent: a write to one (via the real core API) is
    // invisible to the others — tenant isolation.
    createItem(a.db, a.deviceId, { type: 'task', title: 'only in A' });
    const inA = a.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM items WHERE title = 'only in A'")?.c ?? 0;
    const inB = b.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM items WHERE title = 'only in A'")?.c ?? 0;
    assert.equal(inA, 1, 'item exists in workspace A');
    assert.equal(inB, 0, 'item is NOT visible in workspace B (tenant isolation)');
  });
});
