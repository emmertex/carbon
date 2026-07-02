/**
 * Dev-only bulk-seed helpers for the performance benchmark.
 *
 * Typing thousands of tasks through the UI takes tens of minutes, so the
 * benchmark "fast-forwards" the list to a milestone size with a single batched
 * insert and then performs its *measured* add/complete/scroll/switch actions as
 * real keystrokes at that size. These helpers only change the list size cheaply —
 * they are never part of what the benchmark measures.
 *
 * The seed is deliberately *representative* rather than flat: it builds folders,
 * projects (some sequential), nested sub-tasks, hierarchical tags (a couple
 * on-hold), due/defer dates and flags, plus a handful of saved perspectives. A
 * flat list of bare top-level tasks hides exactly the costs a real workspace pays
 * — ancestor walks, per-item tag/blocked/assignee enrichment, and the sidebar's
 * per-project / per-perspective recompute — so a flat seed makes the app look far
 * faster under benchmark than it feels in use. The shape here mirrors a real
 * GTD-style workspace so the numbers track subjective experience.
 *
 * The structure is driven by a fixed-seed PRNG so runs are comparable; only the
 * absolute due/defer dates move with the wall clock (which is what keeps Today /
 * Forecast populated).
 *
 * Registered from main.tsx in dev builds only, after the DB is initialised.
 */
import { createItem, createTag, setItemTags, updateTag } from '@carbon/core';
import { getDb, getDeviceId, flushPersist } from './db';
import { useStore, getCurrentUserId } from './store';
import {
  addPerspective,
  getPerspectives,
  removePerspective,
  baseDefaultFilters,
  DEFAULT_PREFS,
  type Base,
} from './views';
import { perf } from './perf';

function liveCount(): number {
  const row = getDb().get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM items WHERE deleted = 0',
  );
  return row?.c ?? 0;
}

/** Deterministic PRNG (mulberry32) so a milestone's structure is identical run to
 *  run — before/after comparisons then differ only by the code under test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAG_NAMES = [
  'Work',
  'Work:Email',
  'Work:Meetings',
  'Work:Deep',
  'Home',
  'Home:Errands',
  'Home:Chores',
  'Health',
  'Health:Gym',
  'Finance',
  'Finance:Bills',
  'Reading',
  'Shopping',
  'Shopping:Groceries',
  'Someday',
  'Waiting',
];

/** Add a representative set of saved perspectives (localStorage). The sidebar runs
 *  the full list query once per perspective on every mutation, so their presence is
 *  a real per-interaction cost the flat seed never exercised. */
function seedPerspectives(): void {
  for (const p of getPerspectives()) removePerspective(p.id);
  const defs: Array<{ name: string; base: Base }> = [
    { name: 'Perf: Flagged', base: 'flagged' },
    { name: 'Perf: Inbox', base: 'inbox' },
    { name: 'Perf: Today+', base: 'today' },
    { name: 'Perf: All', base: 'all' },
  ];
  defs.forEach((d, i) =>
    addPerspective({
      id: `perf-persp-${i}`,
      name: d.name,
      base: d.base,
      prefs: { ...DEFAULT_PREFS, filters: baseDefaultFilters(d.base) },
    }),
  );
}

/**
 * Build a representative workspace of roughly `n` items in one transaction (one
 * persist + one React bump for the whole batch). Returns the new live item count.
 */
