import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGeo, distanceMeters, tasksAtLocation, tasksInZone } from './geo';
import type { Item } from './types';

let seq = 0;
const task = (geo: object | null, over: Partial<Item> = {}): Item =>
  ({
    id: `g${seq++}`,
    type: 'task',
    status: 'active',
    deleted: false,
    geo: geo ? JSON.stringify(geo) : null,
    ...over,
  }) as Item;

test('parseGeo defaults a missing or non-positive radius to 100m (N2)', () => {
  assert.equal(parseGeo(JSON.stringify({ lat: 1, lng: 2 }))?.radius, 100);
  assert.equal(parseGeo(JSON.stringify({ lat: 1, lng: 2, radius: 0 }))?.radius, 100);
  assert.equal(parseGeo(JSON.stringify({ lat: 1, lng: 2, radius: -5 }))?.radius, 100);
  // A real radius is preserved.
  assert.equal(parseGeo(JSON.stringify({ lat: 1, lng: 2, radius: 250 }))?.radius, 250);
});

test('parseGeo rejects malformed input', () => {
  assert.equal(parseGeo(null), null);
  assert.equal(parseGeo('not json'), null);
  assert.equal(parseGeo(JSON.stringify({ lat: 'x', lng: 2 })), null);
});

test('distanceMeters is ~0 for identical points and plausible for ~1km', () => {
  const a = { lat: -37.81, lng: 144.96 };
  assert.ok(distanceMeters(a, a) < 1);
  // ~0.009 deg latitude ≈ 1 km.
  const d = distanceMeters(a, { lat: -37.81 + 0.009, lng: 144.96 });
  assert.ok(d > 950 && d < 1050, `expected ~1km, got ${Math.round(d)}m`);
});

test('tasksAtLocation matches inside the radius (metres) and excludes outside', () => {
  const office = { lat: -37.81, lng: 144.96 };
  const items = [
    task({ lat: -37.81, lng: 144.96, radius: 100, label: 'Office' }), // at point
    task({ lat: -37.81 + 0.009, lng: 144.96, radius: 100 }), // ~1km away → out
    task(null), // no geo
    task({ lat: -37.81, lng: 144.96, radius: 100 }, { status: 'done' }), // inactive
  ];
  const hit = tasksAtLocation(items, office);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.id, items[0]!.id);
});

test('tasksInZone matches case- and whitespace-insensitively', () => {
  const items = [
    task({ lat: 1, lng: 2, label: 'Home' }),
    task({ lat: 1, lng: 2, label: 'Office' }),
    task({ lat: 1, lng: 2 }), // no label
  ];
  assert.deepEqual(tasksInZone(items, '  home ').map((i) => i.id), [items[0]!.id]);
  assert.deepEqual(tasksInZone(items, 'OFFICE').map((i) => i.id), [items[1]!.id]);
  assert.deepEqual(tasksInZone(items, 'garage'), []);
});
