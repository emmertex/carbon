import { randomUUID } from "node:crypto";
import {
  type Db,
  type Item,
  getItem,
  getChildren,
  createItem,
  updateItem,
  setCompleted,
  deleteItem,
} from "@carbon/core";
import { safeFetch } from "./safe-fetch";
import {
  itemToVtodo,
  itemToVevent,
  vtodoToItemPatch,
  veventToItemPatch,
  contentHash,
  detectKind,
} from "./caldav-ical";

// ----- server-only schema (NOT CRDT-synced; holds secrets) ------------------

export function ensureCaldavTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS caldav_configs (
      project_id            TEXT PRIMARY KEY,
      base_url              TEXT,
      username              TEXT,
      password              TEXT,
      todo_url              TEXT,
      event_url             TEXT,
      sync_tasks            INTEGER NOT NULL DEFAULT 0,
      sync_events           INTEGER NOT NULL DEFAULT 0,
      enabled               INTEGER NOT NULL DEFAULT 1,
      frequency_seconds     INTEGER NOT NULL DEFAULT 300,
      default_event_minutes INTEGER NOT NULL DEFAULT 30,
      todo_sync_token       TEXT,
      event_sync_token      TEXT,
      last_sync_at          TEXT,
      last_status           TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS caldav_links (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      item_id       TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK(kind IN ('todo','event')),
      remote_uid    TEXT NOT NULL,
      href          TEXT NOT NULL,
      etag          TEXT,
      content_hash  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(project_id, item_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_caldav_links_item ON caldav_links(item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_caldav_links_uid
      ON caldav_links(project_id, kind, remote_uid);
  `);
}

/** A persistent random device id for the connector, distinct from the server's own,
 *  so its CRDT ops are attributable and never seeded deterministically (federation
 *  invariant). Inbound remote changes are stamped with this id and fan out via /api/sync. */
export function ensureCaldavDeviceId(db: Db): string {
  const row = db.get<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
    ["caldav_device_id"],
  );
  if (row?.value) return row.value;
  const id = randomUUID();
  db.run(
    `INSERT INTO meta (key, value) VALUES ('caldav_device_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [id],
  );
  return id;
}

// ----- config CRUD ----------------------------------------------------------

export interface CaldavConfigRow {
  project_id: string;
  base_url: string | null;
  username: string | null;
  password: string | null;
  todo_url: string | null;
  event_url: string | null;
  sync_tasks: number;
  sync_events: number;
  enabled: number;
  frequency_seconds: number;
  default_event_minutes: number;
  todo_sync_token: string | null;
  event_sync_token: string | null;
  last_sync_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

/** Public projection (no password) for REST responses. */
export interface PublicCaldavConfig {
  project_id: string;
  base_url: string | null;
  username: string | null;
  todo_url: string | null;
  event_url: string | null;
  sync_tasks: boolean;
  sync_events: boolean;
  enabled: boolean;
  frequency_seconds: number;
  default_event_minutes: number;
  last_sync_at: string | null;
  last_status: string | null;
  has_password: boolean;
}

export function getCaldavConfigRow(
  db: Db,
  projectId: string,
): CaldavConfigRow | undefined {
  return db.get<CaldavConfigRow>(
    "SELECT * FROM caldav_configs WHERE project_id = ?",
    [projectId],
  );
}

export function publicCaldavConfig(row: CaldavConfigRow): PublicCaldavConfig {
  return {
    project_id: row.project_id,
    base_url: row.base_url,
    username: row.username,
    todo_url: row.todo_url,
    event_url: row.event_url,
    sync_tasks: !!row.sync_tasks,
    sync_events: !!row.sync_events,
    enabled: !!row.enabled,
    frequency_seconds: row.frequency_seconds,
    default_event_minutes: row.default_event_minutes,
    last_sync_at: row.last_sync_at,
    last_status: row.last_status,
    has_password: !!row.password,
  };
}

/** Enabled configs that have at least one sync flavour switched on. */
export function listEnabledConfigs(db: Db): CaldavConfigRow[] {
  return db.all<CaldavConfigRow>(
    `SELECT * FROM caldav_configs WHERE enabled = 1 AND (sync_tasks = 1 OR sync_events = 1)`,
  );
}

export interface CaldavConfigPatch {
  base_url?: string | null;
  username?: string | null;
  password?: string | null;
  todo_url?: string | null;
  event_url?: string | null;
  sync_tasks?: boolean;
  sync_events?: boolean;
  enabled?: boolean;
  frequency_seconds?: number;
  default_event_minutes?: number;
}

/** Upsert config. An omitted (or empty-string) `password` keeps the stored one. */
export function upsertCaldavConfig(
  db: Db,
  projectId: string,
  patch: CaldavConfigPatch,
): CaldavConfigRow {
  const now = new Date().toISOString();
  const ex = getCaldavConfigRow(db, projectId);
  const str = (
    v: string | null | undefined,
    fb: string | null,
  ): string | null => (v === undefined ? fb : v === "" ? null : v);
  const bool = (v: boolean | undefined, fb: number): number =>
    v === undefined ? fb : v ? 1 : 0;

  const row: CaldavConfigRow = {
    project_id: projectId,
    base_url: str(patch.base_url, ex?.base_url ?? null),
    username: str(patch.username, ex?.username ?? null),
    // password: empty/undefined keeps the existing secret (matches agents.api_key UX)
    password: patch.password ? patch.password : (ex?.password ?? null),
    todo_url: str(patch.todo_url, ex?.todo_url ?? null),
    event_url: str(patch.event_url, ex?.event_url ?? null),
    sync_tasks: bool(patch.sync_tasks, ex?.sync_tasks ?? 0),
    sync_events: bool(patch.sync_events, ex?.sync_events ?? 0),
    enabled: bool(patch.enabled, ex?.enabled ?? 1),
    frequency_seconds: Math.max(
      60,
      patch.frequency_seconds ?? ex?.frequency_seconds ?? 300,
    ),
    default_event_minutes: Math.max(
      1,
      patch.default_event_minutes ?? ex?.default_event_minutes ?? 30,
    ),
    todo_sync_token: ex?.todo_sync_token ?? null,
    event_sync_token: ex?.event_sync_token ?? null,
    last_sync_at: ex?.last_sync_at ?? null,
    last_status: ex?.last_status ?? null,
    created_at: ex?.created_at ?? now,
    updated_at: now,
  };
  db.run(
    `INSERT INTO caldav_configs
       (project_id, base_url, username, password, todo_url, event_url, sync_tasks, sync_events,
        enabled, frequency_seconds, default_event_minutes, todo_sync_token, event_sync_token,
        last_sync_at, last_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(project_id) DO UPDATE SET
       base_url=excluded.base_url, username=excluded.username, password=excluded.password,
       todo_url=excluded.todo_url, event_url=excluded.event_url, sync_tasks=excluded.sync_tasks,
       sync_events=excluded.sync_events, enabled=excluded.enabled,
       frequency_seconds=excluded.frequency_seconds,
       default_event_minutes=excluded.default_event_minutes, updated_at=excluded.updated_at`,
    [
      row.project_id,
      row.base_url,
      row.username,
      row.password,
      row.todo_url,
      row.event_url,
      row.sync_tasks,
      row.sync_events,
      row.enabled,
      row.frequency_seconds,
      row.default_event_minutes,
      row.todo_sync_token,
      row.event_sync_token,
      row.last_sync_at,
      row.last_status,
      row.created_at,
      row.updated_at,
    ],
  );
  return getCaldavConfigRow(db, projectId)!;
}

export function deleteCaldavConfig(db: Db, projectId: string): void {
  db.run("DELETE FROM caldav_links WHERE project_id = ?", [projectId]);
  db.run("DELETE FROM caldav_configs WHERE project_id = ?", [projectId]);
}

function setSyncState(db: Db, projectId: string, status: string): void {
  db.run(
    "UPDATE caldav_configs SET last_sync_at = ?, last_status = ? WHERE project_id = ?",
    [new Date().toISOString(), status, projectId],
  );
}

// ----- link CRUD ------------------------------------------------------------

export type LinkKind = "todo" | "event";

interface LinkRow {
  id: string;
  project_id: string;
  item_id: string;
  kind: LinkKind;
  remote_uid: string;
  href: string;
  etag: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

function linksForKind(db: Db, projectId: string, kind: LinkKind): LinkRow[] {
  return db.all<LinkRow>(
    "SELECT * FROM caldav_links WHERE project_id = ? AND kind = ?",
    [projectId, kind],
  );
}

function linkByItem(
  db: Db,
  projectId: string,
  itemId: string,
  kind: LinkKind,
): LinkRow | undefined {
  return db.get<LinkRow>(
    "SELECT * FROM caldav_links WHERE project_id = ? AND item_id = ? AND kind = ?",
    [projectId, itemId, kind],
  );
}

function upsertLink(
  db: Db,
  projectId: string,
  itemId: string,
  kind: LinkKind,
  uid: string,
  href: string,
  etag: string | null,
  hash: string | null,
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO caldav_links (id, project_id, item_id, kind, remote_uid, href, etag, content_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(project_id, item_id, kind) DO UPDATE SET
       remote_uid=excluded.remote_uid, href=excluded.href, etag=excluded.etag,
       content_hash=excluded.content_hash, updated_at=excluded.updated_at`,
    [randomUUID(), projectId, itemId, kind, uid, href, etag, hash, now, now],
  );
}

function setLinkState(
  db: Db,
  id: string,
  etag: string | null,
  hash: string | null,
): void {
  db.run(
    "UPDATE caldav_links SET etag = ?, content_hash = ?, updated_at = ? WHERE id = ?",
    [etag, hash, new Date().toISOString(), id],
  );
}

function deleteLinkById(db: Db, id: string): void {
  db.run("DELETE FROM caldav_links WHERE id = ?", [id]);
}

// ----- DAV transport (hand-rolled over the shared SSRF guard) ---------------

export class CaldavHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`${status}: ${detail}`);
  }
}

function authHeader(cfg: CaldavConfigRow): string {
  return (
    "Basic " +
    Buffer.from(`${cfg.username ?? ""}:${cfg.password ?? ""}`).toString(
      "base64",
    )
  );
}

function normEtag(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^W\//i, "").replace(/^"|"$/g, "").trim() || null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function resolveHref(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function sameCollection(href: string, collectionUrl: string): boolean {
  const a = href.replace(/\/$/, "");
  const b = collectionUrl.replace(/\/$/, "");
  return a === b;
}

/** PROPFIND Depth:1 for ETags → map of absolute resource href → etag. */
async function davListEtags(
  collectionUrl: string,
  cfg: CaldavConfigRow,
  allowPrivate: boolean,
): Promise<Map<string, string>> {
  const body =
    '<?xml version="1.0" encoding="utf-8" ?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>';
  const res = await safeFetch(collectionUrl, allowPrivate, {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader(cfg),
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });
  if (!res.ok)
    throw new CaldavHttpError(res.status, `PROPFIND ${collectionUrl}`);
  const xml = await res.text();
  const out = new Map<string, string>();
  const blocks =
    xml.match(/<[^>]*response[^>]*>[\s\S]*?<\/[^>]*response>/gi) ?? [];
  for (const block of blocks) {
    const hrefM = /<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i.exec(block);
    const etagM = /<[^>]*getetag[^>]*>([\s\S]*?)<\/[^>]*getetag>/i.exec(block);
    if (!hrefM) continue;
    const abs = resolveHref(decodeEntities(hrefM[1].trim()), collectionUrl);
    if (sameCollection(abs, collectionUrl)) continue; // the collection's own row
    const etag = etagM ? normEtag(decodeEntities(etagM[1])) : null;
    if (!etag) continue; // a sub-collection or row without an etag
    out.set(abs, etag);
  }
  return out;
}

async function davGet(
  href: string,
  cfg: CaldavConfigRow,
  allowPrivate: boolean,
): Promise<{ ics: string; etag: string | null }> {
  const res = await safeFetch(href, allowPrivate, {
    method: "GET",
    headers: { Authorization: authHeader(cfg) },
  });
  if (!res.ok) throw new CaldavHttpError(res.status, `GET ${href}`);
  return { ics: await res.text(), etag: normEtag(res.headers.get("etag")) };
}

interface PutResult {
  status: number;
  etag: string | null;
}

async function davPut(
  href: string,
  ics: string,
  ifMatch: string | null,
  cfg: CaldavConfigRow,
  allowPrivate: boolean,
): Promise<PutResult> {
  const headers: Record<string, string> = {
    Authorization: authHeader(cfg),
    "Content-Type": "text/calendar; charset=utf-8",
  };
  if (ifMatch) headers["If-Match"] = `"${ifMatch}"`;
  else headers["If-None-Match"] = "*"; // create-only; 412 ⇒ already exists
  const res = await safeFetch(href, allowPrivate, {
    method: "PUT",
    headers,
    body: ics,
  });
  if (res.status === 412) return { status: 412, etag: null };
  if (!res.ok) throw new CaldavHttpError(res.status, `PUT ${href}`);
  let etag = normEtag(res.headers.get("etag"));
  if (!etag) {
    // Server didn't return the new ETag on PUT — read it back so the next pull
    // recognises our own write (echo suppression).
    try {
      etag = (await davGet(href, cfg, allowPrivate)).etag;
    } catch {
      /* leave null; next pull will re-fetch and reconcile */
    }
  }
  return { status: res.status, etag };
}

async function davDelete(
  href: string,
  ifMatch: string | null,
  cfg: CaldavConfigRow,
  allowPrivate: boolean,
): Promise<void> {
  const headers: Record<string, string> = { Authorization: authHeader(cfg) };
  if (ifMatch) headers["If-Match"] = `"${ifMatch}"`;
  const res = await safeFetch(href, allowPrivate, {
    method: "DELETE",
    headers,
  });
  // 404 (already gone) and 412 (changed underneath us) are benign for a delete.
  if (!res.ok && res.status !== 404 && res.status !== 412)
    throw new CaldavHttpError(res.status, `DELETE ${href}`);
}

// ----- subtree enumeration --------------------------------------------------

/** All task-type descendants of a project (flat). Descends through tasks only, so a
 *  nested sub-project with its own CalDAV config isn't double-synced. */
function taskDescendants(db: Db, projectId: string): Item[] {
  const out: Item[] = [];
  const queue = getChildren(db, projectId);
  while (queue.length) {
    const c = queue.shift()!;
    if (c.type === "task") {
      out.push(c);
      queue.push(...getChildren(db, c.id));
    }
  }
  return out;
}

// ----- the per-kind sync engine ---------------------------------------------

export interface SyncResult {
  pulled: number;
  pushed: number;
  errors: string[];
}

function newHref(collectionUrl: string, uid: string): string {
  return (
    collectionUrl.replace(/\/$/, "") + "/" + encodeURIComponent(uid) + ".ics"
  );
}

function encode(
  kind: LinkKind,
  item: Item,
  uid: string,
  defaultMinutes: number,
): string {
  return kind === "todo"
    ? itemToVtodo(item, uid)
    : itemToVevent(item, uid, defaultMinutes);
}

/** Apply a parsed remote object onto a Carbon item (existing) via CRDT mutators. */
function applyParsed(
  db: Db,
  deviceId: string,
  itemId: string,
  kind: LinkKind,
  ics: string,
): void {
  if (kind === "todo") {
    const p = vtodoToItemPatch(ics);
    if (!p) return;
    updateItem(db, deviceId, itemId, p.patch);
    const cur = getItem(db, itemId);
    if (!cur) return;
    if (p.completed && cur.status !== "done")
      setCompleted(db, deviceId, itemId, true);
    else if (!p.completed && cur.status === "done")
      setCompleted(db, deviceId, itemId, false);
  } else {
    const p = veventToItemPatch(ics);
    if (!p) return;
    updateItem(db, deviceId, itemId, p.patch);
  }
}

async function syncKind(
  db: Db,
  deviceId: string,
  cfg: CaldavConfigRow,
  kind: LinkKind,
  collectionUrl: string,
  allowPrivate: boolean,
  result: SyncResult,
): Promise<void> {
  const projectId = cfg.project_id;
  const def = cfg.default_event_minutes;

  // ---- PULL: remote → CRDT ops ----
  const remote = await davListEtags(collectionUrl, cfg, allowPrivate);
  const byHref = new Map<string, LinkRow>();
  for (const l of linksForKind(db, projectId, kind)) byHref.set(l.href, l);

  const seen = new Set<string>();
  for (const [href, etag] of remote) {
    seen.add(href);
    const link = byHref.get(href);
    if (link && link.etag === etag) continue; // unchanged (incl. echo of our own PUT)
    const got = await davGet(href, cfg, allowPrivate);
    if (detectKind(got.ics) !== kind) continue; // mixed collection — wrong type here
    const curEtag = got.etag ?? etag;

    if (
      link &&
      getItem(db, link.item_id) &&
      !getItem(db, link.item_id)!.deleted
    ) {
      // existing, present locally → merge remote changes in
      applyParsed(db, deviceId, link.item_id, kind, got.ics);
      const it = getItem(db, link.item_id)!;
      setLinkState(db, link.id, curEtag, contentHash(kind, it, def));
    } else {
      // new remote object → create a task under the project
      const parsed =
        kind === "todo"
          ? vtodoToItemPatch(got.ics)
          : veventToItemPatch(got.ics);
      if (!parsed) continue;
      const uid = parsed.uid ?? href;
      const created = createItem(db, deviceId, {
        type: "task",
        title: parsed.title,
        parentId: projectId,
        note: parsed.patch.note ?? null,
        dueDate: parsed.patch.due_date ?? null,
        deferDate: kind === "todo" ? (parsed.patch.defer_date ?? null) : null,
        priority: kind === "todo" ? (parsed.patch.priority ?? 0) : 0,
      });
      if (parsed.patch.estimate_minutes)
        updateItem(db, deviceId, created.id, {
          estimate_minutes: parsed.patch.estimate_minutes,
        });
      if (
        kind === "todo" &&
        (parsed as ReturnType<typeof vtodoToItemPatch>)?.completed
      )
        setCompleted(db, deviceId, created.id, true);
      const it = getItem(db, created.id)!;
      upsertLink(
        db,
        projectId,
        created.id,
        kind,
        uid,
        href,
        curEtag,
        contentHash(kind, it, def),
      );
    }
    result.pulled++;
  }

  // remote deletions: a link whose href vanished from the collection
  for (const link of linksForKind(db, projectId, kind)) {
    if (seen.has(link.href)) continue;
    if (kind === "todo") {
      deleteItem(db, deviceId, link.item_id); // soft-delete (recoverable)
    } else {
      updateItem(db, deviceId, link.item_id, { due_date: null }); // keep task, drop the date
    }
    deleteLinkById(db, link.id);
    result.pulled++;
  }

  // ---- PUSH: snapshot-diff → remote ----
  const tasks = taskDescendants(db, projectId);
  // desired = items that should have a link of this kind right now
  const desired = new Map<string, Item>();
  for (const t of tasks) {
    if (kind === "todo") desired.set(t.id, t);
    else if (t.due_date && t.status !== "done") desired.set(t.id, t);
  }

  // updates + deletions over existing links
  for (const link of linksForKind(db, projectId, kind)) {
    const item = getItem(db, link.item_id);
    // freeze: a completed calendar-synced task keeps its VEVENT untouched
    if (kind === "event" && item && !item.deleted && item.status === "done")
      continue;

    const want = desired.get(link.item_id);
    if (!want || !item || item.deleted) {
      // item deleted / moved out / due cleared → remove the remote object
      await davDelete(link.href, link.etag, cfg, allowPrivate);
      deleteLinkById(db, link.id);
      result.pushed++;
      continue;
    }
    const hash = contentHash(kind, want, def);
    if (link.content_hash === hash) continue; // unchanged locally
    const ics = encode(kind, want, link.remote_uid, def);
    let res = await davPut(link.href, ics, link.etag, cfg, allowPrivate);
    if (res.status === 412) {
      // conflict: pull the remote, re-merge through the CRDT, push once more
      const got = await davGet(link.href, cfg, allowPrivate);
      applyParsed(db, deviceId, link.item_id, kind, got.ics);
      const merged = getItem(db, link.item_id)!;
      const ics2 = encode(kind, merged, link.remote_uid, def);
      res = await davPut(link.href, ics2, got.etag, cfg, allowPrivate);
      if (res.status === 412) {
        result.errors.push(`conflict on ${link.item_id.slice(0, 8)} (${kind})`);
        continue;
      }
      setLinkState(db, link.id, res.etag, contentHash(kind, merged, def));
    } else {
      setLinkState(db, link.id, res.etag, hash);
    }
    result.pushed++;
  }

  // creates for desired items that have no link yet
  for (const [itemId, item] of desired) {
    if (linkByItem(db, projectId, itemId, kind)) continue;
    const uid = `carbon-${itemId}-${kind}@carbon`;
    const href = newHref(collectionUrl, uid);
    const hash = contentHash(kind, item, def);
    const ics = encode(kind, item, uid, def);
    let res = await davPut(href, ics, null, cfg, allowPrivate);
    if (res.status === 412) {
      // a stale object with our UID already exists — adopt + overwrite it
      const got = await davGet(href, cfg, allowPrivate);
      res = await davPut(href, ics, got.etag, cfg, allowPrivate);
      if (res.status === 412) {
        result.errors.push(
          `create conflict on ${itemId.slice(0, 8)} (${kind})`,
        );
        continue;
      }
    }
    upsertLink(db, projectId, itemId, kind, uid, href, res.etag, hash);
    result.pushed++;
  }
}

/** Run one full sync pass for a project (both enabled kinds). */
export async function syncProject(
  db: Db,
  deviceId: string,
  cfg: CaldavConfigRow,
  allowPrivate: boolean,
): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, errors: [] };
  if (cfg.sync_tasks && cfg.todo_url) {
    try {
      await syncKind(
        db,
        deviceId,
        cfg,
        "todo",
        cfg.todo_url,
        allowPrivate,
        result,
      );
    } catch (e) {
      result.errors.push(`tasks: ${(e as Error).message}`);
    }
  }
  if (cfg.sync_events && cfg.event_url) {
    try {
      await syncKind(
        db,
        deviceId,
        cfg,
        "event",
        cfg.event_url,
        allowPrivate,
        result,
      );
    } catch (e) {
      result.errors.push(`events: ${(e as Error).message}`);
    }
  }
  return result;
}

// ----- orchestration: queue, runner, scheduler, test ------------------------

/** Per-project sequential queue: a scheduled tick and a manual "Sync now" never
 *  overlap on the same project. */
const chains = new Map<string, Promise<unknown>>();
function runExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(projectId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(
    projectId,
    next
      .catch(() => {})
      .finally(() => {
        if (chains.get(projectId) === next) chains.delete(projectId);
      }),
  );
  return next;
}

/** Load fresh config, sync, record status. Serialised per project. */
export function runSync(
  db: Db,
  deviceId: string,
  projectId: string,
  allowPrivate: boolean,
): Promise<SyncResult> {
  return runExclusive(projectId, async () => {
    const cfg = getCaldavConfigRow(db, projectId);
    if (!cfg || !cfg.enabled)
      return { pulled: 0, pushed: 0, errors: ["not configured"] };
    let result: SyncResult;
    try {
      result = await syncProject(db, deviceId, cfg, allowPrivate);
    } catch (e) {
      result = { pulled: 0, pushed: 0, errors: [(e as Error).message] };
    }
    setSyncState(
      db,
      projectId,
      result.errors.length
        ? `error: ${result.errors[0]}`
        : `ok (down ${result.pulled}, up ${result.pushed})`,
    );
    return result;
  });
}

/** Live connectivity check (Settings "Test" button): PROPFIND the configured
 *  collection(s) and report how many items each holds. */
export async function testCaldav(
  db: Db,
  projectId: string,
  allowPrivate: boolean,
): Promise<{ ok: boolean; message: string }> {
  const cfg = getCaldavConfigRow(db, projectId);
  if (!cfg) return { ok: false, message: "not configured" };
  const targets: Array<[string, string]> = [];
  if (cfg.sync_tasks && cfg.todo_url) targets.push(["tasks", cfg.todo_url]);
  if (cfg.sync_events && cfg.event_url) targets.push(["events", cfg.event_url]);
  if (!targets.length)
    return {
      ok: false,
      message: "enable a sync type and set its collection URL",
    };
  try {
    const parts: string[] = [];
    for (const [label, url] of targets) {
      const m = await davListEtags(url, cfg, allowPrivate);
      parts.push(`${label}: ${m.size} item(s)`);
    }
    return { ok: true, message: `Reachable — ${parts.join(", ")}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export interface CaldavTenant {
  db: Db;
  deviceId: string;
  allowPrivate: boolean;
}

/**
 * Sweep every active tenant once a minute; for each enabled config whose
 * frequency has elapsed since its last sync, enqueue one sync pass. `tenants` is
 * re-evaluated each tick so newly-provisioned tenants are picked up. Mirrors
 * startReminderScheduler.
 */
export function startCaldavScheduler(tenants: () => CaldavTenant[]): void {
  setInterval(() => {
    const now = Date.now();
    for (const t of tenants()) {
      try {
        for (const cfg of listEnabledConfigs(t.db)) {
          const last = cfg.last_sync_at ? Date.parse(cfg.last_sync_at) : 0;
          if (now - last < cfg.frequency_seconds * 1000) continue;
          void runSync(t.db, t.deviceId, cfg.project_id, t.allowPrivate);
        }
      } catch (e) {
        console.error("[carbon] caldav sweep failed:", e);
      }
    }
  }, 60_000);
}
