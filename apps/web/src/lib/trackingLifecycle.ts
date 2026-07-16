/**
 * Bridges time-tracking start/stop/park UI actions with the GPS track recorder.
 * Call sites should use these instead of raw startTask/stopActive when GPS
 * tracking may be enabled — flush happens *before* the session closes.
 */

import {
  startTask,
  startSession,
  stopActive,
  getTimeContext,
  sessionAnchor,
  getItem,
} from '@carbon/core';
import { getDb } from './db';
import { mutate } from './mutate';
import { getCurrentUserId } from './store';
import {
  gpsTrackPref,
  ensureGpsRecording,
  flushAndStopGps,
  flushGpsForPark,
  stopGpsWithoutFlush,
} from './gpsTrack';

function uid(): string | null {
  return getCurrentUserId();
}

/** True if starting `nextAnchorId` would park the current open session. */
function wouldPark(nextAnchorId: string): boolean {
  const ctx = getTimeContext(getDb(), uid());
  return !!ctx.session && ctx.session.item_id !== nextAnchorId;
}

export async function trackingStartTask(taskId: string): Promise<void> {
  const db = getDb();
  const anchor = sessionAnchor(db, taskId);
  if (gpsTrackPref() && wouldPark(anchor)) {
    await flushGpsForPark();
  }
  mutate((d, dev) => startTask(d, dev, taskId, uid()));
  if (gpsTrackPref()) void ensureGpsRecording();
}

export async function trackingStartSession(projectId: string): Promise<void> {
  if (gpsTrackPref() && wouldPark(projectId)) {
    await flushGpsForPark();
  }
  mutate((d, dev) => startSession(d, dev, projectId, uid()));
  if (gpsTrackPref()) void ensureGpsRecording();
}

export async function trackingStopActive(): Promise<void> {
  if (gpsTrackPref()) {
    await flushAndStopGps();
  }
  mutate((d, dev) => stopActive(d, dev, uid()));
}

/** Resume a parked session from the timer bar chips. */
export async function trackingResumeSuspended(
  resumeFn: (db: ReturnType<typeof getDb>, dev: string) => void,
): Promise<void> {
  if (gpsTrackPref()) await flushGpsForPark();
  mutate(resumeFn);
  if (gpsTrackPref()) void ensureGpsRecording();
}

/** Pref toggled off while a session may be running. */
export async function trackingGpsPrefOff(): Promise<void> {
  await stopGpsWithoutFlush();
}

/** Pref toggled on while a session may already be running. */
export async function trackingGpsPrefOn(): Promise<boolean> {
  const ctx = getTimeContext(getDb(), uid());
  if (!ctx.session) return true;
  return ensureGpsRecording();
}

export function isTrackingItem(itemId: string): boolean {
  const ctx = getTimeContext(getDb(), uid());
  if (!ctx.session) return false;
  if (ctx.task?.item_id === itemId) return true;
  const it = getItem(getDb(), itemId);
  return it?.type === 'project' && ctx.session.item_id === itemId;
}
