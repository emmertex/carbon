import { endOfToday, type Item } from '@carbon/core';

export type Base = 'all' | 'today' | 'inbox' | 'flagged';
export type SortKey = 'manual' | 'due' | 'priority' | 'title' | 'created';

export interface Filters {
  showCompleted: boolean;
  flaggedOnly: boolean;
  /** Match tasks carrying ANY of these tags (or a descendant). OR semantics. */
  tagAny: string[];
  /** Match tasks carrying ALL of these tags (each may be satisfied by a descendant). */
  tagAll: string[];
  /** Exclude tasks carrying ANY of these tags (or a descendant). */
  tagNone: string[];
  /** Only tasks with no tags. */
  noTags: boolean;
  priorities: number[];
  projectIds: string[];
  /** Only tasks not inside any project. */
  noProject: boolean;
  noDueDate: boolean;
  /** yyyy-mm-dd (inclusive). */
  dueBefore: string | null;
  dueAfter: string | null;
  /** Hide tasks whose defer date is in the future. */
  hideDeferred: boolean;
  /** Hide tasks that are blocked/unavailable (sequential gating or unmet deps). */
  hideBlocked: boolean;
}

export interface ViewPrefs {
  sort: SortKey;
  filters: Filters;
}

export const DEFAULT_FILTERS: Filters = {
  showCompleted: false,
  flaggedOnly: false,
  tagAny: [],
  tagAll: [],
  tagNone: [],
  noTags: false,
  priorities: [],
  projectIds: [],
  noProject: false,
  noDueDate: false,
  dueBefore: null,
  dueAfter: null,
  hideDeferred: false,
  hideBlocked: false,
};

export const DEFAULT_PREFS: ViewPrefs = { sort: 'manual', filters: { ...DEFAULT_FILTERS } };

/** Per-base default filters. Today hides blocked/unavailable tasks out of the box
 *  (OmniFocus "Available" behaviour); a "Show blocked" toggle reveals them. */
