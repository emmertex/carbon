import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  freshWorkspaceDb,
  schemaVersion,
  LATEST_SCHEMA_VERSION,
  seedUsers,
  seedWorkspace,
  seedLargeWorkspace,
  seedDeepHierarchy,
  seedSharedSubtree,
  seedMissingBlobs,
  liveItemCount,
  deletedItemCount,
  missingBlobHashes,
  allItems,
} from './test-fixtures';

const DEV = 'fixture-dev';

/** Opt-in heavy scenarios (release-plan normal target + stress) are gated so the
 *  default suite stays fast; the seeder itself accepts any size. */
const STRESS = process.env.CARBON_FIXTURE_STRESS === '1';

describe('disposable fixtures — current-version database', () => {
  test('freshWorkspaceDb is migrated to the latest schema version', () => {
    const db = freshWorkspaceDb();
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    // A few tables that only exist at the current version:
    for (const tbl of ['record_ops', 'attachments', 'items', 'shares']) {
      const r = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tbl],
      );
      assert.equal(r?.n, 1, `${tbl} table present at current schema`);
    }
  });
});

describe('disposable fixtures — multiple users', () => {
  test('seedUsers creates the requested user rows', () => {
    const db = freshWorkspaceDb();
    const users = seedUsers(db, ['alice', 'bob', 'carol'], 'member');
    assert.equal(users.length, 3);
    assert.ok(users.every((u) => !u.deleted));
    const count = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c ?? 0;
    assert.ok(count >= 3);
  });
});

describe('disposable fixtures — representative workspace', () => {
  test('seedWorkspace builds a representative live workspace', () => {
    const db = freshWorkspaceDb();
    const owner = seedUsers(db, ['owner'])[0]!;
    const live = seedWorkspace(db, DEV, { items: 200, ownerId: owner.id });
    assert.ok(live >= 150, `live items ~200 (got ${live})`);
    // Folders, projects, and tasks all present.
    const byType = (t: string) =>
      db.get<{ c: number }>('SELECT COUNT(*) AS c FROM items WHERE type = ? AND deleted = 0', [t])?.c ?? 0;
    assert.ok(byType('folder') >= 2);
    assert.ok(byType('project') >= 3);
    assert.ok(byType('task') > 0);
    // Tags (incl. on-hold) exist.
    assert.ok((db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tags WHERE deleted = 0')?.c ?? 0) > 0);
    assert.ok((db.get<{ c: number }>("SELECT COUNT(*) AS c FROM tags WHERE status = 'on-hold' AND deleted = 0")?.c ?? 0) >= 1);
  });
});

describe('disposable fixtures — shared subtrees', () => {
  test('seedSharedSubtree shares a project subtree to each user', () => {
    const db = freshWorkspaceDb();
    const users = seedUsers(db, ['owner', 'alice', 'bob']);
    const owner = users[0]!;
    const alice = users[1]!;
    const bob = users[2]!;
    const { rootId, shares } = seedSharedSubtree(db, DEV, [alice.id, bob.id], {
      ownerId: owner.id,
      permission: 'read',
    });
    assert.ok(allItems(db).some((i) => i.id === rootId), 'root project exists');
    for (const u of [alice.id, bob.id]) {
      assert.ok(
        shares[u]?.some((s) => s.permission === 'read'),
        `user ${u} has an effective read share on the shared subtree`,
      );
    }
  });
});

describe('disposable fixtures — missing blobs', () => {
  test('seedMissingBlobs references hashes that are not materialised on disk', () => {
    const db = freshWorkspaceDb();
    const { itemIds, hashes } = seedMissingBlobs(db, DEV, 3);
    assert.equal(itemIds.length, 3);
    assert.equal(hashes.length, 3);
    // All referenced hashes are seen by the workspace blob-ref index (i.e. "missing"
    // because no blob file was written for them).
    const missing = missingBlobHashes(db, hashes);
    assert.ok(missing.length >= 1, 'at least one referenced blob hash is present in the ref index');
    // Attachments exist for the seeded items.
    const attCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM attachments WHERE deleted = 0')?.c ?? 0;
    assert.equal(attCount, 3);
  });
});

describe('disposable fixtures — deep hierarchies', () => {
  test('seedDeepHierarchy builds a chain of the requested depth', () => {
    const db = freshWorkspaceDb();
    const leafId = seedDeepHierarchy(db, DEV, 25);
    const byId = new Map(allItems(db).map((i) => [i.id, i]));
    let depth = 0;
    let cur: string | null | undefined = leafId;
    while (cur) {
      const item = byId.get(cur);
      if (!item?.parent_id) break;
      cur = item.parent_id;
      depth++;
    }
    assert.equal(depth, 24, '25-level chain has 24 parent links above the leaf');
  });
});

describe('disposable fixtures — large workspaces', () => {
  // Fast scaled sanity (≈1.6s): proves the seeder produces the requested active
  // count and soft-deleted historical records (queried on demand, deleted=1).
  test('seedLargeWorkspace seeds active + soft-deleted historical', () => {
    const db = freshWorkspaceDb();
    const r = seedLargeWorkspace(db, DEV, { active: 1000, historical: 9000 });
    assert.equal(r.active, 1000);
    assert.equal(r.historical, 9000);
    assert.equal(liveItemCount(db), 1000);
    assert.equal(deletedItemCount(db), 9000);
  });

  // The release-plan NORMAL TARGET (10k active + 90k historical) — opt-in (≈17s).
  test(
    'normal target: 10k active + 90k historical [opt-in CARBON_FIXTURE_STRESS=1]',
    { skip: !STRESS },
    () => {
      const db = freshWorkspaceDb();
      const r = seedLargeWorkspace(db, DEV, { active: 10_000, historical: 90_000 });
      assert.equal(r.active, 10_000);
      assert.equal(r.historical, 90_000);
      assert.equal(liveItemCount(db), 10_000);
      assert.equal(deletedItemCount(db), 90_000);
    },
  );

  // The release-plan STRESS (100k active) — opt-in (slowest).
  test(
    'stress: 100k active [opt-in CARBON_FIXTURE_STRESS=1]',
    { skip: !STRESS },
    () => {
      const db = freshWorkspaceDb();
      const r = seedLargeWorkspace(db, DEV, { active: 100_000 });
      assert.equal(r.active, 100_000);
      assert.equal(liveItemCount(db), 100_000);
    },
  );
});
