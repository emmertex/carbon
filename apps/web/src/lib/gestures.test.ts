import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { edgeZone, zoneForX, EDGE_FRACTION, EDGE_ZONE_MIN } from './gestures';

describe('edgeZone()', () => {
  test('returns EDGE_ZONE_MIN for very narrow widths', () => {
    assert.equal(edgeZone(0), EDGE_ZONE_MIN);
    assert.equal(edgeZone(10), EDGE_ZONE_MIN);
    assert.equal(edgeZone(EDGE_ZONE_MIN), EDGE_ZONE_MIN);
  });

  test('returns fraction of width for normal row widths', () => {
    const width = 400;
    assert.equal(edgeZone(width), Math.max(EDGE_ZONE_MIN, width * EDGE_FRACTION));
  });

  test('scales linearly beyond the floor', () => {
    const zone1 = edgeZone(300);
    const zone2 = edgeZone(600);
    assert.equal(zone2, zone1 * 2, 'edge zone doubles when width doubles');
  });
});

describe('zoneForX()', () => {
  const width = 400;

  test('always returns center when paneGestures is false', () => {
    assert.equal(zoneForX(0, width, false), 'center');
    assert.equal(zoneForX(width / 2, width, false), 'center');
    assert.equal(zoneForX(width, width, false), 'center');
  });

  test('left edge: x <= edgeZone(width)', () => {
    const edge = edgeZone(width);
    assert.equal(zoneForX(0, width, true), 'leftEdge');
    assert.equal(zoneForX(edge, width, true), 'leftEdge');
    assert.equal(zoneForX(edge + 1, width, true), 'center');
  });

  test('right edge: x >= width - edgeZone(width)', () => {
    const edge = edgeZone(width);
    assert.equal(zoneForX(width, width, true), 'rightEdge');
    assert.equal(zoneForX(width - edge, width, true), 'rightEdge');
    assert.equal(zoneForX(width - edge - 1, width, true), 'center');
  });

  test('center: between left and right edges', () => {
    assert.equal(zoneForX(width / 2, width, true), 'center');
  });

  test('narrow row: minimum edge zone keeps gestures reachable', () => {
    const narrowWidth = 40; // narrower than EDGE_ZONE_MIN * 2
    // At minimum both edges are EDGE_ZONE_MIN; center may overlap but edges still fire
    assert.equal(zoneForX(0, narrowWidth, true), 'leftEdge');
    assert.equal(zoneForX(narrowWidth, narrowWidth, true), 'rightEdge');
  });
});
