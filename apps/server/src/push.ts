import webpush from "web-push";
import {
  type Db,
  getItem,
  listAssigneesForItem,
  effectiveShares,
  heldTagIds,
} from "@carbon/core";
import { sendFcmToUser } from "./fcm";
import { alreadySent, markSent } from "./reminders-sent";
import { Semaphore } from "./concurrency";
import { withSafeHttpsAgent } from "./safe-fetch";

/** A2: bound on concurrent outbound web-push sends across ALL tenants. A task shared
 *  with many users (each with several device subscriptions) would otherwise fan out into
 *  a burst of unbounded concurrent HTTP calls to push providers. The semaphore caps both active sends and waiters; rejected sends remain undelivered
 *  for the caller's retry policy.
 *  Override with PUSH_MAX_CONCURRENT; 0 = unlimited. */
const PUSH_MAX_CONCURRENT = Math.floor(
  Number(process.env.PUSH_MAX_CONCURRENT) || 16,
);
const pushSendSem = new Semaphore(PUSH_MAX_CONCURRENT);

function getMeta(db: Db, key: string): string | null {
  return (
    db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key])
      ?.value ?? null
  );
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
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id, endpoint);
  `);
  // J: consecutive permanent-failure counter (400/413) — added in place for
  // existing tenant DBs; a subscription is dropped after PUSH_MAX_FAILURES in a row.
  const cols = db.all<{ name: string }>("PRAGMA table_info(push_subscriptions)");
  if (!cols.some((c) => c.name === "failures")) {
    db.exec(
      "ALTER TABLE push_subscriptions ADD COLUMN failures INTEGER NOT NULL DEFAULT 0",
    );
  }
}

/** Initialize VAPID keys (from env or generated + persisted) and return the public key. */
export function initVapid(db: Db): string {
  let pub = process.env.VAPID_PUBLIC_KEY || getMeta(db, "vapid_public");
  let priv = process.env.VAPID_PRIVATE_KEY || getMeta(db, "vapid_private");
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    setMeta(db, "vapid_public", pub);
    setMeta(db, "vapid_private", priv);
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
  const publicKey = process.env.VAPID_PUBLIC_KEY || getMeta(db, "vapid_public");
  const privateKey =
    process.env.VAPID_PRIVATE_KEY || getMeta(db, "vapid_private");
  if (!publicKey || !privateKey) return null;
  return {
    subject: process.env.VAPID_SUBJECT || "mailto:admin@carbon.local",
    publicKey,
    privateKey,
  };
}

interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function saveSubscription(
  db: Db,
  userId: string,
  sub: BrowserSubscription,
): void {
  db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
       p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
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
  db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  failures: number;
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

/** J: web-push statuses that mean the subscription itself is bad (malformed, payload
 *  rejected) rather than a transient outage. 403 is deliberately excluded: it is what a
 *  tenant-wide VAPID key problem looks like, and counting it would wipe every
 *  subscription in the tenant instead of surfacing the key fault. Counted per
 *  subscription; after PUSH_MAX_FAILURES consecutive ones the subscription is dropped
 *  so a dead target can't keep a user's alerts in the retry loop forever. */
const PERMANENT_WEB_PUSH_STATUS = new Set([400, 413]);
const PUSH_MAX_FAILURES = Math.max(
  1,
  Math.floor(Number(process.env.PUSH_MAX_FAILURES) || 3),
);

/** Send to one web-push subscription; returns whether it counts as a live target and
 *  whether it was delivered. */
async function sendWebPush(
  db: Db,
  s: SubRow,
  vapid: VapidDetails,
  payload: PushPayload,
): Promise<DeliveryResult> {
  try {
    // Admit before DNS, cap waiting work, pin the validated DNS answers and
    // bound the entire send. Queued/rejected subscriptions remain stored.
    await pushSendSem.run(() =>
      withSafeHttpsAgent(s.endpoint, (agent) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { vapidDetails: vapid, agent, timeout: 15_000 },
        ),
      ),
    );
    if (s.failures)
      db.run("UPDATE push_subscriptions SET failures = 0 WHERE endpoint = ?", [
        s.endpoint,
      ]);
    return { targets: 1, delivered: 1 };
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) {
      removeSubscription(db, s.endpoint); // gone
      return { targets: 0, delivered: 0 };
    }
    if (code !== undefined && PERMANENT_WEB_PUSH_STATUS.has(code)) {
      const row = db.get<{ failures: number }>(
        `UPDATE push_subscriptions SET failures = failures + 1
         WHERE endpoint = ? RETURNING failures`,
        [s.endpoint],
      );
      if (!row || row.failures >= PUSH_MAX_FAILURES) {
        removeSubscription(db, s.endpoint);
        console.warn(
          `[carbon] web push subscription dropped after ${PUSH_MAX_FAILURES} consecutive ${code} failures`,
        );
        return { targets: 0, delivered: 0 };
      }
    }
    console.error("[carbon] web push send failed:", err);
    return { targets: 1, delivered: 0 };
  }
}

export async function sendToUser(
  db: Db,
  userId: string,
  payload: PushPayload,
): Promise<DeliveryResult> {
  const vapid = vapidDetailsFor(db);
  // D: collect every target first, then send FCM + all web-push subscriptions in
  // parallel; pushSendSem / fcmSem bound the actual concurrency.
  const subs = vapid
    ? db.all<SubRow>(
        "SELECT endpoint, p256dh, auth, failures FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint",
        [userId],
      )
    : [];
  const settled = await Promise.allSettled([
    sendFcmToUser(db, userId, payload),
    ...subs.map((s) => sendWebPush(db, s, vapid!, payload)),
  ]);
  return sumResults(settled);
}

function sumResults(
  settled: PromiseSettledResult<DeliveryResult>[],
): DeliveryResult {
  const result: DeliveryResult = { targets: 0, delivered: 0 };
  for (const r of settled) {
    if (r.status === "fulfilled") {
      result.targets += r.value.targets;
      result.delivered += r.value.delivered;
    } else {
      // Unexpected throw: count as an undelivered live target so the caller retries.
      console.error("[carbon] push send error:", r.reason);
      result.targets++;
    }
  }
  return result;
}

/** Notify everyone responsible for a task: its owner, assignees, and every user it
 *  is shared with (directly or inherited from an ancestor). */
export async function notifyTask(
  db: Db,
  itemId: string,
  payload: PushPayload,
): Promise<DeliveryResult> {
  const item = getItem(db, itemId);
  if (!item) return { targets: 0, delivered: 0 };
  const recipients = new Set<string>();
  if (item.owner_id) recipients.add(item.owner_id);
  for (const a of listAssigneesForItem(db, itemId)) recipients.add(a.user_id);
  for (const s of effectiveShares(db, itemId)) recipients.add(s.user_id);
  return sumResults(
    await Promise.allSettled(
      [...recipients].map((uid) => sendToUser(db, uid, payload)),
    ),
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
  const last = Number(getMeta(db, "reminders_gc_at") ?? 0);
  if (now - last < 3_600_000) return;
  setMeta(db, "reminders_gc_at", String(now));
  const cutoff = new Date(now - 90 * 86_400_000).toISOString();
  db.run(
    `DELETE FROM reminders_sent
     WHERE sent_at < ? OR item_id NOT IN (SELECT id FROM items WHERE deleted = 0)`,
    [cutoff],
  );
}

/** E: max items examined per tenant per tick; leftovers are reached on later ticks. */
const REMINDER_SCAN_LIMIT = Math.max(
  1,
  Math.floor(Number(process.env.REMINDER_SCAN_LIMIT) || 200),
);
/** D: wall-clock budget per tenant per tick, so one slow tenant (slow push endpoints,
 *  huge backlog) can't hold the sweep slot for everyone else. Items not reached are
 *  picked up on the next tick. */
const REMINDER_TENANT_BUDGET_MS = Math.max(
  1,
  Math.floor(Number(process.env.REMINDER_TENANT_BUDGET_MS) || 20_000),
);

/** Per-tenant round-robin cursor (item id) so a LIMITed scan can't starve: items that
 *  keep failing delivery stay in the candidate set, so a fixed ORDER BY … LIMIT would
 *  re-pick the same head forever. Keyed by Db handle; no strong reference held. */
const scanCursor = new WeakMap<Db, string>();

export interface CheckRemindersOptions {
  /** Override REMINDER_SCAN_LIMIT (tests). */
  limit?: number;
  /** Override REMINDER_TENANT_BUDGET_MS (tests). */
  budgetMs?: number;
}

/** One alert kind's candidate term: past due, not already marked for this exact
 *  (item, kind, marker) — identical to the alreadySent() dedupe. */
const kindTerm = (kind: string, col: string) => `
  SELECT id, title, due_date, defer_date, reminder_at FROM items
  WHERE deleted = 0 AND status = 'active' AND ${col} IS NOT NULL AND ${col} <= ?1
    AND NOT EXISTS (SELECT 1 FROM reminders_sent r
                    WHERE r.item_id = items.id AND r.kind = '${kind}' AND r.marker = items.${col})`;

/** Scan for due / newly-available / reminder-time tasks and push once each. */
export async function checkReminders(
  db: Db,
  opts: CheckRemindersOptions = {},
): Promise<void> {
  gcRemindersSent(db);
  const deadline = Date.now() + (opts.budgetMs ?? REMINDER_TENANT_BUDGET_MS);
  const limit = opts.limit ?? REMINDER_SCAN_LIMIT;
  const nowIso = new Date().toISOString();
  // Tasks carrying an on-hold tag behave like deferred — all their alerts are muted
  // (same test as itemHasHeldTag, done in SQL so muted items don't eat the LIMIT).
  const held = [...heldTagIds(db)];
  const cursor = scanCursor.get(db) ?? "";
  // Each UNION arm can use its partial index (idx_items_*_active); items whose every
  // past-due alert is already marked never leave SQL.
  const due = db.all<DueRow>(
    `SELECT * FROM (
       ${kindTerm("reminder", "reminder_at")}
       UNION ${kindTerm("due", "due_date")}
       UNION ${kindTerm("defer", "defer_date")}
     ) c
     WHERE c.id > ?2
       AND NOT EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id
                       WHERE it.item_id = c.id AND it.deleted = 0 AND t.deleted = 0
                         AND it.tag_id IN (SELECT value FROM json_each(?3)))
     ORDER BY c.id LIMIT ?4`,
    [nowIso, cursor, JSON.stringify(held), limit],
  );
  // A send counts as done when something was delivered, or there was nothing to
  // deliver to (no live subscriptions — matches red-state-only users). When live
  // subscriptions exist but every send failed (push-service outage, bad VAPID
  // signature, …), leave the marker unwritten so the next tick retries, up to a
  // day past the alert time — beyond that, give up rather than flood a user who
  // re-subscribes next week with stale alerts.
  const retryCutoff = new Date(Date.now() - 86_400_000).toISOString();
  let last: string | null = null;
  let outOfTime = false;
  for (const t of due) {
    if (Date.now() >= deadline) {
      outOfTime = true;
      break;
    }
    const kinds = [
      { kind: "reminder", when: t.reminder_at, title: "Reminder" },
      { kind: "due", when: t.due_date, title: "Task due" },
      { kind: "defer", when: t.defer_date, title: "Task now available" },
    ] as const;
    for (const { kind, when, title } of kinds) {
      if (!when || when > nowIso || alreadySent(db, t.id, kind, when)) continue;
      const sent = await notifyTask(db, t.id, {
        title,
        body: t.title || "Untitled task",
        url: "/today",
        tag: `${kind}:${t.id}`,
      });
      if (sent.delivered > 0 || sent.targets === 0 || when < retryCutoff) {
        markSent(db, t.id, kind, when);
      }
    }
    last = t.id;
  }
  // Advance the round-robin cursor past what was processed; wrap to the start once a
  // pass reaches the end of the candidate set.
  if (outOfTime || due.length >= limit) {
    if (last !== null) scanCursor.set(db, last);
  } else {
    scanCursor.delete(db);
  }
}

/**
 * Sweep reminders for every active tenant once a minute. `sweep` visits the default
 * tenant and every active tenant (bounded, holding a DB lease per job — see
 * TenantRegistry.sweepActive) and is re-run each tick so newly-provisioned tenants are
 * picked up; reminders fire even when no client is connected (push to a closed PWA).
 * `onTick` (optional) piggybacks the SAME timer — the federation exchange sweep rides
 * here rather than adding a competing timer.
 */
export function startReminderScheduler(
  sweep: (job: (db: Db) => Promise<void>) => Promise<void>,
  onTick?: () => void | Promise<void>,
): void {
  // A2: bounded background queue — at most ONE reminder sweep at a time. A scan fans
  // out pushes (itself bounded by pushSendSem) and can run a long time on a large
  // workspace; without this, each 60s tick that fires while the previous sweep is still
  // running stacks another full sweep on top, growing unbounded. The next tick retries.
  let scanning = false;
  let ticking = false;
  setInterval(() => {
    if (!scanning) {
      scanning = true;
      void sweep((db) =>
        checkReminders(db).catch((e) =>
          console.error("[carbon] reminder scan failed:", e),
        ),
      )
        .catch((e) => console.error("[carbon] reminder sweep failed:", e))
        .finally(() => (scanning = false));
    }
    if (onTick && !ticking) {
      ticking = true;
      void Promise.resolve()
        .then(onTick)
        .catch((e) => console.error("[carbon] sweep onTick failed:", e))
        .finally(() => (ticking = false));
    }
  }, 60_000);
}