async function seed(n: number): Promise<number> {
  const db = getDb();
  const dev = getDeviceId();
  const ownerId = getCurrentUserId();

  const rnd = mulberry32(0x5eed1234);
  const chance = (p: number) => rnd() < p;
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const now = Date.now();
  const DAY = 86_400_000;
  const iso = (offsetDays: number) => new Date(now + offsetDays * DAY).toISOString();

  // Pin sort_order explicitly (global monotonic counter) so createItem skips its
  // per-row MAX(sort_order) lookup — that lookup alone would make seeding O(n²).
  let order = 0;

  db.transaction(() => {
    // --- Tags: a small hierarchical set; a couple put on-hold ---
    const tagIds = TAG_NAMES.map((name) => createTag(db, dev, name, null).id);
    for (const held of ['Someday', 'Waiting']) {
      const t = createTag(db, dev, held, null); // idempotent — returns existing
      updateTag(db, dev, t.id, { status: 'on-hold' });
    }
    const tagsFor = (prob: number): string[] => {
      if (!chance(prob)) return [];
      const k = 1 + Math.floor(rnd() * 3);
      const s = new Set<string>();
      while (s.size < k) s.add(pick(tagIds));
      return [...s];
    };
    // Per-task decoration (due/defer/flag/priority) that keeps Today/Forecast full.
    const decorate = () => ({
      flagged: chance(0.12),
      dueDate: chance(0.3) ? iso(Math.floor(rnd() * 40) - 10) : null, // -10..+30d
      deferDate: chance(0.08) ? iso(1 + Math.floor(rnd() * 20)) : null,
      priority: chance(0.4) ? 1 + Math.floor(rnd() * 3) : 0,
    });

    // --- Folders (sidebar grouping) ---
    const folderCount = Math.min(8, Math.max(2, Math.round(n / 100)));
    const folderIds: string[] = [];
    for (let i = 0; i < folderCount; i++) {
      folderIds.push(
        createItem(db, dev, { type: 'folder', title: `Area ${i + 1}`, ownerId, sortOrder: order++ })
          .id,
      );
    }

    // --- Projects (some sequential → exercise availability/blocking) ---
    const projectCount = Math.max(3, Math.round(n / 15));
    const projects: string[] = [];
    for (let i = 0; i < projectCount; i++) {
      const p = createItem(db, dev, {
        type: 'project',
        title: `Project ${i + 1}`,
        ownerId,
        folderId: chance(0.7) ? pick(folderIds) : null,
        orderMode: chance(0.25) ? 'sequential' : 'parallel',
        sortOrder: order++,
      });
      projects.push(p.id);
      const tags = tagsFor(0.6);
      if (tags.length) setItemTags(db, dev, p.id, tags);
    }
    const projectSet = new Set(projects);

    // --- Tasks: fill up to ~n total items, with some depth-2 sub-tasks ---
    const taskTarget = Math.max(0, n - folderCount - projectCount);
    const depth1: string[] = []; // tasks directly under a project (can gain children)
    for (let made = 0; made < taskTarget; made++) {
      // ~15% inbox (no parent); otherwise under a project, sometimes nested one
      // level deeper under an existing depth-1 task (bounded to depth 2).
      let parentId: string | null;
      if (chance(0.15)) parentId = null;
      else if (depth1.length && chance(0.3)) parentId = pick(depth1);
      else parentId = pick(projects);

      const d = decorate();
      const t = createItem(db, dev, {
        type: 'task',
        title: `Task ${made + 1}`,
        ownerId,
        parentId,
        flagged: d.flagged,
        dueDate: d.dueDate,
        deferDate: d.deferDate,
        priority: d.priority,
        sortOrder: order++,
      });
      if (parentId !== null && projectSet.has(parentId) && depth1.length < 600 && chance(0.5)) {
        depth1.push(t.id);
      }
      const tags = tagsFor(0.55);
      if (tags.length) setItemTags(db, dev, t.id, tags);
    }
  });

  seedPerspectives();

  useStore.getState().bump();
  await flushPersist();
  const total = liveCount();
  perf.setTaskCount(total);
  return total;
}

/** Hard-wipe all task/tag/plan data so the next milestone starts from a clean,
 *  genuinely small table (raw DELETE, not the CRDT soft-delete — this is a dev
 *  reset). Also drops the seeded perspectives so they don't accumulate. */
async function reset(): Promise<void> {
  const db = getDb();
  db.transaction(() => {
    for (const tbl of ['items', 'ops', 'tags', 'item_tags', 'item_deps', 'plan', 'record_ops']) {
      db.run(`DELETE FROM ${tbl}`);
    }
  });
  for (const p of getPerspectives()) removePerspective(p.id);
  useStore.getState().bump();
  await flushPersist();
  perf.setTaskCount(liveCount());
}

export function registerDevSeed(): void {
  if (typeof window === 'undefined') return;
  window.__carbonSeed = seed;
  window.__carbonReset = reset;
  window.__carbonFlushPersist = flushPersist;
  perf.setTaskCount(liveCount());
}
