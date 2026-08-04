/**
 * In-process operations behind the natural-language agent API.
 *
 * These are the Hono-free core of `/api/agent/*`: fuzzy resolution, batching, auto-create,
 * and the matched/unmatched envelopes — all the work a tiny LLM can't do. Both the REST
 * routes (`agent-api.ts`) and the in-app command tool-loop (`agent-command.ts`) call these,
 * so the two surfaces stay behaviourally identical.
 *
 * Each op takes `(userId, input)` and returns an `OpResult` (a `{status, data}` success or a
 * `{status, error}` failure). Routes map that straight onto an HTTP response; the loop reads
 * `data`. Every mutation flows through the same @carbon/core functions as the rest of the
 * server, so ops sync to clients and agent triggers fire unchanged.
 */
import {
  type Db,
  type Item,
  type Tag,
  type User,
  type Permission,
  type GeoReminder,
  getItem,
  getChildren,
  getProjects,
  queryItems,
  createItem,
  updateItem,
  setCompleted,
  listTags,
  createTag,
  updateTag,
  getItemTags,
  setItemTagLink,
  getItemsByTag,
  tagLeaf,
  tagId,
  projectAncestor,
  parseGeo,
  parseRecurrence,
  tasksNearLocation,
  visibleItemIds,
  hasWriteAccess,
  getUser,
  listUsers,
  listAssigneesForItem,
  shareItem,
  unshareItem,
  assignItem,
  unassignItem,
  getTimeContext,
  startSession,
  startTask,
  stopActive,
  pauseNow,
  pauseBefore,
  resume,
  resumeSuspended,
  addTimeNote,
  removeTimeNote,
  listSessions,
  getSessionBlock,
  sessionAnchor,
  type ItemPatch,
  type RemoveTimeNoteMode,
} from '@carbon/core';
import { bestMatch, rankBy } from './fuzzy';
import { makeOsmProvider, geocodeConfigFromEnv, type GeocodeProvider } from './geocode';

export interface AgentApiDeps {
  db: Db;
  deviceId: string;
  isBot: (userId: string) => boolean;
  canSee: (userId: string, itemId: string) => boolean;
  botAssigned: (userId: string, itemId: string) => boolean;
  /** May be null when geocoding is disabled — place lookups then require explicit coords. */
  geocode: GeocodeProvider | null;
}

export type ListRef = string | { id?: string };

/**
 * Build the `AgentApiDeps` for a tenant DB: the bot/visibility/write predicates plus a geocoder.
 * Both the per-tenant Hono app and the Telegram bot use this so the natural-language surface
 * behaves identically wherever it is driven from. `allowPrivate` gates the geocoder's outbound
 * SSRF guard; `multiTenant` only affects the geocoder's default-on/off.
 */
export function buildAgentApiDeps(
  db: Db,
  deviceId: string,
  opts: { multiTenant: boolean; allowPrivate: boolean },
): AgentApiDeps {
  const isBot = (userId: string): boolean => userId !== 'local' && !!getUser(db, userId)?.is_bot;
  const canSee = (userId: string, itemId: string): boolean =>
    userId === 'local' || isBot(userId) || visibleItemIds(db, userId).has(itemId);
  const botAssigned = (userId: string, itemId: string): boolean =>
    listAssigneesForItem(db, itemId).some((a) => a.user_id === userId);
  const geocode = makeOsmProvider(geocodeConfigFromEnv(process.env, opts.multiTenant), opts.allowPrivate);
  return { db, deviceId, isBot, canSee, botAssigned, geocode };
}

export type OpResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T, status = 200): OpResult<T> => ({ ok: true, status, data });
const fail = (error: string, status = 400): OpResult<never> => ({ ok: false, status, error });

// Bounds on bulk input, so a single request (or a runaway/injected model turn) can't
// create thousands of items or store megabyte titles. Generous for real use.
const MAX_BATCH = 100;
const MAX_TITLE_LEN = 2000;
const tooMany = (...arrs: Array<unknown[] | undefined>): boolean =>
  arrs.reduce((n, a) => n + (a?.length ?? 0), 0) > MAX_BATCH;

/** Accept a RecurrenceRule object (the model's natural form) or a JSON string; store as the
 *  JSON string the Item column expects. null/empty clears the rule. */
function normalizeRecurrence(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return null;
}

// A note body is returned capped by default: `items detail:true` can carry 50 of them, and a
// notebook of recipes would otherwise dwarf a small model's context window. Well above any
// "a few short lines" note, so the common case comes back whole and unflagged.
const NOTE_BODY_MAX = 2000;

/** Parse an item's metadata column, tolerating junk. Mirrors the client's `readNoteMeta`:
 *  the column is hand-editable and syncs from other builds, so anything that isn't a JSON
 *  object reads as `{}` rather than throwing. */
export function readMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Merge a metadata patch onto the stored column: shallow at the top level, one level deep for
 *  `recipe`. `metadata` is ONE whole-value LWW column shared by several features (note editor
 *  mode, recipe scaling, GPS-track summary), so a replacing write would silently erase whatever
 *  the agent didn't know about. Same contract as the client's `patchNoteMeta`. */
export function mergeMeta(
  current: string | null | undefined,
  patch: Record<string, unknown>,
): string | null {
  const base = readMeta(current);
  const merged: Record<string, unknown> = { ...base, ...patch };
  const baseRecipe = base.recipe;
  const patchRecipe = patch.recipe;
  if (
    baseRecipe && typeof baseRecipe === 'object' && !Array.isArray(baseRecipe) &&
    patchRecipe && typeof patchRecipe === 'object' && !Array.isArray(patchRecipe)
  ) {
    merged.recipe = { ...(baseRecipe as object), ...(patchRecipe as object) };
  }
  for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
  return Object.keys(merged).length ? JSON.stringify(merged) : null;
}

/** The note editor mode stored in metadata ('recipe' opens the recipe editor), or null. Only
 *  reported on notes — a task carries the same column but no editor mode. */
function noteModeOf(it: Item): string | null {
  if (it.type !== 'note') return null;
  const mode = readMeta(it.metadata).noteMode;
  return typeof mode === 'string' ? mode : null;
}

const noteModeField = (it: Item): { note_mode?: string } => {
  const mode = noteModeOf(it);
  return mode ? { note_mode: mode } : {};
};

/** `note` plus a `note_truncated:true` marker when the cap bit. */
function noteBodyFields(
  note: string | null,
  full: boolean,
): { note: string | null; note_truncated?: true } {
  if (full || note == null || note.length <= NOTE_BODY_MAX) return { note };
  return { note: note.slice(0, NOTE_BODY_MAX), note_truncated: true };
}

/** Normalise a model-supplied datetime to a UTC ("Z") ISO string. Reminder/due sweeps
 *  (push.ts) compare due_date/reminder_at as plain strings — a non-UTC offset the model
 *  emits despite the prompt's instructions would sort wrong and fire at the wrong time.
 *  Invalid input passes through unchanged so obviously-bad values still surface as-is. */
