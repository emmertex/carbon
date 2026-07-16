/**
 * GPS track recorder for time-tracking sessions.
 *
 * - Opt-in via localStorage pref `carbon.gpsTrack`.
 * - Denoises fixes (≤1 min + 5× accuracy hysteresis) into a durable buffer.
 * - On flush (stop / park): creates a time note + attaches a JSON track blob.
 * - Native: @capgo/background-geolocation (foreground service).
 * - Web: foreground watchPosition only.
 */

import localforage from 'localforage';
import {
  addTimeNote,
  addAttachment,
  updateItem,
  getTimeContext,
  getItem,
  createItem,
} from '@carbon/core';
import { getDb } from './db';
import { mutate } from './mutate';
import { storeFile } from './blobs';
import { isCapacitor } from './platform';
import { watchPosition, type PositionWatch, type GeoPoint } from './location';
import { useStore, getCurrentUserId } from './store';
import {
  shouldAcceptPoint,
  buildTrackFile,
  trackSummaryFromFile,
  trackNoteTitle,
  trackFilename,
  TRACK_MIME,
  type TrackPoint,
} from './gpsTrackFormat';

const PREF_KEY = 'carbon.gpsTrack';
const BUFFER_KEY = 'gpsTrack.buffer';
const CHECKPOINT_MS = 2 * 60_000;
const PERIODIC_FLUSH_MS = 15 * 60_000;

interface BufferState {
  sessionId: string;
  points: TrackPoint[];
  /** ISO of last periodic flush; points after this are still pending. */
  flushedUntilT: number;
}

const durable = localforage.createInstance({ name: 'carbon', storeName: 'gpsTrack' });

let buffer: BufferState | null = null;
let fgWatch: PositionWatch | null = null;
let bgRunning = false;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let starting = false;

export function gpsTrackPref(): boolean {
  return localStorage.getItem(PREF_KEY) === '1';
}

export function setGpsTrackPref(on: boolean): void {
  if (on) localStorage.setItem(PREF_KEY, '1');
  else localStorage.removeItem(PREF_KEY);
}

export function gpsTrackSupported(): boolean {
  return isCapacitor || (typeof navigator !== 'undefined' && 'geolocation' in navigator);
}

export function gpsTrackRecording(): boolean {
  return buffer != null && (bgRunning || fgWatch != null);
}

export function gpsTrackPointCount(): number {
  return buffer?.points.length ?? 0;
}

async function loadBuffer(): Promise<void> {
  if (buffer) return;
  const saved = await durable.getItem<BufferState>(BUFFER_KEY);
  if (saved?.sessionId && Array.isArray(saved.points)) buffer = saved;
}

async function saveBuffer(): Promise<void> {
  if (buffer) await durable.setItem(BUFFER_KEY, buffer);
  else await durable.removeItem(BUFFER_KEY);
}

function lastPoint(): TrackPoint | null {
  if (!buffer || buffer.points.length === 0) return null;
  return buffer.points[buffer.points.length - 1]!;
}

function ingest(point: GeoPoint): void {
  if (!buffer) return;
  const next: TrackPoint = {
    t: Date.now(),
    lat: point.lat,
    lng: point.lng,
    acc: point.accuracy ?? 0,
  };
  if (!shouldAcceptPoint(lastPoint(), next)) return;
  buffer.points.push(next);
}

async function loadCapgo() {
  try {
    return await import('@capgo/background-geolocation');
  } catch {
    return null;
  }
}

