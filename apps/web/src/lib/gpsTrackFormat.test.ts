import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shouldAcceptPoint,
  trackDistanceM,
  trackBbox,
  buildTrackFile,
  trackSummaryFromFile,
  trackFilename,
  TRACK_KIND,
  MIN_INTERVAL_MS,
  type TrackPoint,
} from './gpsTrackFormat';

const p = (t: number, lat: number, lng: number, acc: number): TrackPoint => ({
  t,
  lat,
  lng,
  acc,
});

test('shouldAcceptPoint accepts a reasonable first fix', () => {
  assert.equal(shouldAcceptPoint(null, p(0, -37.8, 144.9, 20)), true);
  assert.equal(shouldAcceptPoint(null, p(0, -37.8, 144.9, 500)), false); // > 2×200m
});

test('shouldAcceptPoint enforces min interval', () => {
  const a = p(1_000_000, -37.8, 144.9, 10);
  const near = p(1_000_000 + MIN_INTERVAL_MS - 1, -37.81, 144.91, 10); // moved far but too soon
  assert.equal(shouldAcceptPoint(a, near), false);
});

test('shouldAcceptPoint requires move ≥ 5× accuracy (hysteresis)', () => {
  const a = p(0, 0, 0, 10); // 5×10 = 50m threshold
  // ~11m east at equator (lng delta 0.0001° ≈ 11.1m) — below threshold
  const tiny = p(MIN_INTERVAL_MS, 0, 0.0001, 10);
  assert.equal(shouldAcceptPoint(a, tiny), false);
  // ~111m east (0.001°) — above 50m
  const far = p(MIN_INTERVAL_MS, 0, 0.001, 10);
  assert.equal(shouldAcceptPoint(a, far), true);
});

test('shouldAcceptPoint drops coarse follow-up fixes', () => {
  const a = p(0, 0, 0, 10);
  const coarse = p(MIN_INTERVAL_MS, 0, 0.01, 250);
  assert.equal(shouldAcceptPoint(a, coarse), false);
});

test('trackDistanceM / bbox / buildTrackFile produce a coherent file', () => {
  const points = [
    p(1_700_000_000_000, 0, 0, 10),
    p(1_700_000_060_000, 0, 0.001, 10),
    p(1_700_000_120_000, 0, 0.002, 12),
  ];
  const dist = trackDistanceM(points);
  assert.ok(dist > 200 && dist < 250, `distance ~222m, got ${dist}`);
  const bbox = trackBbox(points);
  assert.deepEqual(bbox, [0, 0, 0, 0.002]);

  const file = buildTrackFile('sess-abc', points);
  assert.ok(file);
  assert.equal(file!.kind, TRACK_KIND);
  assert.equal(file!.points.length, 3);
  assert.equal(file!.distance_m, dist);

  const summary = trackSummaryFromFile(file!, 'deadbeef');
  assert.equal(summary.kind, TRACK_KIND);
  assert.equal(summary.blob_hash, 'deadbeef');
  assert.equal(summary.points, 3);

  assert.match(trackFilename('sess-abc', file!.ended_at), /^track-sess-abc-.+\.json$/);
});

test('buildTrackFile returns null for an empty buffer', () => {
  assert.equal(buildTrackFile('x', []), null);
});
