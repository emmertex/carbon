import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { makeTestDb, makeHono, appFetch, type TestDb } from './test-app';
import {
  saveGps,
  saveZone,
  getUserLocation,
  resolveUserByHaPerson,
  setHaPerson,
  requireScope,
} from './auth';

function buildGeoApp(db: TestDb) {
  const app = makeHono(db, false); // require auth

  app.post('/gps', requireScope('tasks:write'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      person?: string;
      lat?: number;
      lng?: number;
      accuracy?: number;
      gps_accuracy?: number;
    };
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number') {
      return c.json({ error: 'lat and lng (numbers) required' }, 400);
    }
    const uid = c.get('userId');
    let userId: string | null = uid === 'local' ? null : uid;
    if (body.person) userId = resolveUserByHaPerson(db, body.person);
    if (!userId) return c.json({ ok: true, saved: false, reason: 'unmapped person' });
    saveGps(db, userId, body.lat, body.lng, body.accuracy ?? body.gps_accuracy ?? null);
    return c.json({ ok: true, saved: true });
  });

  app.post('/geo/event', requireScope('tasks:write'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      person?: string;
      zone?: string;
      event?: 'enter' | 'leave';
      lat?: number;
      lng?: number;
      accuracy?: number;
    };
    const uid = c.get('userId');
    let userId: string | null = uid === 'local' ? null : uid;
    if (body.person) userId = resolveUserByHaPerson(db, body.person);
    if (!userId) return c.json({ ok: true, matched: 0, reason: 'unmapped person' });

    const isEnter = (body.event ?? 'enter') === 'enter';
    if (body.zone != null) saveZone(db, userId, isEnter ? body.zone : null);
    if (typeof body.lat === 'number' && typeof body.lng === 'number') {
      saveGps(db, userId, body.lat, body.lng, body.accuracy ?? null);
    }
    return c.json({ ok: true, matched: 0 });
  });

  app.get('/where', requireScope('tasks:read'), (c) => {
    const userId = c.get('userId');
    if (userId === 'local') return c.json({ zone: null, haGps: null });
    return c.json(getUserLocation(db, userId));
  });

  return app;
}

// ─── GPS feed ────────────────────────────────────────────────────────────────

describe('POST /gps', () => {
  test('saves GPS coordinates for authenticated user', async () => {
    const { db, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const app = buildGeoApp(db);
    const res = await appFetch(app, '/gps', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: -37.8136, lng: 144.9631, accuracy: 10 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; saved: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.saved, true);

    // Verify it's in the DB
    const row = db.get<{ lat: number; lng: number }>(
      'SELECT lat, lng FROM gps_history WHERE user_id = ?',
      [userId],
    );
    assert.ok(row, 'GPS row persisted');
    assert.equal(row!.lat, -37.8136);
  });

  test('returns 400 when lat/lng missing', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildGeoApp(db);
    const res = await appFetch(app, '/gps', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accuracy: 5 }),
    });
    assert.equal(res.status, 400);
  });

  test('saves GPS for a ha_person-mapped user', async () => {
    const { db, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    setHaPerson(db, userId, 'person.alice');
    const app = buildGeoApp(db);

    const res = await appFetch(app, '/gps', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ person: 'person.alice', lat: -33.8688, lng: 151.2093 }),
    });
    assert.equal(res.status, 200);
    const row = db.get<{ lat: number }>(
      'SELECT lat FROM gps_history WHERE user_id = ?',
      [userId],
    );
    assert.ok(row);
    assert.equal(row!.lat, -33.8688);
  });

  test('gracefully handles unmapped ha_person', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildGeoApp(db);
    const res = await appFetch(app, '/gps', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ person: 'person.nobody', lat: 0, lng: 0 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; saved: boolean; reason: string };
    assert.equal(body.saved, false);
    assert.equal(body.reason, 'unmapped person');
  });
});

// ─── Zone events ─────────────────────────────────────────────────────────────

describe('POST /geo/event', () => {
  test('zone enter sets the current zone', async () => {
    const { db, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    const app = buildGeoApp(db);

    const res = await appFetch(app, '/geo/event', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone: 'home', event: 'enter' }),
    });
    assert.equal(res.status, 200);
    const loc = getUserLocation(db, userId);
    assert.equal(loc.zone?.name, 'home');
  });

  test('zone leave clears the current zone', async () => {
    const { db, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    saveZone(db, userId, 'home');
    const app = buildGeoApp(db);

    await appFetch(app, '/geo/event', {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone: 'home', event: 'leave' }),
    });
    const loc = getUserLocation(db, userId);
    assert.equal(loc.zone, null);
  });
});

// ─── Where ────────────────────────────────────────────────────────────────────

describe('GET /where', () => {
  test('returns null zone and null haGps when no location known', async () => {
    const { db, addUser } = makeTestDb();
    const { basic } = addUser('alice', 'pw');
    const app = buildGeoApp(db);
    const res = await appFetch(app, '/where', { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const body = await res.json() as { zone: null; haGps: null };
    assert.equal(body.zone, null);
    assert.equal(body.haGps, null);
  });

  test('returns zone after entering it', async () => {
    const { db, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    saveZone(db, userId, 'office');
    const app = buildGeoApp(db);
    const res = await appFetch(app, '/where', { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    const body = await res.json() as { zone: { name: string } | null; haGps: null };
    assert.equal(body.zone?.name, 'office');
  });

  test('returns GPS coordinates after a fix is saved', async () => {
    const { db, addUser } = makeTestDb();
    const { id: userId, basic } = addUser('alice', 'pw');
    saveGps(db, userId, -37.8136, 144.9631, 15);
    const app = buildGeoApp(db);
    const res = await appFetch(app, '/where', { headers: { Authorization: basic } });
    const body = await res.json() as { haGps: { lat: number; lng: number } | null };
    assert.ok(body.haGps, 'haGps should be set');
    assert.equal(body.haGps!.lat, -37.8136);
  });
});
