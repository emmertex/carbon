import webpush from 'web-push';
import {
  type Db,
  getItem,
  listAssigneesForItem,
  effectiveShares,
  heldTagIds,
  itemHasHeldTag,
} from '@carbon/core';
import { sendFcmToUser } from './fcm';
import { alreadySent, markSent } from './reminders-sent';

function getMeta(db: Db, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null;
}
function setMeta(db: Db, key: string, value: string): void {
  db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export function ensurePushTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders_sent (
      item_id TEXT NOT NULL,
      kind    TEXT NOT NULL,
      marker  TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (item_id, kind, marker)
    );
  `);
}

/** Initialize VAPID keys (from env or generated + persisted) and return the public key. */
export function initVapid(db: Db): string {
  let pub = process.env.VAPID_PUBLIC_KEY || getMeta(db, 'vapid_public');
  let priv = process.env.VAPID_PRIVATE_KEY || getMeta(db, 'vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    setMeta(db, 'vapid_public', pub);
    setMeta(db, 'vapid_private', priv);
  }
  return pub;
}

interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Per-tenant VAPID credentials, passed to each send. Never installed globally via
 *  webpush.setVapidDetails: that mutates a process-wide singleton, so with multiple
 *  tenants (each with its own generated keypair) the last tenant initialized would
 *  sign every other tenant's pushes with the wrong key and the push services reject
 *  them all with 401 "VAPID public key mismatch". */
function vapidDetailsFor(db: Db): VapidDetails | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY || getMeta(db, 'vapid_public');
  const privateKey = process.env.VAPID_PRIVATE_KEY || getMeta(db, 'vapid_private');
  if (!publicKey || !privateKey) return null;
  return { subject: process.env.VAPID_SUBJECT || 'mailto:admin@carbon.local', publicKey, privateKey };
}

interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function saveSubscription(db: Db, userId: string, sub: BrowserSubscription): void {
  db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
       p256dh = excluded.p256dh, auth = excluded.auth`,
    [
      crypto.randomUUID(),
      userId,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      new Date().toISOString(),
    ],
  );
}

export function removeSubscription(db: Db, endpoint: string): void {
  db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Delivery outcome: `targets` counts live subscriptions/tokens attempted (dead
 *  404/410 endpoints removed mid-send don't count); `delivered` counts successes. */
export interface DeliveryResult {
  targets: number;
  delivered: number;
}

async function sendToUser(db: Db, userId: string, payload: PushPayload): Promise<DeliveryResult> {
  const subs = db.all<SubRow>('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [
    userId,
  ]);
  const vapid = vapidDetailsFor(db);
  if (!vapid && subs.length > 0) {
    console.error('[carbon] web push skipped: no VAPID keys for this tenant');
  }
  const result: DeliveryResult = { targets: 0, delivered: 0 };
  const [fcm] = await Promise.all([
    // FCM (Capacitor / Android) — no-op unless a service account is configured
    sendFcmToUser(db, userId, payload),
    // Web Push (browser / desktop PWA)
    ...subs.map(async (s) => {
      if (!vapid) return; // nothing signable
      result.targets++;
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { vapidDetails: vapid },
        );
        result.delivered++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          removeSubscription(db, s.endpoint); // gone
          result.targets--;
        } else {
          console.error('[carbon] web push send failed:', err);
        }
      }
    }),
  ]);
  result.targets += fcm.targets;
  result.delivered += fcm.delivered;
  return result;
}

/** Notify everyone responsible for a task: its owner, assignees, and every user it
 *  is shared with (directly or inherited from an ancestor). */
export async function notifyTask(db: Db, itemId: string, payload: PushPayload): Promise<DeliveryResult> {
  const item = getItem(db, itemId);
  if (!item) return { targets: 0, delivered: 0 };
  const recipients = new Set<string>();
  if (item.owner_id) recipients.add(item.owner_id);
  for (const a of listAssigneesForItem(db, itemId)) recipients.add(a.user_id);
  for (const s of effectiveShares(db, itemId)) recipients.add(s.user_id);
  const results = await Promise.all([...recipients].map((uid) => sendToUser(db, uid, payload)));
  return results.reduce(
    (acc, r) => ({ targets: acc.targets + r.targets, delivered: acc.delivered + r.delivered }),
    { targets: 0, delivered: 0 },
  );
}