function normalizeDateTime<T extends string | null | undefined>(value: T): T | string {
  if (!value) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

// ----- input shapes (shared by routes and the command loop) -----------------

export interface ItemsInput {
  list?: ListRef;
  tag?: string;
  q?: string;
  status?: string;
  /** 'task' (default, back-compat) | 'note' | 'all'. Omitted inside a notes container
   *  (notebook), where the contents are notes and defaulting to 'task' returns nothing. */
  type?: string;
  /** ISO datetimes bounding due_date (inclusive). Either one restricts the result to items
   *  that HAVE a due date, sorted soonest-first — "what's due this week?" style questions. */
  due_before?: string;
  due_after?: string;
  limit?: number;
  detail?: boolean;
  /** With detail, return note bodies whole instead of capped at NOTE_BODY_MAX. */
  full?: boolean;
}
export interface SearchNotesInput {
  /** Text to find inside note bodies (case-insensitive substring). */
  q?: string;
  list?: ListRef;
  tag?: string;
  /** 'note' (default) | 'task' | 'all' — which item types to search the note field of. */
  type?: string;
  /** Include completed/dropped items in the search (default true — notes are usually inert). */
  include_done?: boolean;
  limit?: number;
}
export interface ResolveInput {
  /** 'list' | 'tag' | 'task' (tasks AND notes) | 'note' (notes only). */
  kind?: string;
  q?: string;
  list?: ListRef;
  limit?: number;
  /** Include completed tasks when resolving kind:'task'. */
  include_done?: boolean;
}
export interface TaskInput {
  title: string;
  note?: string;
  /** 'task' | 'note'. Omitted follows the destination container — a notes container
   *  (notebook) makes notes, everywhere else tasks — exactly like every in-app add surface.
   *  A note's status/dates/flags/priority are preserved but inert. */
  type?: string;
  /** 'recipe' opens the new note in the recipe editor (stored as metadata.noteMode);
   *  implies type:'note'. 'notes' is the plain editor and is the same as omitting it. */
  note_mode?: string;
  due_date?: string;
  defer_date?: string;
  /** ISO datetime for a push reminder. */
  reminder_at?: string;
  /** A RecurrenceRule object or its JSON string. */
  recurrence?: unknown;
  estimate_minutes?: number;
  flagged?: boolean;
  priority?: number;
  tags?: string[];
}
export interface AddTasksInput {
  list?: ListRef;
  create_list_if_missing?: boolean;
  tags?: string[];
  create_tags_if_missing?: boolean;
  titles?: string[];
  tasks?: TaskInput[];
}
export interface CompleteInput {
  done?: boolean;
  ids?: string[];
  queries?: string[];
  list?: ListRef;
  tag?: string;
  /** Search completed tasks too (implied when done:false reopens one). */
  include_done?: boolean;
}
export interface UpdateInput {
  /** Search completed tasks when matching queries. */
  include_done?: boolean;
  updates?: Array<{
    id?: string;
    query?: string;
    list?: ListRef;
    tag?: string;
    patch?: Record<string, unknown>;
  }>;
}
export interface TagItemsInput {
  /** Target by list (all its tasks), by tag, by fuzzy queries, or by ids. */
  list?: ListRef;
  tag?: string;
  queries?: string[];
  ids?: string[];
  /** Tag names to add and/or remove on the matched tasks. */
  add?: string[];
  remove?: string[];
  create_tags_if_missing?: boolean;
  /** Include completed tasks when matching queries / a whole list or tag. */
  include_done?: boolean;
}
/** Share or unshare task(s) with one or more users (by name). */
export interface ShareInput {
  id?: string;
  query?: string;
  queries?: string[];
  list?: ListRef;
  tag?: string;
  users?: string[];
  permission?: Permission;
  /** Remove the share instead of adding it. */
  remove?: boolean;
}
/** Assign or unassign task(s) to one or more users (by name). */
export interface AssignInput {
  id?: string;
  query?: string;
  queries?: string[];
  list?: ListRef;
  tag?: string;
  users?: string[];
  /** Unassign instead of assign. */
  remove?: boolean;
}
/** Start a v2 session/task timer (resolved by id or fuzzy query). */
export interface TimerStartInput {
  id?: string;
  query?: string;
  list?: ListRef;
  /** When true (or the match is a project), start a project session with no task. */
  project?: boolean;
}
export interface TimerPauseInput {
  /** Auto-resume after N minutes; omit/null = indefinite. Ignored when `before` is set. */
  minutes?: number | null;
  /** When true, carve out the last `minutes` as a retroactive pause (requires minutes > 0). */
  before?: boolean;
}
export interface TimerResumeInput {
  /** Resume a parked session by id; omit to resume from the active break pause. */
  session_id?: string;
}
export interface TimerNoteInput {
  title: string;
  body?: string | null;
  metadata?: string | Record<string, unknown> | null;
  session_id?: string | null;
}
export interface TimerSessionsInput {
  from?: string;
  to?: string;
}
export interface TimerRemoveNoteInput {
  log_id: string;
  /** `reference` = unlink from block only; `note` = also delete the note item. */
  mode?: RemoveTimeNoteMode;
}
export interface TagGeoInput {
  tag?: string;
  create_if_missing?: boolean;
  geo?: GeoReminder | null;
  near_name?: string;
  near?: { lat: number; lng: number };
}
export interface NearbyInput {
  tag?: string;
  zone?: string;
  lat?: number;
  lng?: number;
  near_name?: string;
}
export interface GeocodeSearchInput {
  q?: string;
  near?: { lat: number; lng: number };
  radius?: number;
}

export function createAgentOps(deps: AgentApiDeps) {
  const { db, deviceId, isBot, canSee, botAssigned, geocode } = deps;

  // null = unrestricted (bot / open-mode local); otherwise the user's visible-item set.
  const scopeItems = (userId: string): Set<string> | null =>
    userId === 'local' || isBot(userId) ? null : visibleItemIds(db, userId);

  // Per-item write gate, identical to POST /api/tasks/:id/complete.
  const canWrite = (userId: string, itemId: string): boolean =>
    userId === 'local' ||
    (isBot(userId) ? botAssigned(userId, itemId) : hasWriteAccess(db, itemId, userId));

  const ownerOf = (userId: string): string | null => (userId === 'local' ? null : userId);
  const tagNames = (itemId: string): string[] => getItemTags(db, itemId).map((t) => t.name);

  // note_mode rides along even in the minimal shape: it is one short string, and without it a
  // plain read of a notebook can't tell a recipe from any other note.
  const minimalItem = (it: Item) => ({
    id: it.id,
    title: it.title,
    tags: tagNames(it.id),
    done: it.status === 'done',
    ...noteModeField(it),
  });
  /** A detail shape, with note bodies capped unless `full`. The cap is what keeps a read of a
   *  notebook (50 recipes, several KB each) from filling a small model's whole context — but a
   *  capped body must never be written back, so it is flagged and `note_append` exists to make
   *  the read-modify-write round trip unnecessary. */
  const detailShape = (full: boolean) => (it: Item) => ({
    ...minimalItem(it),
    type: it.type,
    ...noteBodyFields(it.note, full),
    status: it.status,
    due_date: it.due_date,
    defer_date: it.defer_date,
    reminder_at: it.reminder_at,
    recurrence: parseRecurrence(it.recurrence),
    estimate_minutes: it.estimate_minutes,
    flagged: it.flagged,
    priority: it.priority,
    metadata: it.metadata,
  });

  // ----- resolution helpers (fuzzy) -----------------------------------------

  const findList = (userId: string, ref: ListRef | undefined): Item | null => {
    if (!ref) return null;
    const scope = scopeItems(userId);
    if (typeof ref === 'object') {
      if (!ref.id) return null;
      const p = getItem(db, ref.id);
      return p && p.type === 'project' && !p.deleted && (!scope || scope.has(p.id)) ? p : null;
    }
    const direct = getItem(db, ref);
    if (direct && direct.type === 'project' && !direct.deleted && (!scope || scope.has(direct.id))) {
      return direct;
    }
    const projects = getProjects(db).filter((p) => !scope || scope.has(p.id));
    return bestMatch(ref, projects, [(p) => p.title]).matched?.item ?? null;
  };

  const findTag = (ref: string | undefined): Tag | null => {
    if (!ref) return null;
    const tags = listTags(db);
    const byId = tags.find((t) => t.id === ref || t.id === tagId(ref));
    if (byId) return byId;
    return bestMatch(ref, tags, [(t) => t.name, (t) => tagLeaf(t.name)]).matched?.item ?? null;
  };

  // Assignable/shareable people: real (non-bot, non-deleted) users. Matched by id first, then
  // fuzzily on display name / username so "Rachel" resolves.
  const assignable = (): User[] => listUsers(db).filter((u) => !u.is_bot);
  const findUser = (ref: string | undefined): User | null => {
    if (!ref) return null;
    const users = assignable();
    const byId = users.find((u) => u.id === ref || u.username === ref);
    if (byId) return byId;
    return bestMatch(ref, users, [(u) => u.display_name ?? u.username, (u) => u.username]).matched?.item ?? null;
  };
  const userName = (u: User): string => u.display_name ?? u.username;

  const resolveOrCreateList = (
    userId: string,
    ref: ListRef | undefined,
    createIfMissing: boolean,
  ): { item: Item; created: boolean } | null => {
    const found = findList(userId, ref);
    if (found) return { item: found, created: false };
    if (!createIfMissing || typeof ref !== 'string' || !ref.trim()) return null;
    const item = createItem(db, deviceId, { type: 'project', title: ref, ownerId: ownerOf(userId) });
    return { item, created: true };
  };

  const resolveOrCreateTag = (
    name: string,
    createIfMissing: boolean,
  ): { id: string; name: string; created: boolean } | null => {
    const found = findTag(name);
    if (found) return { id: found.id, name: found.name, created: false };
    if (!createIfMissing || !name.trim()) return null;
    const t = createTag(db, deviceId, name);
    return { id: t.id, name: t.name, created: true };
  };

  // includeDone surfaces completed tasks too (for reopening/re-tagging/reporting). Default
  // off keeps the active-only pool the action ops have always used.
  // itemType narrows by Item.type:
  //   'task'     - strictly type==='task' (back-compat: every existing action op — complete,
  //                resolve(kind:'task'), share/assign/timer queries — keeps matching only
  //                tasks, never projects/folders, exactly like the pre-notes pool).
  //   'note'     - strictly type==='note'.
  //   'all'      - task OR note (never projects/folders) — used by update/items so a note can
  //                be found for conversion or inspection.
  //   'taggable' - task OR note OR project (never folders) — used only by tag_items, which
  //                pre-notes let a tag match a project too (getItemsByTag had no type filter
  //                at all); notes join that same "everything you'd reasonably tag" set.
  type ItemTypeFilter = 'task' | 'note' | 'all' | 'taggable';
  const taskPool = (
    userId: string,
    list: Item | null,
    tag: Tag | null,
    opts: { includeDone?: boolean; itemType?: ItemTypeFilter } = {},
  ): Item[] => {
    const scope = scopeItems(userId);
    const itemType = opts.itemType ?? 'task';
    const matchesType = (i: Item) =>
      itemType === 'all'
        ? i.type === 'task' || i.type === 'note'
        : itemType === 'taggable'
          ? i.type === 'task' || i.type === 'note' || i.type === 'project'
          : i.type === itemType;
    // A note's status is preserved-but-inert (never cleared while type==='note'), so a done/
    // dropped-looking note is still just as findable-by-name as an active one — includeDone
    // only gates *tasks*.
    const statusOk = (i: Item) => opts.includeDone || i.type === 'note' || i.status !== 'done';
    let items: Item[];
    if (list) items = getChildren(db, list.id).filter(matchesType);
    else if (tag) {
      // Tag-scoped matching has always covered every non-folder type (getItemsByTag never
      // filtered by type pre-notes, so a tag naming a project resolved it) — widen the default
      // 'task' pool here specifically, rather than narrowing it to strictly type==='task' like
      // the list/global branches below. 'note'/'all'/'taggable' still narrow as usual.
      items = getItemsByTag(db, tag.id).filter((i) =>
        itemType === 'task' ? i.type === 'task' || i.type === 'project' : matchesType(i),
      );
    } else if (itemType === 'note') {
      items = queryItems(db, { activeOnly: false }).filter(matchesType);
    } else if (itemType === 'all' || itemType === 'taggable') {
      items = queryItems(db, { tasksOnly: false, activeOnly: false }).filter(matchesType);
    } else {
      // Strict, unscoped 'task' pool — matches the pre-notes `tasksOnly: true` behaviour so a
      // bare fuzzy query (complete/resolve/share/timer with no list or tag) can never match a
      // project or folder.
      items = queryItems(db, { tasksOnly: true, activeOnly: false });
    }
    return items.filter((i) => !i.deleted && statusOk(i) && (!scope || scope.has(i.id)));
  };

  // ----- operations ----------------------------------------------------------

  function lists(userId: string, input: { detail?: boolean } = {}) {
    const scope = scopeItems(userId);
    const out = getProjects(db)
      .filter((p) => !scope || scope.has(p.id))
      .map((p) => {
        // A notes container holds notes, not actions: say so, so a caller reading it knows to
        // ask for notes — and count its notes rather than reporting a stocked notebook as 0
        // open tasks (which reads as empty).
        const base = p.notes_project
          ? { id: p.id, name: p.title, notes: true as const }
          : { id: p.id, name: p.title };
        if (!input.detail) return base;
        const children = getChildren(db, p.id).filter((t) => !t.deleted);
        return {
          ...base,
          open_count: p.notes_project
            ? children.filter((t) => t.type === 'note').length
            : children.filter((t) => t.type === 'task' && t.status === 'active').length,
        };
      });
    return ok({ lists: out });
  }

  function tags(_userId: string, input: { detail?: boolean } = {}) {
    const out = listTags(db).map((t) => {
      const g = parseGeo(t.geo);
      return input.detail
        ? { id: t.id, name: t.name, hasGeo: g !== null, color: t.color, status: t.status, geo: g }
        : { id: t.id, name: t.name, hasGeo: g !== null };
    });
    return ok({ tags: out });
  }

  // Validate+normalize a model-supplied type filter; anything unrecognised falls back to
  // `fallback` rather than silently matching everything.
  function normalizeItemType(
    t: string | undefined,
    fallback: 'task' | 'note' | 'all' = 'task',
  ): 'task' | 'note' | 'all' {
    return t === 'task' || t === 'note' || t === 'all' ? t : fallback;
  }

  function items(userId: string, input: ItemsInput) {
    const status = input.status ?? 'active';
    const limit = Math.min(input.limit || 50, 200);
    const list = findList(userId, input.list);
    const tag = findTag(input.tag);
    // Reading a notes container with the 'task' default returns nothing — its contents are all
    // notes. An unstated type follows the container instead, mirroring how new items there are
    // notes (repo.ts `defaultChildType`). An explicit type is still honoured.
    const itemType = normalizeItemType(input.type, list?.notes_project ? 'note' : 'task');
    // 'done'/'all' need the done-inclusive pool; 'active' keeps the default. Notes carry an
    // inert status, so "active" should still include them.
    let pool = taskPool(userId, list, tag, { includeDone: status !== 'active', itemType });
    if (status === 'active') pool = pool.filter((i) => i.type === 'note' || i.status === 'active');
    else if (status === 'done') pool = pool.filter((i) => i.status === 'done');
    // Date-window questions ("what's due this week?"). Bounds are normalized to the same
    // UTC form due_date is stored in, so plain string compares are correct. Only items WITH
    // a due date can match; soonest-first so the limit keeps the most urgent ones instead
    // of an arbitrary 50 on big workspaces.
    const dueBefore = input.due_before ? normalizeDateTime(input.due_before) : null;
    const dueAfter = input.due_after ? normalizeDateTime(input.due_after) : null;
    const dueFiltered = !!(dueBefore || dueAfter);
    if (dueFiltered) {
      pool = pool
        .filter(
          (i) =>
            i.due_date && (!dueBefore || i.due_date <= dueBefore) && (!dueAfter || i.due_date >= dueAfter),
        )
        .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));
    }
    const q = input.q?.trim();
    if (q) pool = rankBy(q, pool, [(i) => i.title]).map((s) => s.item);
    pool = pool.slice(0, limit);
    // A due-filtered ask is about dates, so surface due_date even without detail:true.
    const shape = input.detail
      ? detailShape(input.full === true)
      : dueFiltered
        ? (it: Item) => ({ ...minimalItem(it), due_date: it.due_date })
        : minimalItem;
    return ok({ items: pool.map((it) => shape(it)) });
  }

  const SNIPPET_RADIUS = 80; // chars of context either side of a match

  /** Plain-text context window around the first match of `q` inside `text`, with the hit
   *  itself marked («»); case-insensitive substring search (no ranking — note bodies aren't
   *  short titles, so fuzzy scoring isn't a good fit; an exact-ish phrase is what callers
   *  pass here). Returns null when there's no match. */
  function noteSnippet(text: string, q: string): string | null {
    const hay = text.toLowerCase();
    const idx = hay.indexOf(q.toLowerCase());
    if (idx < 0) return null;
    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(text.length, idx + q.length + SNIPPET_RADIUS);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    const before = text.slice(start, idx);
    const hit = text.slice(idx, idx + q.length);
    const after = text.slice(idx + q.length, end);
    return `${prefix}${before}«${hit}»${after}${suffix}`;
  }

  /** Search item.note bodies for a text match (not just titles — see `items`/rankBy for
   *  title search). Returns matched items with a context snippet around the hit, so the
   *  caller (conversational prompt) can summarize/quote rather than dumping the whole body. */
  function searchNotes(userId: string, input: SearchNotesInput) {
    const q = input.q?.trim();
    if (!q) return fail('q required', 400);
    const limit = Math.min(input.limit || 20, 100);
    const list = findList(userId, input.list);
    const tag = findTag(input.tag);
    // Notes default to inert status, so completed/dropped notes are still worth finding —
    // include_done defaults true here (unlike items/update) unless the caller says otherwise.
    const includeDone = input.include_done !== false;
    const itemType = input.type === 'task' || input.type === 'all' ? input.type : 'note';
    const pool = taskPool(userId, list, tag, { includeDone, itemType });
    const hits: Array<{
      id: string;
      title: string;
      type: string;
      note_mode?: string;
      snippet: string;
    }> = [];
    for (const it of pool) {
      if (!it.note) continue;
      const snippet = noteSnippet(it.note, q);
      if (snippet) {
        hits.push({ id: it.id, title: it.title, type: it.type, ...noteModeField(it), snippet });
      }
      if (hits.length >= limit) break;
    }
    return ok({ matches: hits });
  }

  function item(userId: string, id: string) {
    const it = getItem(db, id);
    if (!it || it.deleted || !canSee(userId, it.id)) return fail('not found', 404);
    const proj = projectAncestor(db, it.id);
    return ok({
      ...it,
      ...noteModeField(it),
      tags: getItemTags(db, it.id),
      list: proj ? { id: proj.id, name: proj.title } : null,
    });
  }

  function resolve(userId: string, input: ResolveInput) {
    const q = (input.q ?? '').trim();
    const limit = Math.min(input.limit || 5, 20);
    if (!q) return fail('q required', 400);

    let ranked;
    let nameOf: (x: { id: string }) => string;
    // Item kinds report `type` on each candidate, so a caller that must act on a task (only a
    // task can be completed) can tell a note apart from one.
    let itemKind = false;
    if (input.kind === 'list') {
      const scope = scopeItems(userId);
      const projects = getProjects(db).filter((p) => !scope || scope.has(p.id));
      ranked = rankBy(q, projects, [(p) => p.title], { limit });
      nameOf = (x) => (x as Item).title;
    } else if (input.kind === 'tag') {
      ranked = rankBy(q, listTags(db), [(t) => t.name, (t) => tagLeaf(t.name)], { limit });
      nameOf = (x) => (x as Tag).name;
    } else if (input.kind === 'task' || input.kind === 'note') {
      const list = findList(userId, input.list);
      // kind:'task' matches notes too. It is the existence check both prompts tell the model to
      // run before acting ("is there something called X?"), and a task-only pool answered "no"
      // for every note the user has — so the model reported a note that exists as missing.
      // kind:'note' narrows to notes when the caller specifically wants one.
      ranked = rankBy(
        q,
        taskPool(userId, list, null, {
          includeDone: input.include_done === true,
          itemType: input.kind === 'note' ? 'note' : 'all',
        }),
        [(i) => i.title],
        { limit },
      );
      nameOf = (x) => (x as Item).title;
      itemKind = true;
    } else {
      return fail('kind must be list, tag, task, or note', 400);
    }

    const candidates = ranked.map((s) => ({
      id: (s.item as { id: string }).id,
      name: nameOf(s.item as { id: string }),
      ...(itemKind ? { type: (s.item as Item).type, ...noteModeField(s.item as Item) } : {}),
      score: Math.round(s.score * 100) / 100,
      reason: s.reason,
    }));
    const top = candidates[0];
    const second = ranked[1];
    const confident =
      !!ranked[0] && ranked[0].score >= 0.55 && (!second || ranked[0].score - second.score >= 0.15);
    return ok({ candidates, best: top ? { id: top.id, confident } : null });
  }

  function addTasks(userId: string, input: AddTasksInput) {
    const taskInputs: TaskInput[] = input.tasks ?? (input.titles ?? []).map((title) => ({ title }));
    if (!taskInputs.length || taskInputs.some((t) => !t.title || typeof t.title !== 'string')) {
      return fail('provide titles[] or tasks[] with a title each', 400);
    }
    if (taskInputs.length > MAX_BATCH) return fail(`too many tasks (max ${MAX_BATCH})`, 400);
    if (taskInputs.some((t) => t.title.length > MAX_TITLE_LEN)) {
      return fail(`task title too long (max ${MAX_TITLE_LEN} chars)`, 400);
    }
    if (tooMany(input.tags)) return fail(`too many tags (max ${MAX_BATCH})`, 400);
    if (taskInputs.some((t) => tooMany(t.tags))) {
      return fail(`too many tags on a task (max ${MAX_BATCH})`, 400);
    }

    let listOut: { id: string; name: string; created: boolean } | null = null;
    let listItem: Item | null = null;
    if (input.list !== undefined) {
      const r = resolveOrCreateList(userId, input.list, input.create_list_if_missing !== false);
      if (!r) return fail('list not found', 404);
      listItem = r.item;
      listOut = { id: r.item.id, name: r.item.title, created: r.created };
    }

    const createTags = input.create_tags_if_missing !== false;
    const sharedTagOut: Array<{ id: string; name: string; created: boolean }> = [];
    for (const name of input.tags ?? []) {
      const r = resolveOrCreateTag(name, createTags);
      if (r) sharedTagOut.push(r);
    }

    // Resolve all unique per-task tag names once before the creation loop.
    const perTaskTagNames = new Set<string>();
    for (const t of taskInputs) for (const n of t.tags ?? []) perTaskTagNames.add(n);
    const perTaskTagById = new Map<string, string>();
    for (const name of perTaskTagNames) {
      const r = resolveOrCreateTag(name, createTags);
      if (r) perTaskTagById.set(name, r.id);
    }

    const created: Array<{ id: string; title: string; type: string; note_mode?: string }> = [];
    for (const t of taskInputs) {
      // note_mode is a note-editor setting, so asking for one is asking for a note.
      const noteMode = t.note_mode === 'recipe' ? 'recipe' : null;
      // An unstated type is left to createItem, which follows the destination container:
      // notes inside a notes container (notebook), tasks everywhere else — the same rule
      // quick-add and the outliner use. Forcing 'task' here put checkbox tasks in notebooks.
      const type = noteMode ? 'note' : t.type === 'note' ? 'note' : t.type === 'task' ? 'task' : undefined;
      const it = createItem(db, deviceId, {
        type,
        title: t.title,
        note: t.note ?? null,
        metadata: noteMode ? { noteMode } : null,
        parentId: listItem?.id ?? null,
        ownerId: ownerOf(userId),
        dueDate: normalizeDateTime(t.due_date) ?? null,
        deferDate: normalizeDateTime(t.defer_date) ?? null,
        flagged: !!t.flagged,
        priority: typeof t.priority === 'number' ? t.priority : 0,
      });
      // Scheduling fields createItem doesn't take: patch them on after creation.
      const sched: ItemPatch = {};
      if (t.reminder_at) sched.reminder_at = normalizeDateTime(t.reminder_at);
      if (t.recurrence != null) sched.recurrence = normalizeRecurrence(t.recurrence);
      if (typeof t.estimate_minutes === 'number') sched.estimate_minutes = t.estimate_minutes;
      if (Object.keys(sched).length) updateItem(db, deviceId, it.id, sched);
      const tagIds = new Set(sharedTagOut.map((x) => x.id));
      for (const name of t.tags ?? []) {
        const id = perTaskTagById.get(name);
        if (id) tagIds.add(id);
      }
      for (const id of tagIds) setItemTagLink(db, deviceId, it.id, id, false);
      created.push({ id: it.id, title: it.title, type: it.type, ...noteModeField(it) });
    }
    return ok({ list: listOut, tags: sharedTagOut, created }, 201);
  }

  function complete(userId: string, input: CompleteInput) {
    if (tooMany(input.ids, input.queries)) return fail(`too many targets (max ${MAX_BATCH})`, 400);
    const done = input.done !== false;
    const list = findList(userId, input.list);
    const tag = findTag(input.tag);
    const matched: Array<{ query: string; id: string; title: string }> = [];
    const unmatched: Array<{ query: string; reason: string }> = [];

    for (const id of input.ids ?? []) {
      const it = getItem(db, id);
      // Task-only op: a note has no "done" state (its status is inert), so an id addressing a
      // note must be rejected rather than passed to setCompleted. The name-resolution path
      // already excludes notes via taskPool; this closes the raw-id hole.
      if (!it || it.deleted || it.type === 'note' || !canSee(userId, id)) {
        unmatched.push({ query: id, reason: 'no_match' });
        continue;
      }
      if (!canWrite(userId, id)) {
        unmatched.push({ query: id, reason: 'forbidden' });
        continue;
      }
      setCompleted(db, deviceId, id, done);
      matched.push({ query: id, id, title: it.title });
    }

    // Reopening (done:false) must find already-completed tasks, so include them; also honour
    // an explicit include_done for "untick X" style queries that omit the flag.
    const includeDone = !done || input.include_done === true;
    const pool = taskPool(userId, list, tag, { includeDone });

    // No ids/queries but a list or tag: sweep the whole thing ("tick everything off my
    // shopping list", "untick my weekly items"). Only ever a named list/tag — a bare
    // complete{} stays an error rather than acting on the global pool. The tag-scoped pool
    // can contain projects, so filter to tasks; skip items already in the requested state.
    if (!input.ids?.length && !input.queries?.length) {
      if (!list && !tag) {
        return input.list || input.tag
          ? fail('list or tag not found', 404)
          : fail('specify queries, ids, list, or tag', 400);
      }
      for (const it of pool) {
        if (it.type !== 'task' || (it.status === 'done') === done) continue;
        if (!canWrite(userId, it.id)) {
          unmatched.push({ query: it.title, reason: 'forbidden' });
          continue;
        }
        setCompleted(db, deviceId, it.id, done);
        matched.push({ query: it.title, id: it.id, title: it.title });
      }
      return ok({ matched, unmatched, done });
    }

    for (const query of input.queries ?? []) {
      const m = bestMatch(query, pool, [(i) => i.title]);
      if (!m.matched) {
        unmatched.push({ query, reason: m.reason ?? 'no_match' });
        continue;
      }
      const hit = m.matched.item;
      if (!canWrite(userId, hit.id)) {
        unmatched.push({ query, reason: 'forbidden' });
        continue;
      }
      setCompleted(db, deviceId, hit.id, done);
      matched.push({ query, id: hit.id, title: hit.title });
    }
    return ok({ matched, unmatched, done });
  }

  const PATCH_FIELDS = [
    'title',
    'note',
    'type',
    'due_date',
    'defer_date',
    'reminder_at',
    'recurrence',
    'estimate_minutes',
    'flagged',
    'priority',
    'status',
    'metadata',
  ] as const;

  function update(userId: string, input: UpdateInput) {
    if (tooMany(input.updates)) return fail(`too many updates (max ${MAX_BATCH})`, 400);
    const includeDone = input.include_done === true;
    const matched: Array<{ query: string; id: string; title: string }> = [];
    const unmatched: Array<{ query: string; reason: string }> = [];
    for (const u of input.updates ?? []) {
      const label = u.id ?? u.query ?? '';
      let target: Item | null = null;
      if (u.id) {
        const it = getItem(db, u.id);
        target = it && !it.deleted && canSee(userId, it.id) ? it : null;
      } else if (u.query) {
        // itemType:'all' so a query can resolve either a task or a note — needed for
        // task<->note conversion ("turn my note X into a task") where the target isn't a
        // plain task while it's still a note.
        const pool = taskPool(userId, findList(userId, u.list), findTag(u.tag), {
          includeDone,
          itemType: 'all',
        });
        target = bestMatch(u.query, pool, [(i) => i.title]).matched?.item ?? null;
      }
      if (!target) {
        unmatched.push({ query: label, reason: 'no_match' });
        continue;
      }
      if (!canWrite(userId, target.id)) {
        unmatched.push({ query: label, reason: 'forbidden' });
        continue;
      }
      const patch: ItemPatch = {};
      for (const k of PATCH_FIELDS) {
        if (u.patch && k in u.patch) (patch as Record<string, unknown>)[k] = u.patch[k];
      }
      // Only 'task'/'note' are valid conversion targets via the agent; anything else in the
      // patch is dropped rather than corrupting the row with an unsupported type value.
      if ('type' in patch && patch.type !== 'task' && patch.type !== 'note') {
        delete (patch as Record<string, unknown>).type;
      }
      // recurrence is stored as a JSON string; accept the model's object form.
      if ('recurrence' in patch) patch.recurrence = normalizeRecurrence(patch.recurrence);
      // Appending is the common note edit ("add to my bread recipe: rest for 45 min"), and
      // doing it server-side is what makes it safe: the alternative is the caller reading the
      // body and writing it back, which loses everything it didn't read (or didn't fit in its
      // context). Applies on top of a same-call `note` replacement if both are given.
      const appendRaw = u.patch?.note_append;
      if (typeof appendRaw === 'string' && appendRaw.trim()) {
        const base = typeof patch.note === 'string' ? patch.note : (target.note ?? '');
        const trimmed = base.replace(/\s+$/, '');
        patch.note = trimmed ? `${trimmed}\n${appendRaw.trim()}` : appendRaw.trim();
      }
      // note_mode is the note editor's mode, stored inside metadata — offered as a plain patch
      // key so a caller never has to hand-build that column to turn a note into a recipe.
      const metaPatch: Record<string, unknown> = {};
      const modeRaw = u.patch?.note_mode;
      if (modeRaw === 'recipe' || modeRaw === 'notes') {
        metaPatch.noteMode = modeRaw === 'recipe' ? 'recipe' : null;
      }
      // metadata is TEXT JSON, and one whole-value LWW column shared by several features —
      // merge onto what's stored instead of replacing it (see mergeMeta), so setting a note's
      // mode can't wipe its recipe scaling or a GPS-track summary. An explicit null/"" still
      // clears the column outright; keys given alongside it then land on an empty base.
      const rawMeta = 'metadata' in patch ? (patch.metadata as unknown) : undefined;
      const clearMeta = rawMeta === null || rawMeta === '';
      if (rawMeta != null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
        Object.assign(metaPatch, rawMeta as Record<string, unknown>);
      }
      if (rawMeta !== undefined) delete (patch as Record<string, unknown>).metadata;
      if (clearMeta || Object.keys(metaPatch).length) {
        patch.metadata = Object.keys(metaPatch).length
          ? mergeMeta(clearMeta ? null : target.metadata, metaPatch)
          : null;
      }
      for (const k of ['due_date', 'defer_date', 'reminder_at'] as const) {
        if (k in patch) (patch as Record<string, unknown>)[k] = normalizeDateTime(patch[k]);
      }
      let resultTitle = target.title;
      if (patch.status === 'done' && target.status !== 'done') {
        // A status->'done' patch must go through setCompleted, not a raw field write,
        // so recurring tasks still spawn their next occurrence (mirrors complete()).
        delete (patch as Record<string, unknown>).status;
        const updated = updateItem(db, deviceId, target.id, patch);
        resultTitle = updated?.title ?? resultTitle;
        const { item: completed } = setCompleted(db, deviceId, target.id, true);
        if (completed) resultTitle = completed.title;
      } else {
        // A raw status patch must keep completed_at in step (mirrors setCompleted) —
        // completed-item age logic (e.g. the purge feature) relies on the stamp.
        if (typeof patch.status === 'string' && patch.status !== target.status) {
          patch.completed_at = patch.status === 'done' ? new Date().toISOString() : null;
        }
        const updated = updateItem(db, deviceId, target.id, patch);
        if (updated) resultTitle = updated.title;
      }
      matched.push({ query: label, id: target.id, title: resultTitle });
    }
    return ok({ matched, unmatched });
  }

  /** Add/remove tags on tasks in bulk. Targets a whole list (all its tasks), a tag, fuzzy
   *  queries, or ids — the server enumerates, so the model never lists items itself. */
  function tagItems(userId: string, input: TagItemsInput) {
    if (tooMany(input.ids, input.queries) || tooMany(input.add, input.remove)) {
      return fail(`too many targets/tags (max ${MAX_BATCH})`, 400);
    }
    const createTags = input.create_tags_if_missing !== false;
    const add = (input.add ?? []).map((n) => resolveOrCreateTag(n, createTags)).filter((r): r is NonNullable<typeof r> => !!r);
    const removeTags = (input.remove ?? []).map((n) => findTag(n)).filter((t): t is Tag => !!t);
    if (!add.length && !removeTags.length) return fail('specify add[] and/or remove[] tag names', 400);

    const includeDone = input.include_done === true;
    const unmatched: Array<{ query: string; reason: string }> = [];
    let targets: Item[];
    if (input.ids?.length || input.queries?.length) {
      targets = [];
      for (const id of input.ids ?? []) {
        const it = getItem(db, id);
        // Tagging is meaningful on tasks, notes, and projects — only folders (a visual
        // grouping layer, not a taggable "thing") are rejected. Matches the fuzzy/list/tag
        // pools below ('taggable'), so an id and a query/list can target the same set.
        if (it && !it.deleted && it.type !== 'folder' && canSee(userId, id)) targets.push(it);
        else unmatched.push({ query: id, reason: 'no_match' });
      }
      const pool = taskPool(userId, findList(userId, input.list), findTag(input.tag), {
        includeDone,
        itemType: 'taggable',
      });
      for (const q of input.queries ?? []) {
        const hit = bestMatch(q, pool, [(i) => i.title]).matched?.item;
        if (hit) targets.push(hit);
        else unmatched.push({ query: q, reason: 'no_match' });
      }
    } else {
      const list = findList(userId, input.list);
      const tag = findTag(input.tag);
      if (!list && !tag) return fail('specify list, tag, ids, or queries', 404);
      targets = taskPool(userId, list, tag, { includeDone, itemType: 'taggable' });
    }

    const updated: Array<{ id: string; title: string }> = [];
    for (const t of targets) {
      if (!canWrite(userId, t.id)) {
        unmatched.push({ query: t.title, reason: 'forbidden' });
        continue;
      }
      for (const a of add) setItemTagLink(db, deviceId, t.id, a.id, false);
      for (const r of removeTags) setItemTagLink(db, deviceId, t.id, r.id, true);
      updated.push({ id: t.id, title: t.title });
    }
    return ok({
      updated,
      tags_added: add.map((a) => a.name),
      tags_removed: removeTags.map((r) => r.name),
      unmatched,
    });
  }

  async function tagGeo(_userId: string, input: TagGeoInput) {
    if (!input.tag) return fail('tag required', 400);
    const resolved = resolveOrCreateTag(input.tag, input.create_if_missing === true);
    if (!resolved) return fail('tag not found', 404);

    if (input.geo === null) {
      updateTag(db, deviceId, resolved.id, { geo: null });
      return ok({ tag: { id: resolved.id, name: resolved.name }, geo: null, source: 'explicit' });
    }

    let reminder: GeoReminder;
    let source: 'explicit' | 'geocoded' = 'explicit';
    if (input.geo && typeof input.geo.lat === 'number' && typeof input.geo.lng === 'number') {
      reminder = {
        lat: input.geo.lat,
        lng: input.geo.lng,
        radius: typeof input.geo.radius === 'number' && input.geo.radius > 0 ? input.geo.radius : 150,
        label: input.geo.label,
      };
    } else if (input.near_name) {
      if (!geocode) return fail('geocoding_disabled', 400);
      // near_name needs an anchor point with BOTH coordinates; a partial/absent anchor
      // (e.g. no recent location for the user) is reported distinctly so the caller can
      // say "no recent location" rather than misreporting a geocode failure.
      if (!input.near || typeof input.near.lat !== 'number' || typeof input.near.lng !== 'number') {
        return fail('no_anchor_location', 400);
      }
      const hit = await geocode.nearestBrand(input.near_name, input.near);
      if (!hit) return fail('could_not_geocode', 400);
      reminder = { lat: hit.point.lat, lng: hit.point.lng, radius: 150, label: hit.label };
      source = 'geocoded';
    } else {
      return fail('provide geo{lat,lng} or near_name+near{lat,lng}', 400);
    }

    updateTag(db, deviceId, resolved.id, { geo: JSON.stringify(reminder) });
    return ok({ tag: { id: resolved.id, name: resolved.name }, geo: reminder, source });
  }

  async function nearby(userId: string, input: NearbyInput) {
    const scope = scopeItems(userId);
    if (input.tag) {
      const tag = findTag(input.tag);
      if (!tag) return fail('tag not found', 404);
      const out = getItemsByTag(db, tag.id).filter(
        (i) =>
          i.type === 'task' && i.status === 'active' && !i.deleted && (!scope || scope.has(i.id)),
      );
      return ok({ items: out.map(minimalItem) });
    }

    const hasPoint = typeof input.lat === 'number' && typeof input.lng === 'number';
    let point: { lat: number; lng: number } | null = hasPoint
      ? { lat: input.lat!, lng: input.lng! }
      : null;
    let location: { lat: number; lng: number; label: string } | undefined;
    if (input.near_name && hasPoint && geocode) {
      const hit = await geocode.nearestBrand(input.near_name, { lat: input.lat!, lng: input.lng! });
      if (hit) {
        point = hit.point;
        location = { lat: hit.point.lat, lng: hit.point.lng, label: hit.label };
      }
    }
    if (!input.zone && !point) return fail('provide tag, zone, or lat+lng', 400);
    let out = tasksNearLocation(db, { zone: input.zone, point });
    if (scope) out = out.filter((i) => scope.has(i.id));
    return ok({ items: out.map(minimalItem), location });
  }

  async function geocodeSearch(_userId: string, input: GeocodeSearchInput) {
    if (!geocode) return fail('geocoding_disabled', 400);
    const q = input.q?.trim();
    if (!q || !input.near || typeof input.near.lat !== 'number' || typeof input.near.lng !== 'number') {
      return fail('q and near{lat,lng} required', 400);
    }
    const radius = typeof input.radius === 'number' && input.radius > 0 ? input.radius : 150;
    const hits = await geocode.search(q, input.near, { limit: 5 });
    return ok({
      candidates: hits.map((h) => ({
        lat: h.point.lat,
        lng: h.point.lng,
        radius,
        label: h.label,
      })),
    });
  }

  // ----- users, sharing, assigning, time tracking ----------------------------

  /** People a task can be shared with or assigned to. */
  function users(_userId: string) {
    return ok({ users: assignable().map((u) => ({ id: u.id, name: userName(u), username: u.username })) });
  }

  // Resolve the task target(s) for share/assign from id, queries, or a whole list/tag. Dedupes
  // and reports misses, mirroring the complete/tag envelope. Completed tasks are included so a
  // just-finished task can still be shared/assigned.
  type TargetInput = { id?: string; query?: string; queries?: string[]; list?: ListRef; tag?: string };
  const collectTargets = (
    userId: string,
    input: TargetInput,
  ): { targets: Item[]; unmatched: Array<{ query: string; reason: string }> } => {
    const seen = new Set<string>();
    const targets: Item[] = [];
    const unmatched: Array<{ query: string; reason: string }> = [];
    const push = (it: Item) => {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        targets.push(it);
      }
    };
    if (input.id) {
      const it = getItem(db, input.id);
      // Task-only: the query/list/tag paths below already exclude notes via taskPool; guard
      // the raw-id path so a note id can't be shared/assigned as if it were a task.
      if (it && !it.deleted && it.type !== 'note' && canSee(userId, it.id)) push(it);
      else unmatched.push({ query: input.id, reason: 'no_match' });
    }
    const queries = input.queries ?? (input.query ? [input.query] : []);
    if (queries.length) {
      const pool = taskPool(userId, findList(userId, input.list), findTag(input.tag), { includeDone: true });
      for (const q of queries) {
        const hit = bestMatch(q, pool, [(i) => i.title]).matched?.item;
        if (hit) push(hit);
        else unmatched.push({ query: q, reason: 'no_match' });
      }
    }
    // No explicit task → act on a whole list/tag (e.g. "share my Groceries list with Rachel").
    if (!input.id && !queries.length && (input.list !== undefined || input.tag)) {
      const list = findList(userId, input.list);
      const tag = findTag(input.tag);
      if (list || tag) for (const it of taskPool(userId, list, tag, { includeDone: true })) push(it);
    }
    return { targets, unmatched };
  };

  // Resolve the user names once; report any that don't match a real person.
  const resolveUsers = (names: string[]): { users: User[]; unknown: string[] } => {
    const out: User[] = [];
    const seen = new Set<string>();
    const unknown: string[] = [];
    for (const n of names) {
      const u = findUser(n);
      if (u && !seen.has(u.id)) {
        seen.add(u.id);
        out.push(u);
      } else if (!u) unknown.push(n);
    }
    return { users: out, unknown };
  };

  function share(userId: string, input: ShareInput) {
    const names = input.users ?? [];
    if (!names.length) return fail('specify users[] (names)', 400);
    if (tooMany(input.queries, names)) return fail(`too many targets/users (max ${MAX_BATCH})`, 400);
    const { users: people, unknown } = resolveUsers(names);
    if (!people.length) return fail(`no such user${unknown.length ? `: ${unknown.join(', ')}` : ''}`, 404);
    const permission: Permission = input.permission === 'read' ? 'read' : 'write';
    const remove = input.remove === true;

    const { targets, unmatched } = collectTargets(userId, input);
    if (!targets.length && !unmatched.length) return fail('specify a task by id, query, list, or tag', 404);
    const updated: Array<{ id: string; title: string }> = [];
    for (const t of targets) {
      if (!canWrite(userId, t.id)) {
        unmatched.push({ query: t.title, reason: 'forbidden' });
        continue;
      }
      for (const u of people) {
        if (remove) unshareItem(db, deviceId, t.id, u.id);
        else shareItem(db, deviceId, t.id, u.id, permission);
      }
      updated.push({ id: t.id, title: t.title });
    }
    return ok({
      updated,
      users: people.map((u) => ({ id: u.id, name: userName(u) })),
      unknown_users: unknown,
      permission,
      removed: remove,
      unmatched,
    });
  }

  function assign(userId: string, input: AssignInput) {
    const names = input.users ?? [];
    if (!names.length) return fail('specify users[] (names)', 400);
    if (tooMany(input.queries, names)) return fail(`too many targets/users (max ${MAX_BATCH})`, 400);
    const { users: people, unknown } = resolveUsers(names);
    if (!people.length) return fail(`no such user${unknown.length ? `: ${unknown.join(', ')}` : ''}`, 404);
    const remove = input.remove === true;

    const { targets, unmatched } = collectTargets(userId, input);
    if (!targets.length && !unmatched.length) return fail('specify a task by id, query, list, or tag', 404);
    const updated: Array<{ id: string; title: string }> = [];
    for (const t of targets) {
      if (!canWrite(userId, t.id)) {
        unmatched.push({ query: t.title, reason: 'forbidden' });
        continue;
      }
      for (const u of people) {
        if (remove) unassignItem(db, deviceId, t.id, u.id);
        else {
          assignItem(db, deviceId, t.id, u.id);
          // Assigning grants edit access if the user doesn't already have it, matching
          // every other assign call site (TaskDetail.tsx, RowQuickMenu.tsx, quickadd.ts).
          if (!hasWriteAccess(db, t.id, u.id)) shareItem(db, deviceId, t.id, u.id, 'write');
        }
      }
      updated.push({ id: t.id, title: t.title });
    }
    return ok({
      updated,
      users: people.map((u) => ({ id: u.id, name: userName(u) })),
      unknown_users: unknown,
      removed: remove,
      unmatched,
    });
  }

  // Resolve a task or project for the v2 timer start op.
  const findTimerTarget = (userId: string, input: TimerStartInput): Item | null => {
    if (input.id) {
      const it = getItem(db, input.id);
      return it && !it.deleted && it.type !== 'folder' && canSee(userId, it.id) ? it : null;
    }
    if (input.query) {
      // Prefer tasks; projects are also valid when `project` is set or nothing task-matched.
      const list = findList(userId, input.list);
      const tasks = taskPool(userId, list, null, { includeDone: true });
      const taskHit = bestMatch(input.query, tasks, [(i) => i.title]).matched?.item;
      if (taskHit && !input.project) return taskHit;
      const projects = getProjects(db).filter(
        (p) => !p.deleted && canSee(userId, p.id),
      );
      const projHit = bestMatch(input.query, projects, [(i) => i.title]).matched?.item;
      if (input.project) return projHit ?? null;
      return taskHit ?? projHit ?? null;
    }
    return null;
  };

  const serializeContext = (userId: string) => {
    const uid = ownerOf(userId);
    const ctx = getTimeContext(db, uid);
    const itemOf = (id: string | undefined) => {
      if (!id) return null;
      const it = getItem(db, id);
      return it ? { id: it.id, title: it.title, type: it.type } : { id, title: '', type: 'task' as const };
    };
    return {
      session: ctx.session
        ? {
            id: ctx.session.id,
            project: itemOf(ctx.session.item_id),
            start_time: ctx.session.start_time,
          }
        : null,
      task: ctx.task ? itemOf(ctx.task.item_id) : null,
      paused: ctx.paused,
      pause_ends_at: ctx.pauseEndsAt,
      suspended: ctx.suspended.map((s) => ({
        id: s.id,
        project: itemOf(s.item_id),
        start_time: s.start_time,
      })),
    };
  };

  function timerContext_(userId: string) {
    return ok(serializeContext(userId));
  }

  function startTimer_(userId: string, input: TimerStartInput) {
    const target = findTimerTarget(userId, input);
    if (!target) return fail('task not found', 404);
    if (!canWrite(userId, target.id)) return fail('forbidden', 403);
    const uid = ownerOf(userId);
    const before = getTimeContext(db, uid);
    const prevTask = before.task ? getItem(db, before.task.item_id) : null;
    const prevSession = before.session ? getItem(db, before.session.item_id) : null;
    if (target.type === 'project' || input.project) {
      const projectId = target.type === 'project' ? target.id : sessionAnchor(db, target.id);
      startSession(db, deviceId, projectId, uid);
    } else {
      startTask(db, deviceId, target.id, uid);
    }
    const after = serializeContext(userId);
    const stopped =
      prevTask && prevTask.id !== target.id
        ? { id: prevTask.id, title: prevTask.title }
        : prevSession && before.session && before.session.item_id !== (after.session?.project?.id ?? '')
          ? { id: prevSession.id, title: prevSession.title }
          : null;
    return ok({
      started: { id: target.id, title: target.title, type: target.type },
      stopped,
      context: after,
    });
  }

  function stopTimer_(userId: string) {
    const uid = ownerOf(userId);
    const before = getTimeContext(db, uid);
    if (!before.session) return ok({ stopped: null, context: serializeContext(userId) });
    const proj = getItem(db, before.session.item_id);
    const task = before.task ? getItem(db, before.task.item_id) : null;
    stopActive(db, deviceId, uid);
    return ok({
      stopped: {
        session_id: before.session.id,
        project: proj ? { id: proj.id, title: proj.title } : null,
        task: task ? { id: task.id, title: task.title } : null,
      },
      context: serializeContext(userId),
    });
  }

  function pauseTimer_(userId: string, input: TimerPauseInput) {
    const uid = ownerOf(userId);
    const ctx = getTimeContext(db, uid);
    if (!ctx.session) return fail('no active session', 409);
    if (ctx.paused) return fail('already paused', 409);
    if (input.before) {
      const m = Number(input.minutes);
      if (!(m > 0)) return fail('minutes required for before-pause', 400);
      pauseBefore(db, deviceId, uid, m);
    } else {
      const minutes =
        input.minutes === undefined || input.minutes === null ? null : Number(input.minutes);
      if (minutes != null && !(minutes > 0)) return fail('minutes must be positive', 400);
      pauseNow(db, deviceId, uid, minutes);
    }
    return ok({ context: serializeContext(userId) });
  }

  function resumeTimer_(userId: string, input: TimerResumeInput = {}) {
    const uid = ownerOf(userId);
    if (input.session_id) {
      const open = getTimeContext(db, uid).suspended.find((s) => s.id === input.session_id);
      if (!open) return fail('suspended session not found', 404);
      resumeSuspended(db, deviceId, uid, input.session_id);
    } else {
      const ctx = getTimeContext(db, uid);
      if (!ctx.session || !ctx.paused) return fail('not paused', 409);
      resume(db, deviceId, uid);
    }
    return ok({ context: serializeContext(userId) });
  }

  function addTimerNote_(userId: string, input: TimerNoteInput) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) return fail('title required', 400);
    const uid = ownerOf(userId);
    const result = addTimeNote(db, deviceId, uid, {
      title,
      body: input.body ?? null,
      metadata: input.metadata ?? null,
      sessionId: input.session_id ?? null,
    });
    if (!result) return fail('no active session', 409);
    return ok({
      note: {
        id: result.note.id,
        title: result.note.title,
        parent_id: result.note.parent_id,
        metadata: result.note.metadata,
      },
      log: { id: result.log.id, session_id: result.log.session_id, start_time: result.log.start_time },
      context: serializeContext(userId),
    });
  }

  function removeTimerNote_(userId: string, input: TimerRemoveNoteInput) {
    if (!input.log_id) return fail('log_id required', 400);
    const mode: RemoveTimeNoteMode = input.mode === 'note' ? 'note' : 'reference';
    // Ownership: the time_log must belong to this user (or open-mode null).
    const row = db.get<{ user_id: string | null; kind: string; deleted: number }>(
      'SELECT user_id, kind, deleted FROM time_logs WHERE id = ?',
      [input.log_id],
    );
    if (!row || row.deleted || row.kind !== 'note') return fail('note marker not found', 404);
    const uid = ownerOf(userId);
    if (uid != null && row.user_id != null && row.user_id !== uid) return fail('forbidden', 403);
    if (!removeTimeNote(db, deviceId, input.log_id, mode)) return fail('note marker not found', 404);
    return ok({ removed: true, mode });
  }

  function listTimerSessions_(userId: string, input: TimerSessionsInput = {}) {
    const uid = ownerOf(userId);
    const to = input.to ?? new Date().toISOString();
    const from =
      input.from ??
      new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const sessions = listSessions(db, from, to, uid);
    const blocks = sessions.map((s) => {
      const b = getSessionBlock(db, s);
      return {
        session: {
          id: s.id,
          project: b.project
            ? { id: b.project.id, title: b.project.title }
            : { id: s.item_id, title: 'Project' },
          start_time: s.start_time,
          end_time: s.end_time,
        },
        tracked_ms: b.trackedMs,
        wall_ms: b.wallMs,
        untracked_ms: b.untrackedMs,
        segments: b.segments.map((seg) => ({
          id: seg.log.id,
          item: seg.item
            ? { id: seg.item.id, title: seg.item.title, deleted: seg.item.deleted }
            : { id: seg.log.item_id, title: 'Task', deleted: true },
          start_time: seg.log.start_time,
          end_time: seg.log.end_time,
          ms: seg.ms,
        })),
        pauses: b.pauses.map((p) => ({
          id: p.id,
          start_time: p.start_time,
          end_time: p.end_time,
          suspend: p.note === 'suspend',
        })),
        completions: b.completions.map((c) => ({
          id: c.log.id,
          item: c.item
            ? { id: c.item.id, title: c.item.title }
            : { id: c.log.item_id, title: 'Task' },
          at: c.log.start_time,
        })),
        notes: b.notes.map((n) => ({
          id: n.log.id,
          item: n.item
            ? {
                id: n.item.id,
                title: n.item.deleted ? '(deleted note)' : n.item.title,
                deleted: n.item.deleted,
                metadata: n.item.metadata,
              }
            : { id: n.log.item_id, title: '(deleted note)', deleted: true, metadata: null },
          at: n.log.start_time,
        })),
      };
    });
    return ok({ from, to, sessions: blocks });
  }

  return {
    lists,
    tags,
    items,
    item,
    searchNotes,
    resolve,
    addTasks,
    complete,
    update,
    tagItems,
    tagGeo,
    nearby,
    geocodeSearch,
    users,
    share,
    assign,
    timerContext: timerContext_,
    startTimer: startTimer_,
    stopTimer: stopTimer_,
    pauseTimer: pauseTimer_,
    resumeTimer: resumeTimer_,
    addTimerNote: addTimerNote_,
    removeTimerNote: removeTimerNote_,
    listTimerSessions: listTimerSessions_,
  };
}
