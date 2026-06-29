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
  tasksNearLocation,
  visibleItemIds,
  hasWriteAccess,
  getUser,
  listAssigneesForItem,
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

// ----- input shapes (shared by routes and the command loop) -----------------

export interface ItemsInput {
  list?: ListRef;
  tag?: string;
  q?: string;
  status?: string;
  limit?: number;
  detail?: boolean;
}
export interface ResolveInput {
  kind?: string;
  q?: string;
  list?: ListRef;
  limit?: number;
}
export interface TaskInput {
  title: string;
  note?: string;
  due_date?: string;
  defer_date?: string;
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
}
export interface UpdateInput {
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

export type AgentOps = ReturnType<typeof createAgentOps>;

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
    note: it.note,
    status: it.status,
    due_date: it.due_date,
    defer_date: it.defer_date,
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

  const taskPool = (userId: string, list: Item | null, tag: Tag | null): Item[] => {
    const scope = scopeItems(userId);
    let items: Item[];
    if (list) items = getChildren(db, list.id).filter((i) => i.type === 'task');
    else if (tag) items = getItemsByTag(db, tag.id);
    else items = queryItems(db, { tasksOnly: true, activeOnly: true });
    return items.filter((i) => !i.deleted && (!scope || scope.has(i.id)));
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

  function items(userId: string, input: ItemsInput) {
    const status = input.status ?? 'active';
    const limit = Math.min(input.limit || 50, 200);
    const list = findList(userId, input.list);
    const tag = findTag(input.tag);
    let pool = taskPool(userId, list, tag);
    if (status === 'active') pool = pool.filter((i) => i.status === 'active');
    else if (status === 'done') pool = pool.filter((i) => i.status === 'done');
    const q = input.q?.trim();
    if (q) pool = rankBy(q, pool, [(i) => i.title]).map((s) => s.item);
    pool = pool.slice(0, limit);
    return ok({ items: pool.map(input.detail ? detailItem : minimalItem) });
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
      ranked = rankBy(q, taskPool(userId, list, null), [(i) => i.title], { limit });
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

    const created: Array<{ id: string; title: string }> = [];
    for (const t of taskInputs) {
      const it = createItem(db, deviceId, {
        title: t.title,
        note: t.note ?? null,
        parentId: listItem?.id ?? null,
        ownerId: ownerOf(userId),
        dueDate: t.due_date ?? null,
        deferDate: t.defer_date ?? null,
        flagged: !!t.flagged,
        priority: typeof t.priority === 'number' ? t.priority : 0,
      });
      const tagIds = new Set(sharedTagOut.map((x) => x.id));
      for (const name of t.tags ?? []) {
        const id = perTaskTagById.get(name);
        if (id) tagIds.add(id);
      }
      for (const id of tagIds) setItemTagLink(db, deviceId, it.id, id, false);
      created.push({ id: it.id, title: it.title });
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
      if (!it || it.deleted || !canSee(userId, id)) {
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

    const pool = taskPool(userId, list, tag);
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
    'due_date',
    'defer_date',
    'flagged',
    'priority',
    'status',
  ] as const;

  function update(userId: string, input: UpdateInput) {
    if (tooMany(input.updates)) return fail(`too many updates (max ${MAX_BATCH})`, 400);
    const matched: Array<{ query: string; id: string; title: string }> = [];
    const unmatched: Array<{ query: string; reason: string }> = [];
    for (const u of input.updates ?? []) {
      const label = u.id ?? u.query ?? '';
      let target: Item | null = null;
      if (u.id) {
        const it = getItem(db, u.id);
        target = it && !it.deleted && canSee(userId, it.id) ? it : null;
      } else if (u.query) {
        const pool = taskPool(userId, findList(userId, u.list), findTag(u.tag));
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
      updateItem(db, deviceId, target.id, patch);
      matched.push({ query: label, id: target.id, title: target.title });
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

    const unmatched: Array<{ query: string; reason: string }> = [];
    let targets: Item[];
    if (input.ids?.length || input.queries?.length) {
      targets = [];
      for (const id of input.ids ?? []) {
        const it = getItem(db, id);
        if (it && !it.deleted && canSee(userId, id)) targets.push(it);
        else unmatched.push({ query: id, reason: 'no_match' });
      }
      const pool = taskPool(userId, findList(userId, input.list), findTag(input.tag));
      for (const q of input.queries ?? []) {
        const hit = bestMatch(q, pool, [(i) => i.title]).matched?.item;
        if (hit) targets.push(hit);
        else unmatched.push({ query: q, reason: 'no_match' });
      }
    } else {
      const list = findList(userId, input.list);
      const tag = findTag(input.tag);
      if (!list && !tag) return fail('specify list, tag, ids, or queries', 404);
      targets = taskPool(userId, list, tag);
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

  return {
    lists,
    tags,
    items,
    item,
    resolve,
    addTasks,
    complete,
    update,
    tagItems,
    tagGeo,
    nearby,
    geocodeSearch,
  };
}
