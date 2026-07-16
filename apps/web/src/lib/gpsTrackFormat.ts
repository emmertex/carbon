/**
 * Pure GPS-track helpers: denoise, distance, bbox, JSON serialization.
 * Kept free of DOM / Capacitor so unit tests can run under Node.
 */

import { distanceMeters } from '@carbon/core';

export const TRACK_MIME = 'application/vnd.carbon.track+json';
export const TRACK_KIND = 'gps_track';

/** Minimum interval between accepted points (ms). */
export const MIN_INTERVAL_MS = 60_000;
/** Reject fixes whose reported accuracy is worse than this (metres). */
export const MAX_ACCURACY_M = 200;
/** Move at least this many × reported accuracy before accepting a new point. */
export const HYSTERESIS_ACCURACY_MULT = 5;

export interface TrackPoint {
  /** Epoch milliseconds. */
  t: number;
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres. */
  acc: number;
}

export interface TrackSummary {
  kind: typeof TRACK_KIND;
  session_id: string;
  points: number;
  distance_m: number;
  started_at: string;
  ended_at: string;
  bbox: [number, number, number, number]; // minLat, minLng, maxLat, maxLng
  blob_hash?: string;
}

export interface TrackFile {
  version: 1;
  kind: typeof TRACK_KIND;
  session_id: string;
  points: TrackPoint[];
  distance_m: number;
  started_at: string;
  ended_at: string;
  bbox: [number, number, number, number];
}

/** Whether `next` should be appended given the last accepted point. */
export function shouldAcceptPoint(
  prev: TrackPoint | null,
  next: TrackPoint,
  opts: {
    minIntervalMs?: number;
    maxAccuracyM?: number;
    hysteresisMult?: number;
  } = {},
): boolean {
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const maxAcc = opts.maxAccuracyM ?? MAX_ACCURACY_M;
  const mult = opts.hysteresisMult ?? HYSTERESIS_ACCURACY_MULT;

  if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return false;
  if (!Number.isFinite(next.t)) return false;
  const acc = Number.isFinite(next.acc) && next.acc > 0 ? next.acc : maxAcc;
  // First point: allow even a coarse fix so the track has an origin; still drop
  // absurd accuracy (worse than 2× the normal cutoff).
  if (!prev) return acc <= maxAcc * 2;

  if (next.t - prev.t < minInterval) return false;
  if (acc > maxAcc) return false;

  const threshold = mult * Math.max(acc, prev.acc > 0 ? prev.acc : acc, 1);
  const moved = distanceMeters(
    { lat: prev.lat, lng: prev.lng },
    { lat: next.lat, lng: next.lng },
  );
  return moved >= threshold;
}

export function trackDistanceM(points: TrackPoint[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    d += distanceMeters({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
  }
  return Math.round(d);
}

export function trackBbox(points: TrackPoint[]): [number, number, number, number] {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return [minLat, minLng, maxLat, maxLng];
}

export function buildTrackFile(sessionId: string, points: TrackPoint[]): TrackFile | null {
  if (points.length === 0) return null;
  const started = points[0]!;
  const ended = points[points.length - 1]!;
  return {
    version: 1,
    kind: TRACK_KIND,
    session_id: sessionId,
    points,
    distance_m: trackDistanceM(points),
    started_at: new Date(started.t).toISOString(),
    ended_at: new Date(ended.t).toISOString(),
    bbox: trackBbox(points),
  };
}

export function trackSummaryFromFile(file: TrackFile, blobHash?: string): TrackSummary {
  return {
    kind: TRACK_KIND,
    session_id: file.session_id,
    points: file.points.length,
    distance_m: file.distance_m,
    started_at: file.started_at,
    ended_at: file.ended_at,
    bbox: file.bbox,
    ...(blobHash ? { blob_hash: blobHash } : {}),
  };
}

export function trackNoteTitle(file: TrackFile): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  return `Track · ${fmt(file.started_at)}–${fmt(file.ended_at)}`;
}

export function trackFilename(sessionId: string, endedAtIso: string): string {
  const short = sessionId.slice(0, 8);
  const stamp = endedAtIso.replace(/[:.]/g, '-').replace(/Z$/, '');
  return `track-${short}-${stamp}.json`;
}
