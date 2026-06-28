import webpush from 'web-push';
import { type Db, getItem, listAssigneesForItem } from '@carbon/core';
import { sendFcmToUser } from './fcm';

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
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@carbon.local', pub, priv);
  return pub;
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

async function sendToUser(db: Db, userId: string, payload: PushPayload): Promise<void> {
  const subs = db.all<SubRow>('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [
    userId,
  ]);
  await Promise.all([
    // Web Push (browser / desktop PWA)
    ...subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
        );
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) removeSubscription(db, s.endpoint); // gone
      }
    }),
    // FCM (Capacitor / Android) — no-op unless a service account is configured
    sendFcmToUser(db, userId, payload),
  ]);
}

/** Notify everyone responsible for a task: its owner + assignees. */
export async function notifyTask(db: Db, itemId: string, payload: PushPayload): Promise<void> {
  const item = getItem(db, itemId);
  if (!item) return;
  const recipients = new Set<string>();
  if (item.owner_id) recipients.add(item.owner_id);
  for (const a of listAssigneesForItem(db, itemId)) recipients.add(a.user_id);
  await Promise.all([...recipients].map((uid) => sendToUser(db, uid, payload)));
}

function alreadySent(db: Db, itemId: string, kind: string, marker: string): boolean {
  return !!db.get('SELECT 1 AS x FROM reminders_sent WHERE item_id = ? AND kind = ? AND marker = ?', [
    itemId,
    kind,
    marker,
  ]);
}
function markSent(db: Db, itemId: string, kind: string, marker: string): void {
  db.run(
    `INSERT INTO reminders_sent (item_id, kind, marker, sent_at) VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [itemId, kind, marker, new Date().toISOString()],
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
  for (const t of due) {
    if (t.reminder_at && t.reminder_at <= nowIso && !alreadySent(db, t.id, 'reminder', t.reminder_at)) {
      await notifyTask(db, t.id, {
        title: 'Reminder',
        body: t.title || 'Untitled task',
        url: '/today',
        tag: `reminder:${t.id}`,
      });
      markSent(db, t.id, 'reminder', t.reminder_at);
    }
    if (t.due_date && t.due_date <= nowIso && !alreadySent(db, t.id, 'due', t.due_date)) {
      await notifyTask(db, t.id, {
        title: 'Task due',
        body: t.title || 'Untitled task',
        url: '/today',
        tag: `due:${t.id}`,
      });
      markSent(db, t.id, 'due', t.due_date);
    }
    if (t.defer_date && t.defer_date <= nowIso && !alreadySent(db, t.id, 'defer', t.defer_date)) {
      await notifyTask(db, t.id, {
        title: 'Task now available',
        body: t.title || 'Untitled task',
        url: '/today',
        tag: `defer:${t.id}`,
      });
      markSent(db, t.id, 'defer', t.defer_date);
    }
  }
}

/**
 * Sweep reminders for every active tenant once a minute. `dbs` is re-evaluated each
 * tick so newly-provisioned tenants are picked up; reminders fire even when no
 * client is connected (push to a closed PWA).
 */
export function startReminderScheduler(dbs: () => Db[]): void {
  setInterval(() => {
    for (const db of dbs()) {
      void checkReminders(db).catch((e) => console.error('[carbon] reminder scan failed:', e));
    }
  }, 60_000);
}