async function startNative(): Promise<boolean> {
  const mod = await loadCapgo();
  if (!mod) return false;
  try {
    await mod.BackgroundGeolocation.start(
      {
        backgroundMessage: 'Carbon is recording a GPS track for your time session.',
        backgroundTitle: 'Carbon · tracking',
        requestPermissions: true,
        stale: false,
        distanceFilter: 25,
      },
      (location, error) => {
        if (error) {
          if (error.code === 'NOT_AUTHORIZED') {
            useStore.getState().showToast({
              message: 'Location permission denied — GPS tracking is off.',
            });
            setGpsTrackPref(false);
            void stopRecorder();
          }
          return;
        }
        if (!location) return;
        ingest({
          lat: location.latitude,
          lng: location.longitude,
          accuracy: location.accuracy,
        });
      },
    );
    bgRunning = true;
    return true;
  } catch (e) {
    console.warn('[carbon] background geolocation failed', e);
    return false;
  }
}

async function startForeground(): Promise<boolean> {
  fgWatch = await watchPosition(
    (p) => ingest(p),
    (message, denied) => {
      useStore.getState().showToast({
        message: denied
          ? 'Location permission denied — GPS tracking is off.'
          : `Location error: ${message}`,
      });
      if (denied) {
        setGpsTrackPref(false);
        void stopRecorder();
      }
    },
  );
  return fgWatch != null;
}

function startTimers(): void {
  stopTimers();
  checkpointTimer = setInterval(() => {
    void saveBuffer();
  }, CHECKPOINT_MS);
  flushTimer = setInterval(() => {
    void flushPending(false);
  }, PERIODIC_FLUSH_MS);
}