export function baseDefaultFilters(key: string): Filters {
  if (key === 'today') return { ...DEFAULT_FILTERS, hideBlocked: true };
  return { ...DEFAULT_FILTERS };
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** Fill defaults + migrate older saved shapes (single tagId / tagIds -> tagAny). */
export function normalizeFilters(raw: unknown): Filters {
  const r = (raw ?? {}) as Record<string, unknown> & { tagId?: string | null };
  // Legacy OR-list (or single id) becomes the new "any" set.
  const legacyAny = Array.isArray(r.tagIds) ? (r.tagIds as string[]) : r.tagId ? [r.tagId] : [];
  return {
    ...DEFAULT_FILTERS,
    ...r,
    tagAny: r.tagAny !== undefined ? strArr(r.tagAny) : legacyAny,
    tagAll: strArr(r.tagAll),
    tagNone: strArr(r.tagNone),
    priorities: Array.isArray(r.priorities) ? (r.priorities as number[]) : [],
    projectIds: Array.isArray(r.projectIds) ? (r.projectIds as string[]) : [],
  };
}

/** Whether any filter (beyond defaults) is active. */
export function anyFilterActive(f: Filters): boolean {
  return (
    f.showCompleted ||
    f.flaggedOnly ||
    f.tagAny.length > 0 ||
    f.tagAll.length > 0 ||
    f.tagNone.length > 0 ||
    f.noTags ||
    f.priorities.length > 0 ||
    f.projectIds.length > 0 ||
    f.noProject ||
    f.noDueDate ||
    !!f.dueBefore ||
    !!f.dueAfter ||
    f.hideDeferred ||
    f.hideBlocked
  );
}

export const SORT_LABELS: Record<SortKey, string> = {
  manual: 'Manual',
  due: 'Due date',
  priority: 'Priority',
  title: 'Title',
  created: 'Newest',
};

/** The candidate set for a built-in perspective (status-agnostic; the
 *  showCompleted filter decides whether done items appear). */
export function baseFilter(base: Base, items: Item[], now: Date = new Date()): Item[] {
  const tasks = items.filter((i) => i.type === 'task');
  switch (base) {
    case 'inbox':
      return tasks.filter((i) => i.parent_id === null);
    case 'flagged':
      return tasks.filter((i) => i.flagged);
    case 'today': {
      const cut = endOfToday(now).getTime();
      return tasks.filter((i) => {
        const deferredFuture =
          i.status === 'active' && i.defer_date && new Date(i.defer_date).getTime() > now.getTime();
        if (deferredFuture) return false;
        const due = i.due_date ? new Date(i.due_date).getTime() : null;
        return (due !== null && due <= cut) || i.flagged;
      });
    }
    case 'all':
      return tasks;
  }
}

export function applySort(items: Item[], sort: SortKey): Item[] {
  const s = [...items];
  switch (sort) {
    case 'due':
      return s.sort(
        (a, b) =>
          (a.due_date ? +new Date(a.due_date) : Infinity) -
          (b.due_date ? +new Date(b.due_date) : Infinity),
      );
    case 'priority':
      return s.sort((a, b) => b.priority - a.priority);
    case 'title':
      return s.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    case 'created':
      return s.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    case 'manual':
    default:
      return s.sort((a, b) => a.sort_order - b.sort_order);
  }
}

// ----- persistence: per-base prefs + saved perspectives (localStorage) -------

export interface SavedPerspective {
  id: string;
  name: string;
  base: Base;
  prefs: ViewPrefs;
}

const PREFS_KEY = (key: string) => `carbon.viewprefs.${key}`;
const PERSPECTIVES_KEY = 'carbon.perspectives';

/** `key` is a base ('today', 'all', …) or a scope like `project:<id>`. */
export function getPrefs(key: string): ViewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY(key));
    if (!raw) return { ...DEFAULT_PREFS, filters: baseDefaultFilters(key) };
    const parsed = JSON.parse(raw) as Partial<ViewPrefs>;
    const filters = normalizeFilters(parsed.filters);
    // Migrate older Today blobs (saved before hideBlocked existed) to default-on,
    // while respecting an explicit stored choice.
    if (key === 'today' && !(parsed.filters && 'hideBlocked' in parsed.filters)) {
      filters.hideBlocked = true;
    }
    return { ...DEFAULT_PREFS, ...parsed, filters };
  } catch {
    return { ...DEFAULT_PREFS, filters: baseDefaultFilters(key) };
  }
}

export function savePrefs(key: string, prefs: ViewPrefs): void {
  localStorage.setItem(PREFS_KEY(key), JSON.stringify(prefs));
}

export function getPerspectives(): SavedPerspective[] {
  try {
    return JSON.parse(localStorage.getItem(PERSPECTIVES_KEY) || '[]') as SavedPerspective[];
  } catch {
    return [];
  }
}

export function getPerspective(id: string): SavedPerspective | undefined {
  const p = getPerspectives().find((x) => x.id === id);
  if (!p) return undefined;
  return { ...p, prefs: { ...DEFAULT_PREFS, ...p.prefs, filters: normalizeFilters(p.prefs.filters) } };
}

export function addPerspective(p: SavedPerspective): void {
  localStorage.setItem(PERSPECTIVES_KEY, JSON.stringify([...getPerspectives(), p]));
}

export function removePerspective(id: string): void {
  localStorage.setItem(
    PERSPECTIVES_KEY,
    JSON.stringify(getPerspectives().filter((p) => p.id !== id)),
  );
}

export function updatePerspective(id: string, patch: Partial<SavedPerspective>): void {
  localStorage.setItem(
    PERSPECTIVES_KEY,
    JSON.stringify(getPerspectives().map((p) => (p.id === id ? { ...p, ...patch } : p))),
  );
}
