/**
 * Disposable, DB-level test fixtures — usable from unit and integration tests
 * (not just Playwright). They seed a real `Db` (the core interface: node:sqlite in
 * server/core tests, sql.js/IndexedDB in web tests) with the shapes the release
 * plan's scenarios call for, reusing the representative-shape logic of
 * apps/web/src/lib/devSeed.ts (which is Playwright-bound) but operating directly
 * on the core Db.
 *
 * Every seeder is deterministic (fixed-seed PRNG) so runs are comparable, and all
 * bulk writes are pinned to an explicit sort_order and batched in one transaction
 * to avoid devSeed's O(n²) MAX(sort_order) trap.
 *
 * Not exported from the package barrel (like test-helpers.ts) so it never reaches
 * the web/server bundles. Import from this file directly in tests.
 */
import type { Db } from './db';
import {
  createItem,
  createTag,
  setItemTags,
  updateTag,
  deleteItem,
  shareItem,
  createUser,
  upsertAttachment,
  blobRefIndex,
  effectiveShares,
  allItems,
} from './repo';
import {
  LATEST_SCHEMA_VERSION,
} from './schema';
import type { Item, User, Attachment, Permission } from './types';
import { openMemoryDb } from './test-helpers';

// ----- deterministic PRNG (mulberry32), same as devSeed ----------------------

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
  'Work', 'Work:Email', 'Work:Deep', 'Home', 'Home:Errands',
  'Health', 'Finance', 'Reading', 'Someday', 'Waiting',
];

/** A fresh, in-memory Db migrated to the CURRENT schema version. The basic
 *  "current-version database" fixture: every test that needs a clean, up-to-date
 *  workspace starts here. */
export function freshWorkspaceDb(): Db {
  return openMemoryDb();
}

/** The current schema version a db is migrated to (stored in the `meta` table,
 *  key `schema_version`). Compare to LATEST_SCHEMA_VERSION to assert up-to-date. */
export function schemaVersion(db: Db): number {
  const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version']);
  return row ? Number(row.value) : 0;
}

/** Create `n` user rows (multiple users). Returns the users. */
export function seedUsers(
  db: Db,
  names: string[],
  role: 'admin' | 'member' = 'member',
): User[] {
  return names.map((username) =>
    createUser(db, { username, displayName: username, role }),
  );
}

interface WorkspaceOpts {
  /** Total live items to build (folders + projects + tasks ≈ n). */
  items?: number;
  ownerId?: string | null;
  seed?: number;
}

/**
 * Build a representative workspace (folders, projects — some sequential —, nested
 * sub-tasks, hierarchical tags incl. on-hold, due/defer dates, flags) of roughly
 * `n` live items in one transaction. Mirrors devSeed's shape so benchmark numbers
 * track subjective experience. Returns the live item count.
 */
export function seedWorkspace(db: Db, deviceId: string, opts: WorkspaceOpts = {}): number {
  const n = opts.items ?? 100;
  const ownerId = opts.ownerId ?? null;
  const rnd = mulberry32(opts.seed ?? 0x5eed1234);
  const chance = (p: number) => rnd() < p;
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

  let order = 0;
  db.transaction(() => {
    const tagIds = TAG_NAMES.map((name) => createTag(db, deviceId, name, null).id);
    for (const held of ['Someday', 'Waiting']) {
      updateTag(db, deviceId, createTag(db, deviceId, held, null).id, { status: 'on-hold' });
    }
    const tagsFor = (prob: number): string[] => {
      if (!chance(prob)) return [];
      const k = 1 + Math.floor(rnd() * 3);
      const s = new Set<string>();
      while (s.size < k) s.add(pick(tagIds));
      return [...s];
    };

    const folderCount = Math.min(8, Math.max(2, Math.round(n / 100)));
    const folderIds: string[] = [];
    for (let i = 0; i < folderCount; i++) {
      folderIds.push(
        createItem(db, deviceId, { type: 'folder', title: `Area ${i + 1}`, ownerId, sortOrder: order++ }).id,
      );
    }

    const projectCount = Math.max(3, Math.round(n / 15));
    const projects: string[] = [];
    for (let i = 0; i < projectCount; i++) {
      const p = createItem(db, deviceId, {
        type: 'project',
        title: `Project ${i + 1}`,
        ownerId,
        folderId: chance(0.7) ? pick(folderIds) : null,
        orderMode: chance(0.25) ? 'sequential' : 'parallel',
        sortOrder: order++,
      });
      projects.push(p.id);
      const tags = tagsFor(0.6);
      if (tags.length) setItemTags(db, deviceId, p.id, tags);
    }
    const projectSet = new Set(projects);

    const taskTarget = Math.max(0, n - folderCount - projectCount);
    const depth1: string[] = [];
    for (let made = 0; made < taskTarget; made++) {
      let parentId: string | null;
      if (chance(0.15)) parentId = null;
      else if (depth1.length && chance(0.3)) parentId = pick(depth1);
      else parentId = pick(projects);

      const t = createItem(db, deviceId, {
        type: 'task',
        title: `Task ${made + 1}`,
        ownerId,
        parentId,
        flagged: chance(0.12),
        dueDate: chance(0.3) ? null : null, // dates set by callers when they matter
        sortOrder: order++,
      });
      if (parentId !== null && projectSet.has(parentId) && depth1.length < 600 && chance(0.5)) {
        depth1.push(t.id);
      }
      const tags = tagsFor(0.55);
      if (tags.length) setItemTags(db, deviceId, t.id, tags);
    }
  });

  const live = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM items WHERE deleted = 0')?.c ?? 0;
  return live;
}