function stopTimers(): void {
  if (checkpointTimer) {
    clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/**
 * Ensure the recorder is running for the active session (if pref is on).
 * Idempotent when already bound to the same session.
 */
export async function ensureGpsRecording(): Promise<boolean> {
  if (!gpsTrackPref() || !gpsTrackSupported()) return false;
  if (starting) return true;
  starting = true;
  try {
    await loadBuffer();
    const db = getDb();
    const uid = getCurrentUserId();
    const ctx = getTimeContext(db, uid);
    if (!ctx.session) return false;

    const sessionId = ctx.session.id;
    if (buffer && buffer.sessionId !== sessionId) {
      // Stale buffer from a previous crash — flush under the old session id if
      // we can still attach a note (session may be gone); otherwise drop.
      await flushBufferAsNote(buffer);
      buffer = null;
      await saveBuffer();
    }

    if (!buffer) {
      buffer = { sessionId, points: [], flushedUntilT: 0 };
      await saveBuffer();
    }

    if (bgRunning || fgWatch) return true;

    const ok = isCapacitor ? await startNative() : await startForeground();
    if (!ok && isCapacitor) {
      // Native plugin missing / failed — fall back to foreground watch.
      const fg = await startForeground();
      if (!fg) {
        buffer = null;
        await saveBuffer();
        return false;
      }
    } else if (!ok) {
      buffer = null;
      await saveBuffer();
      return false;
    }
    startTimers();
    return true;
  } finally {
    starting = false;
  }
}

async function stopRecorder(): Promise<void> {
  stopTimers();
  if (fgWatch) {
    fgWatch.clear();
    fgWatch = null;
  }
  if (bgRunning) {
    const mod = await loadCapgo();
    try {
      await mod?.BackgroundGeolocation.stop();
    } catch {
      /* ignore */
    }
    bgRunning = false;
  }
}

/**
 * Flush buffered points as a time note + attachment while the session is still
 * open, then stop the native/foreground watcher. Call *before* stopActive.
 */
export async function flushAndStopGps(): Promise<void> {
  await flushPending(true);
  await stopRecorder();
  buffer = null;
  await saveBuffer();
}

/**
 * Session is about to change (park / switch project). Flush the current buffer
 * under the old session, then rebind to whatever is active after the caller
 * mutates. Call flush before the mutate; call ensureGpsRecording after.
 */
export async function flushGpsForPark(): Promise<void> {
  await flushPending(true);
  // Keep the service running; clear points for the next session.
  if (buffer) {
    buffer = null;
    await saveBuffer();
  }
}

/** Stop watcher without flushing (pref turned off mid-session). */
export async function stopGpsWithoutFlush(): Promise<void> {
  await stopRecorder();
  buffer = null;
  await saveBuffer();
}

/**
 * Persist unflushed points. When `final` is true, include all points; otherwise
 * only flush if we have a meaningful stretch since the last checkpoint flush.
 */
async function flushPending(final: boolean): Promise<void> {
  await loadBuffer();
  if (!buffer || buffer.points.length === 0) return;

  const pending = buffer.points.filter((p) => p.t > buffer!.flushedUntilT);
  // Periodic: need at least 2 points in the pending window; final: allow 1+.
  if (!final && pending.length < 2) return;
  if (final && pending.length === 0) return;

  const slice = final ? buffer.points.slice() : pending;
  const toFlush: BufferState = {
    sessionId: buffer.sessionId,
    points: slice,
    flushedUntilT: 0,
  };
  const ok = await flushBufferAsNote(toFlush);
  if (ok && buffer) {
    const lastT = slice[slice.length - 1]!.t;
    buffer.flushedUntilT = lastT;
    if (final) buffer.points = [];
    await saveBuffer();
  }
}

async function flushBufferAsNote(state: BufferState): Promise<boolean> {
  const file = buildTrackFile(state.sessionId, state.points);
  if (!file || file.points.length === 0) return false;

  const json = JSON.stringify(file);
  const blob = new Blob([json], { type: TRACK_MIME });
  const filename = trackFilename(state.sessionId, file.ended_at);
  // File-like for storeFile (needs name for some paths; Blob is enough for hash).
  const asFile = new File([blob], filename, { type: TRACK_MIME });

  let hash: string;
  try {
    hash = await storeFile(asFile);
  } catch (e) {
    console.warn('[carbon] gps track storeFile failed', e);
    useStore.getState().showToast({ message: 'Could not save GPS track (file too large?)' });
    return false;
  }

  const uid = getCurrentUserId();
  const summary = trackSummaryFromFile(file, hash);
  const summaryJson = JSON.stringify(summary);
  const title = trackNoteTitle(file);

  mutate((db, dev) => {
    // Prefer attaching while the matching session is still the active one.
    const ctx = getTimeContext(db, uid);
    let noteId: string | null = null;

    if (ctx.session?.id === state.sessionId) {
      const result = addTimeNote(db, dev, uid, {
        title,
        metadata: summaryJson,
      });
      if (result) noteId = result.note.id;
    }

    // If the session already closed (crash recovery), attach under the session's
    // project as a plain note without a time-log marker.
    if (!noteId) {
      const sessionRow = db.get<{ item_id: string }>(
        "SELECT item_id FROM time_logs WHERE id = ? AND kind = 'session'",
        [state.sessionId],
      );
      const parentId = sessionRow?.item_id ?? null;
      if (!parentId || !getItem(db, parentId)) return;
      const note = createItem(db, dev, {
        type: 'note',
        title,
        parentId,
        ownerId: uid,
        metadata: summaryJson,
      });
      noteId = note.id;
    }

    addAttachment(db, dev, {
      parentType: 'item',
      parentId: noteId,
      itemId: noteId,
      filename,
      mimeType: TRACK_MIME,
      size: asFile.size,
      hash,
      createdBy: uid,
    });
    updateItem(db, dev, noteId, { metadata: summaryJson });
  });

  return true;
}

/** Recover a buffered track after app launch if pref is on and a session is open. */
export async function resumeGpsIfNeeded(): Promise<void> {
  if (!gpsTrackPref()) return;
  await loadBuffer();
  const db = getDb();
  const ctx = getTimeContext(db, getCurrentUserId());
  if (!ctx.session) {
    // Orphan buffer: try one last flush, then clear.
    if (buffer && buffer.points.length > 0) await flushBufferAsNote(buffer);
    buffer = null;
    await saveBuffer();
    await stopRecorder();
    return;
  }
  await ensureGpsRecording();
}
