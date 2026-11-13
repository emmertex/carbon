import {
  getProjects,
  getFolders,
  needsReview,
  trashCount,
  openCountsByContainer,
  sharedRoots,
  tasksNearLocation,
  listTags,
  tagCounts,
  effectiveTagColor,
  listPlan,
  getItem,
  type CountScope,
  type Db,
  type Item,
} from '@carbon/core';
import { countOverdueTasks } from './sidebarCounts';
import { queryRoots } from './listQuery';
import { DEFAULT_PREFS, baseDefaultFilters, type SavedPerspective } from './views';
import { buildTagTree } from './tagTree';
import { childrenIndex, cachedSubtaskProgress } from './childrenIndex';

// The sidebar's background read-outs as plain (db, args) → data functions, so they
// run unchanged on the main thread or in the read-replica worker (replica.worker.ts).
// Everything here and everything it imports must stay free of the store, React,
// localStorage and DOM: main-thread state arrives in `args`, and results must be
// structured-clonable.

export function projectsSection(db: Db, args: { countScope: CountScope }) {
  const allProjects = getProjects(db);
  const projects = allProjects.filter((project) => project.status !== 'done');
  const archivedProjects = allProjects.filter((project) => project.status === 'done');
  const folders = getFolders(db);
  // One pass for every project's open count, instead of a recursive
  // subtaskProgress walk per project on each (deferred) sidebar render.
  const counts = openCountsByContainer(
    db,
    projects.map((p) => p.id),
    args.countScope,
    childrenIndex(db),
  );
  const openById: Record<string, number> = {};
  for (const p of projects) openById[p.id] = counts.get(p.id) ?? 0;
  return { projects, archivedProjects, folders, openById };
}

export function tagsSection(db: Db) {
  const tags = listTags(db);
  // Resolve display colour (own or inherited) so nested tags show their parent's hue.
  const resolved = tags.map((t) => ({ ...t, color: effectiveTagColor(db, t.name) }));
  return { roots: buildTagTree(resolved, tagCounts(db)) };
}

export function perspectiveCounts(db: Db, args: { perspectives: SavedPerspective[] }) {
  return Object.fromEntries(
    args.perspectives.map((p) => [p.id, queryRoots(db, p.base, p.prefs).length]),
  );
}

type NearArgs = Parameters<typeof tasksNearLocation>[1];

export function navCounts(
  db: Db,
  args: {
    countScope: CountScope;
    me: string | null;
    where: { hasLocation: boolean; zone: NearArgs['zone']; point: NearArgs['point'] };
  },
) {
  const { countScope, me, where } = args;
  // queryRoots applies SQL prefetch and caches its result by revision, so repeated
  // renders at the same revision (or view switches) hit the cache.
  const todayItems = queryRoots(db, 'today', { ...DEFAULT_PREFS, filters: baseDefaultFilters('today') });
  const inboxItems = queryRoots(db, 'inbox', { ...DEFAULT_PREFS, filters: baseDefaultFilters('inbox') });
  const flaggedItems = queryRoots(db, 'flagged', { ...DEFAULT_PREFS, filters: baseDefaultFilters('flagged') });
  const projects = getProjects(db);

  // Remaining work in scope (recursive for 'all'), kept consistent with the pie.
  const remaining = (id: string) => {
    const { done, total } = cachedSubtaskProgress(db, id, countScope);
    return total - done;
  };
  const planCount = listPlan(db, me)
    .map((p) => getItem(db, p.item_id))
    .filter((i): i is Item => !!i && !i.deleted && i.status === 'active').length;
  return {
    todayCount: todayItems.length,
    inboxCount: inboxItems.length,
    flaggedCount: flaggedItems.length,
    overdueCount: countOverdueTasks(db),
    nearbyCount: where.hasLocation
      ? tasksNearLocation(db, { zone: where.zone, point: where.point }).length
      : 0,
    planCount,
    reviewCount: projects.filter((p) => needsReview(p)).length,
    trashCount: trashCount(db),
    shared: (me ? sharedRoots(db, me) : []).map((it) => ({
      item: it,
      open: remaining(it.id),
    })),
  };
}

/** Name → query, shared by the main thread and the replica worker. */
export const SIDEBAR_QUERIES = {
  projectsSection,
  tagsSection,
  perspectiveCounts,
  navCounts,
};

export type SidebarQueryName = keyof typeof SIDEBAR_QUERIES;
export type SidebarQueryArgs<N extends SidebarQueryName> = Parameters<
  (typeof SIDEBAR_QUERIES)[N]
>[1];
export type SidebarQueryResult<N extends SidebarQueryName> = ReturnType<
  (typeof SIDEBAR_QUERIES)[N]
>;