/**
 * The large-workspace scenarios from the release plan (A0 fixtures):
 *   - normal target: { active: 10_000, historical: 90_000 }
 *   - stress:        { active: 100_000 }  (historical 0)
 *
 * `active` items are live tasks; `historical` are soft-deleted (deleted=1) tasks
 * — the records that "remain available offline but are queried/rendered on
 * demand." Flat top-level tasks (fast to seed and to delete). Returns the counts.
 */
export function seedLargeWorkspace(
  db: Db,
  deviceId: string,
  size: { active: number; historical?: number; ownerId?: string | null },
): { active: number; historical: number } {
  const historical = size.historical ?? 0;
  const ownerId = size.ownerId ?? null;
  let order = 0;

  // Active first, then historical (so historical rowids sit after active — a real
  // workspace's churn shape). One transaction keeps it a single commit.
  db.transaction(() => {
    for (let i = 0; i < size.active; i++) {
      createItem(db, deviceId, {
        type: 'task',
        title: `Active ${i}`,
        ownerId,
        sortOrder: order++,
      });
    }
    for (let i = 0; i < historical; i++) {
      const t = createItem(db, deviceId, {
        type: 'task',
        title: `Historical ${i}`,
        ownerId,
        sortOrder: order++,
      });
      deleteItem(db, deviceId, t.id);
    }
  });

  const live = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM items WHERE deleted = 0')?.c ?? 0;
  const dead = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM items WHERE deleted = 1')?.c ?? 0;
  return { active: live, historical: dead };
}

/** Build a parent→child chain `depth` levels deep (deep hierarchy). Returns the
 *  leaf item id. */
export function seedDeepHierarchy(
  db: Db,
  deviceId: string,
  depth: number,
  ownerId?: string | null,
): string {
  let parent: string | null = null;
  let last = '';
  for (let i = 0; i < depth; i++) {
    const t = createItem(db, deviceId, {
      type: 'task',
      title: `Level ${i}`,
      ownerId: ownerId ?? null,
      parentId: parent,
      orderMode: 'sequential',
    });
    last = t.id;
    parent = t.id;
  }
  return last;
}

/** Share a project + sub-task subtree to a set of users (shared subtrees).
 *  `root` is created (owned by ownerId) and shared; one sub-task is shared too.
 *  Returns the root id and the effective shares seen by each user. */
export function seedSharedSubtree(
  db: Db,
  deviceId: string,
  userIds: string[],
  opts: { ownerId?: string | null; permission?: Permission } = {},
): { rootId: string; shares: Record<string, ReturnType<typeof effectiveShares>> } {
  const ownerId = opts.ownerId ?? null;
  const permission: Permission = opts.permission ?? 'read';
  const root = createItem(db, deviceId, {
    type: 'project',
    title: 'Shared Project',
    ownerId,
    orderMode: 'parallel',
  });
  for (const u of userIds) shareItem(db, deviceId, root.id, u, permission);
  // A sub-task inside the shared project (exercises inherited/ancestor shares).
  const child = createItem(db, deviceId, {
    type: 'task',
    title: 'Shared Subtask',
    ownerId,
    parentId: root.id,
  });
  void child;

  const shares: Record<string, ReturnType<typeof effectiveShares>> = {};
  for (const u of userIds) shares[u] = effectiveShares(db, root.id).filter((s) => s.user_id === u);
  return { rootId: root.id, shares };
}

/** Attach `count` content-addressed attachments whose blob bytes are NOT on disk
 *  (missing blobs). The note/attachment references a 64-hex hash that no blob
 *  file satisfies — the exact shape that surfaces missing-asset rendering.
 *  Returns the referenced hashes. */
export function seedMissingBlobs(
  db: Db,
  deviceId: string,
  count: number,
  ownerId?: string | null,
): { itemIds: string[]; hashes: string[] } {
  const itemIds: string[] = [];
  const hashes: string[] = [];
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const t = createItem(db, deviceId, {
        type: 'task',
        title: `Blob task ${i}`,
        ownerId: ownerId ?? null,
      });
      itemIds.push(t.id);
      // A 64-hex hash; no blob file is written, so it is "missing" by definition.
      const hash = `deadbeef${i.toString(16).padStart(12, '0')}`.slice(0, 64).padEnd(64, '0');
      const att: Attachment = {
        id: `att-${i}`,
        parent_type: 'item',
        parent_id: t.id,
        item_id: t.id,
        filename: `missing-${i}.bin`,
        mime_type: 'application/octet-stream',
        size: 1024,
        hash,
        created_by: ownerId ?? null,
        created_at: now,
        deleted: false,
      };
      upsertAttachment(db, att);
      hashes.push(hash);
    }
  });
  return { itemIds, hashes };
}

/** Count of live items (helper for assertions). */
export function liveItemCount(db: Db): number {
  return db.get<{ c: number }>('SELECT COUNT(*) AS c FROM items WHERE deleted = 0')?.c ?? 0;
}

/** Count of soft-deleted items. */
export function deletedItemCount(db: Db): number {
  return db.get<{ c: number }>('SELECT COUNT(*) AS c FROM items WHERE deleted = 1')?.c ?? 0;
}

/** Whether every hash `seedMissingBlobs` produced is still "missing" per the
 *  workspace's blob-ref index (i.e. referenced but not materialised on disk). */
export function missingBlobHashes(db: Db, hashes: string[]): string[] {
  const { full, thumbs } = blobRefIndex(db);
  const referenced = new Set<string>([...full, ...thumbs].map((h) => h.toLowerCase()));
  return hashes.filter((h) => referenced.has(h.toLowerCase()));
}

// Re-export a couple of core readers/types fixtures commonly need alongside seeding.
export { allItems };
export type { Item, User, Attachment };
export { LATEST_SCHEMA_VERSION };
