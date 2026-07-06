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
  startTimer,
  stopTimer,
  getRunningTimer,
  type ItemPatch,
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
  /** 'task' (default, back-compat) | 'note' | 'all'. */
  type?: string;
  limit?: number;
  detail?: boolean;
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
  /** 'task' (default) | 'note'. A note's status/dates/flags/priority are preserved but inert. */
  type?: string;
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
/** Start a timer on a single task (resolved by id or fuzzy query). */
export interface TimerInput {
  id?: string;
  query?: string;
  list?: ListRef;
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

  const minimalItem = (it: Item) => ({
    id: it.id,
    title: it.title,
    tags: tagNames(it.id),
    done: it.status === 'done',
  });
  const detailItem = (it: Item) => ({
    ...minimalItem(it),
    type: it.type,
    note: it.note,
    status: it.status,
    due_date: it.due_date,
    defer_date: it.defer_date,
    reminder_at: it.reminder_at,
    recurrence: parseRecurrence(it.recurrence),
    estimate_minutes: it.estimate_minutes,
    flagged: it.flagged,
    priority: it.priority,
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
      .map((p) =>
        input.detail
          ? {
              id: p.id,
              name: p.title,
              open_count: getChildren(db, p.id).filter(
                (t) => t.type === 'task' && t.status === 'active' && !t.deleted,
              ).length,
            }
          : { id: p.id, name: p.title },
      );
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

  // Validate+normalize a model-supplied type filter; anything unrecognised falls back to the
  // default ('task') rather than silently matching everything.
  function normalizeItemType(t: string | undefined): 'task' | 'note' | 'all' {
    return t === 'note' || t === 'all' ? t : 'task';
  }

  function items(userId: string, input: ItemsInput) {
    const status = input.status ?? 'active';
    const limit = Math.min(input.limit || 50, 200);
    const list = findList(userId, input.list);
    const tag = findTag(input.tag);
    const itemType = normalizeItemType(input.type);
    // 'done'/'all' need the done-inclusive pool; 'active' keeps the default. Notes carry an
    // inert status, so "active" should still include them.
    let pool = taskPool(userId, list, tag, { includeDone: status !== 'active', itemType });
    if (status === 'active') pool = pool.filter((i) => i.type === 'note' || i.status === 'active');
    else if (status === 'done') pool = pool.filter((i) => i.status === 'done');
    const q = input.q?.trim();
    if (q) pool = rankBy(q, pool, [(i) => i.title]).map((s) => s.item);
    pool = pool.slice(0, limit);
    return ok({ items: pool.map(input.detail ? detailItem : minimalItem) });
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
    const hits: Array<{ id: string; title: string; type: string; snippet: string }> = [];
    for (const it of pool) {
      if (!it.note) continue;
      const snippet = noteSnippet(it.note, q);
      if (snippet) hits.push({ id: it.id, title: it.title, type: it.type, snippet });
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
    if (input.kind === 'list') {
      const scope = scopeItems(userId);
      const projects = getProjects(db).filter((p) => !scope || scope.has(p.id));
      ranked = rankBy(q, projects, [(p) => p.title], { limit });
      nameOf = (x) => (x as Item).title;
    } else if (input.kind === 'tag') {
      ranked = rankBy(q, listTags(db), [(t) => t.name, (t) => tagLeaf(t.name)], { limit });
      nameOf = (x) => (x as Tag).name;
    } else if (input.kind === 'task') {
      const list = findList(userId, input.list);
      ranked = rankBy(
        q,
        taskPool(userId, list, null, { includeDone: input.include_done === true }),
        [(i) => i.title],
        { limit },
      );
      nameOf = (x) => (x as Item).title;
    } else {
      return fail('kind must be list, tag, or task', 400);
    }

    const candidates = ranked.map((s) => ({
      id: (s.item as { id: string }).id,
      name: nameOf(s.item as { id: string }),
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

    const created: Array<{ id: string; title: string; type: string }> = [];
    for (const t of taskInputs) {
      const it = createItem(db, deviceId, {
        type: t.type === 'note' ? 'note' : 'task',
        title: t.title,
        note: t.note ?? null,
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
      created.push({ id: it.id, title: it.title, type: it.type });
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

  // Resolve a single task from id or a fuzzy query (completed included), for the timer ops.
  const findOneTask = (userId: string, input: TimerInput): Item | null => {
    if (input.id) {
      const it = getItem(db, input.id);
      // Task-only: time tracking has no meaning on a note. The query path uses taskPool
      // (task-only) already; guard the raw-id path to match.
      return it && !it.deleted && it.type !== 'note' && canSee(userId, it.id) ? it : null;
    }
    if (input.query) {
      const pool = taskPool(userId, findList(userId, input.list), null, { includeDone: true });
      return bestMatch(input.query, pool, [(i) => i.title]).matched?.item ?? null;
    }
    return null;
  };

  function startTimer_(userId: string, input: TimerInput) {
    const target = findOneTask(userId, input);
    if (!target) return fail('task not found', 404);
    if (!canWrite(userId, target.id)) return fail('forbidden', 403);
    // One running timer per user: stop any in-flight one before starting the new one.
    const running = getRunningTimer(db, ownerOf(userId) ?? undefined);
    let stopped: { id: string; title: string } | null = null;
    if (running && running.item_id !== target.id) {
      stopTimer(db, deviceId, running.id);
      const prev = getItem(db, running.item_id);
      stopped = prev ? { id: prev.id, title: prev.title } : null;
    }
    if (!running || running.item_id !== target.id) {
      startTimer(db, deviceId, target.id, ownerOf(userId));
    }
    return ok({ started: { id: target.id, title: target.title }, stopped });
  }

  function stopTimer_(userId: string) {
    const running = getRunningTimer(db, ownerOf(userId) ?? undefined);
    if (!running) return ok({ stopped: null });
    stopTimer(db, deviceId, running.id);
    const it = getItem(db, running.item_id);
    return ok({ stopped: it ? { id: it.id, title: it.title } : { id: running.item_id, title: '' } });
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
    startTimer: startTimer_,
    stopTimer: stopTimer_,
  };
}
