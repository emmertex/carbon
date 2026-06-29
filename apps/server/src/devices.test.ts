/**
 * Per-device location store (multi-device Nearby): the core functions and the
 * /api/gps + /api/where + DELETE wiring.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  saveDeviceLocation,
  listDeviceLocations,
  freshestDeviceLocation,
  deleteDeviceLocation,
  pruneStaleDeviceLocations,
  getGps,
  saveGps,
  requireScope,
} from './auth';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';

describe('device location store', () => {
  test('upsert keyed on (user, device); multiple devices coexist', () => {
    const { db, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    saveDeviceLocation(db, { userId: uid, deviceId: 'phone', name: 'Pixel', lat: 1, lng: 2, source: 'device' });
    saveDeviceLocation(db, { userId: uid, deviceId: 'ha:' + uid, lat: 3, lng: 4, source: 'ha' });
    saveDeviceLocation(db, { userId: uid, deviceId: 'phone', lat: 5, lng: 6, source: 'device' }); // update
    const devices = listDeviceLocations(db, uid);
    assert.equal(devices.length, 2);
    const phone = devices.find((d) => d.deviceId === 'phone')!;
    assert.equal(phone.lat, 5); // updated in place
    assert.equal(phone.name, 'Pixel'); // name preserved when omitted on update
  });

  test('listDeviceLocations filters stale by maxAge; freshest is newest', () => {
    const { db, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    saveDeviceLocation(db, { userId: uid, deviceId: 'old', lat: 1, lng: 1, source: 'device' });
    // backdate the 'old' row two days
    db.run("UPDATE device_locations SET updated_at = ? WHERE device_id = 'old'", [
      new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
    ]);
    saveDeviceLocation(db, { userId: uid, deviceId: 'new', lat: 2, lng: 2, source: 'device' });
    assert.deepEqual(
      listDeviceLocations(db, uid, 24 * 3600_000).map((d) => d.deviceId),
      ['new'],
    );
    assert.equal(freshestDeviceLocation(db, uid)?.deviceId, 'new');
  });

  test('prune hard-deletes very old rows; delete removes one', () => {
    const { db, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    saveDeviceLocation(db, { userId: uid, deviceId: 'ancient', lat: 1, lng: 1, source: 'device' });
    db.run("UPDATE device_locations SET updated_at = ? WHERE device_id = 'ancient'", [
      new Date(Date.now() - 40 * 24 * 3600_000).toISOString(),
    ]);
    saveDeviceLocation(db, { userId: uid, deviceId: 'keep', lat: 2, lng: 2, source: 'device' });
    assert.equal(pruneStaleDeviceLocations(db), 1);
    assert.deepEqual(listDeviceLocations(db, uid).map((d) => d.deviceId), ['keep']);
    deleteDeviceLocation(db, uid, 'keep');
    assert.equal(listDeviceLocations(db, uid).length, 0);
  });

  test('migration folds an existing gps_history row into device_locations', () => {
    const { db, addUser } = makeTestDb();
    const { id: uid } = addUser('a', 'pw');
    // Simulate a pre-existing legacy single row, then re-run the migration.
    db.run(
      'INSERT INTO gps_history (user_id, lat, lng, accuracy, updated_at) VALUES (?, ?, ?, ?, ?)',
      [uid, -37.8, 145, 20, new Date().toISOString()],
    );
    db.exec(`
      INSERT OR IGNORE INTO device_locations (user_id, device_id, name, lat, lng, accuracy, source, updated_at)
      SELECT user_id, 'ha:' || user_id, NULL, lat, lng, accuracy, 'ha', updated_at FROM gps_history
    `);
    const d = listDeviceLocations(db, uid);
    assert.equal(d.length, 1);
    assert.equal(d[0].source, 'ha');
    assert.equal(d[0].deviceId, 'ha:' + uid);
  });
});

// Minimal app replicating the /gps + /where + delete routes' device behaviour.
function buildGeoApp(db: TestDb) {
  const app = makeHono(db, false);
  const STALE = 24 * 3600_000;
  app.post('/gps', requireScope('tasks:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      device_id?: string;
      name?: string;
      lat?: number;
      lng?: number;
      accuracy?: number;
    };
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return c.json({ error: 'bad' }, 400);
    const userId = c.get('userId');
    const isDevice = !!b.device_id;
    saveDeviceLocation(db, {
      userId,
      deviceId: b.device_id || `ha:${userId}`,
      name: b.name ?? null,
      lat: b.lat,
      lng: b.lng,
      accuracy: b.accuracy ?? null,
      source: isDevice ? 'device' : 'ha',
    });
    if (!isDevice) saveGps(db, userId, b.lat, b.lng, b.accuracy ?? null);
    return c.json({ ok: true });
  });
  app.get('/where', requireScope('tasks:read'), (c) => {
    const userId = c.get('userId');
    return c.json({ devices: listDeviceLocations(db, userId, STALE) });
  });
  app.delete('/where/device/:id', requireScope('tasks:write'), (c) => {
    deleteDeviceLocation(db, c.get('userId'), c.req.param('id'));
    return c.json({ ok: true });
  });
  return app;
}

describe('/api/gps + /api/where device wiring', () => {
  test('an HA fix and a device self-report coexist as two devices', async () => {
    const { db, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    const app = buildGeoApp(db);
    const post = (body: unknown) =>
      appFetch(app, '/gps', {
        method: 'POST',
        headers: { Authorization: basic, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    await post({ lat: -37.8, lng: 145 }); // HA path (no device_id)
    await post({ device_id: 'laptop', name: 'ZBook', lat: -37.81, lng: 145.01, accuracy: 40 });

    const res = await appFetch(app, '/where', { headers: { Authorization: basic } });
    const body = (await res.json()) as { devices: { deviceId: string; source: string; name: string | null }[] };
    assert.equal(body.devices.length, 2);
    assert.ok(body.devices.some((d) => d.source === 'ha' && d.deviceId === `ha:${uid}`));
    assert.ok(body.devices.some((d) => d.deviceId === 'laptop' && d.name === 'ZBook'));

    // HA path still wrote the legacy single row (proximity stays HA-driven); a device
    // self-report did NOT touch it.
    assert.ok(getGps(db, uid));
  });

  test('DELETE removes a device', async () => {
    const { db, addUser } = makeTestDb();
    const { id: uid, basic } = addUser('a', 'pw');
    saveDeviceLocation(db, { userId: uid, deviceId: 'laptop', lat: 1, lng: 2, source: 'device' });
    const app = buildGeoApp(db);
    await appFetch(app, '/where/device/laptop', { method: 'DELETE', headers: { Authorization: basic } });
    assert.equal(listDeviceLocations(db, uid).length, 0);
  });
});
