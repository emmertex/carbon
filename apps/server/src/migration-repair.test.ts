import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateWithRepair } from './migration-repair';
import { openDb } from './sqlite';
import { migrate, getSchemaVersion, LATEST_SCHEMA_VERSION } from '@carbon/core';

describe('migrateWithRepair', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'carbon-migration-repair-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('fast path: no migration needed returns original db', () => {
    const db = openDb(dbPath);
    migrate(db); // migrate first so it's up to date
    const result = migrateWithRepair(db, dbPath, (p) => openDb(p));
    assert.equal(result, db);
  });

  test('runs migration on stale db', () => {
    // Create a db with older schema
    const db = openDb(dbPath);
    // Don't migrate yet
    const from = getSchemaVersion(db);
    assert.ok(from < LATEST_SCHEMA_VERSION, 'db should be stale');

    const result = migrateWithRepair(db, dbPath, (p) => openDb(p));
    // Migration ran and succeeded
    const after = getSchemaVersion(result);
    assert.equal(after, LATEST_SCHEMA_VERSION);
  });
});
