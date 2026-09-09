import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryDb } from './test-helpers';

test('openMemoryDb: creates a migrated in-memory database', () => {
  const db = openMemoryDb();
  // Schema should be applied
  const row = db.get<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  );
  assert.ok(row, 'schema_version row should exist after migration');
});

test('openMemoryDb: transactions commit', () => {
  const db = openMemoryDb();
  db.transaction(() => {
    db.run("INSERT INTO meta (key, value) VALUES ('test', 'committed')");
  });
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'test'");
  assert.equal(row?.value, 'committed');
});

test('openMemoryDb: transactions roll back on throw', () => {
  const db = openMemoryDb();
  try {
    db.transaction(() => {
      db.run("INSERT INTO meta (key, value) VALUES ('test', 'rolled')");
      throw new Error('fail');
    });
  } catch {
    // expected
  }
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'test'");
  assert.equal(row, undefined);
});

test('openMemoryDb: all() returns array', () => {
  const db = openMemoryDb();
  const rows = db.all("SELECT * FROM meta");
  assert.ok(Array.isArray(rows));
});

test('openMemoryDb: run() executes without return', () => {
  const db = openMemoryDb();
  const result = db.run("INSERT INTO meta (key, value) VALUES ('x', 'y')");
  assert.equal(result, undefined);
});

test('openMemoryDb: get() returns undefined for missing row', () => {
  const db = openMemoryDb();
  const row = db.get("SELECT * FROM meta WHERE key = 'nonexistent'");
  assert.equal(row, undefined);
});
