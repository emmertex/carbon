import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import {
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  getSchemaVersion,
  verifyMigration,
  type Migration,
} from "@carbon/core";
import { openDb } from "./sqlite";
import { migrateWithRepair } from "./migration-repair";

/**
 * Atomic schema/migration repair (A4): a migration that fails must leave the tenant at the
 * last KNOWN-GOOD schema — never half-migrated. The file-level repair takes a pre-migration
 * snapshot, runs the pending migrations in one transaction, VERIFIES the result before
 * exposing it, and on failure restores the snapshot and surfaces a clear error (retry on
 * next load). This test forces a bad migration and proves: (1) the failure is surfaced,
 * (2) the DB is rolled back to the pre-migration schema (no partial tables), and (3) a
 * clean retry migrates to the latest version.
 */

const TMP = `/tmp/carbon-a4-mig-${process.pid}`;

describe("atomic migration repair (A4)", () => {
  test("a failing migration rolls back to the pre-migration snapshot; a clean retry succeeds", () => {
    const dbDir = `${TMP}/t`;
    rmSync(dbDir, { recursive: true, force: true });
    mkdirSync(dbDir, { recursive: true });
    const dbPath = `${dbDir}/carbon.db`;

    // A fresh file DB is at schema version 0 (no tables yet).
    const seed = openDb(dbPath);
    assert.equal(
      getSchemaVersion(seed),
      0,
      "fresh tenant DB starts at schema v0",
    );
    seed.raw.close();

    // Inject a poison migration AFTER the real latest version: it runs last, inside the
    // same single transaction as v1..vN, so its failure must roll the whole batch back.
    const poison: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      up: "this is not sql",
    };
    MIGRATIONS.push(poison);
    try {
      // 1. The failed migration is surfaced (not swallowed) ...
      let threw: unknown = null;
      {
        const db = openDb(dbPath);
        try {
          migrateWithRepair(db, dbPath, (p) => openDb(p));
        } catch (e) {
          threw = e;
        }
      }
      assert.ok(threw instanceof Error, "a failing migration throws");
      assert.match(
        (threw as Error).message,
        /rolled back to the pre-migration snapshot/,
      );

      // 2. ... and the tenant is back at the pre-migration schema: version 0, and the
      //    tables the failed transaction would have created do NOT exist (full rollback).
      const after = openDb(dbPath);
      assert.equal(
        getSchemaVersion(after),
        0,
        "version rolled back to pre-migration (v0)",
      );
      const hasItems = !!after.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
      );
      assert.equal(
        hasItems,
        false,
        "no partial tables survived the failed migration",
      );
      after.raw.close();

      // 3. A clean retry (poison removed) migrates to the latest version + verifies.
      MIGRATIONS.pop();
      const db3 = openDb(dbPath);
      const repaired = migrateWithRepair(db3, dbPath, (p) => openDb(p));
      assert.equal(
        getSchemaVersion(repaired),
        LATEST_SCHEMA_VERSION,
        "retry migrates to latest",
      );
      const report = verifyMigration(repaired, LATEST_SCHEMA_VERSION);
      assert.ok(
        report.ok,
        `post-migration verification passes: ${JSON.stringify(report.errors)}`,
      );
      assert.ok(
        repaired.get(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
        ),
        "the items table exists after a successful migration",
      );
      repaired.raw.close();
    } finally {
      // Never leak the poison migration into other tests (separate process, but be safe).
      if (MIGRATIONS[MIGRATIONS.length - 1] === poison) MIGRATIONS.pop();
    }
  });

  test("steady state (no pending migration) is a fast no-op that returns the same handle", () => {
    const dbDir = `${TMP}/t2`;
    rmSync(dbDir, { recursive: true, force: true });
    mkdirSync(dbDir, { recursive: true });
    const dbPath = `${dbDir}/carbon.db`;
    const db = openDb(dbPath);
    const same = migrateWithRepair(db, dbPath, (p) => openDb(p)); // v0 -> migrates once
    assert.equal(getSchemaVersion(same), LATEST_SCHEMA_VERSION);
    // Second call: already at latest -> fast path, returns the SAME handle, no snapshot dir.
    const again = migrateWithRepair(same, dbPath, (p) => openDb(p));
    assert.equal(again, same, "steady state returns the same handle");
    assert.ok(
      !existsSync(`${dbPath}.snap-${LATEST_SCHEMA_VERSION}-${process.pid}`),
      "no snapshot left behind",
    );
    same.raw.close();
  });
});

test("startup restores durable pending intent even when live DB is latest or a partial restore is corrupt", async () => {
  const { writeFileSync } = await import("node:fs");
  const { recoverPendingMigration } = await import("./migration-repair");
  const { migrate } = await import("@carbon/core");
  const path = `${TMP}/interrupted.db`;
  const seed = openDb(path);
  seed.raw.exec(`VACUUM INTO '${path}.migration-snapshot.db'`);
  writeFileSync(`${path}.migration-pending.json`, JSON.stringify({ from: 0 }));
  migrate(seed); // simulates crash after migration COMMIT but before verification
  seed.raw.close();
  writeFileSync(path, "interrupted restore bytes");
  writeFileSync(`${path}.migration-restore.tmp`, "partial staging copy");
  assert.equal(recoverPendingMigration(path), true);
  const restored = openDb(path);
  assert.equal(getSchemaVersion(restored), 0);
  const ready = migrateWithRepair(restored, path, openDb);
  assert.equal(getSchemaVersion(ready), LATEST_SCHEMA_VERSION);
  ready.raw.close();
  assert.equal(recoverPendingMigration(path), false);
});

test("reset log rebuild and generation bump roll back together on interruption", async () => {
  const { migrate, createItem, rebuildSyncLogFromMaterialization } =
    await import("@carbon/core");
  const {
    ensureFederationTables,
    ensureGovernanceTables,
    getSyncEpoch,
    bumpSyncEpoch,
  } = await import("./federation");
  const db = openDb(":memory:");
  migrate(db);
  ensureFederationTables(db);
  ensureGovernanceTables(db);
  createItem(db, "d", { title: "preserved" });
  const before = db.all("SELECT * FROM ops");
  const epoch = getSyncEpoch(db);
  assert.throws(
    () =>
      rebuildSyncLogFromMaterialization(db, () => {
        bumpSyncEpoch(db);
        throw new Error("interrupted");
      }),
    /interrupted/,
  );
  assert.deepEqual(db.all("SELECT * FROM ops"), before);
  assert.equal(getSyncEpoch(db), epoch);
  rebuildSyncLogFromMaterialization(db, () => {
    bumpSyncEpoch(db);
  });
  assert.equal(getSyncEpoch(db), epoch + 1);
  db.raw.close();
});