interface DueRow {
  id: string;
  title: string;
  due_date: string | null;
  defer_date: string | null;
  reminder_at: string | null;
}

/** Drop reminder markers for deleted items and very old markers, so reminders_sent
 *  can't grow without bound. Gated to run ~hourly per tenant (A10). */
function gcRemindersSent(db: Db): void {
  const now = Date.now();
  const last = Number(getMeta(db, 'reminders_gc_at') ?? 0);
  if (now - last < 3_600_000) return;
  setMeta(db, 'reminders_gc_at', String(now));
  const cutoff = new Date(now - 90 * 86_400_000).toISOString();
  db.run(
    `DELETE FROM reminders_sent
     WHERE sent_at < ? OR item_id NOT IN (SELECT id FROM items WHERE deleted = 0)`,
    [cutoff],
  );
}

/** Scan for due / newly-available / reminder-time tasks and push once each. */
export async function checkReminders(db: Db): Promise<void> {
  gcRemindersSent(db);
  const nowIso = new Date().toISOString();
  const due = db.all<DueRow>(
    `SELECT id, title, due_date, defer_date, reminder_at FROM items
     WHERE deleted = 0 AND status = 'active'
       AND ((due_date IS NOT NULL AND due_date <= ?)
         OR (defer_date IS NOT NULL AND defer_date <= ?)
         OR (reminder_at IS NOT NULL AND reminder_at <= ?))`,
    [nowIso, nowIso, nowIso],
  );
  // A send counts as done when something was delivered, or there was nothing to
  // deliver to (no live subscriptions — matches red-state-only users). When live
  // subscriptions exist but every send failed (push-service outage, bad VAPID
  // signature, …), leave the marker unwritten so the next tick retries, up to a
  // day past the alert time — beyond that, give up rather than flood a user who
  // re-subscribes next week with stale alerts.
  const retryCutoff = new Date(Date.now() - 86_400_000).toISOString();
  // Tasks carrying an on-hold tag behave like deferred — all their alerts are muted.
  const held = heldTagIds(db);
  for (const t of due) {
    if (itemHasHeldTag(db, t.id, held)) continue;
    const kinds = [
      { kind: 'reminder', when: t.reminder_at, title: 'Reminder' },
      { kind: 'due', when: t.due_date, title: 'Task due' },
      { kind: 'defer', when: t.defer_date, title: 'Task now available' },
    ] as const;
    for (const { kind, when, title } of kinds) {
      if (!when || when > nowIso || alreadySent(db, t.id, kind, when)) continue;
      const sent = await notifyTask(db, t.id, {
        title,
        body: t.title || 'Untitled task',
        url: '/today',
        tag: `${kind}:${t.id}`,
      });
      if (sent.delivered > 0 || sent.targets === 0 || when < retryCutoff) {
        markSent(db, t.id, kind, when);
      }
    }
  }
}

/**
 * Sweep reminders for every active tenant once a minute. `dbs` is re-evaluated each
 * tick so newly-provisioned tenants are picked up; reminders fire even when no
 * client is connected (push to a closed PWA). `onTick` (optional) piggybacks the SAME
 * timer — the federation exchange sweep rides here rather than adding a competing timer.
 */
export function startReminderScheduler(dbs: () => Db[], onTick?: () => void | Promise<void>): void {
  setInterval(() => {
    for (const db of dbs()) {
      void checkReminders(db).catch((e) => console.error('[carbon] reminder scan failed:', e));
    }
    if (onTick) {
      void Promise.resolve()
        .then(onTick)
        .catch((e) => console.error('[carbon] sweep onTick failed:', e));
    }
  }, 60_000);
}
