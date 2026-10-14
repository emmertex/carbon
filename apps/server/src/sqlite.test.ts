import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { openDb, stmtCacheSize } from './sqlite';

describe('openDb', () => {
  test('opens an in-memory database and runs basic operations', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    db.run('INSERT INTO test (name) VALUES (?)', ['Alice']);
    const row = db.get<{ name: string }>('SELECT * FROM test WHERE name = ?', ['Alice']);
    assert.equal(row!.name, 'Alice');
  });

  test('all() returns multiple rows', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    db.run('INSERT INTO test (name) VALUES (?)', ['Alice']);
    db.run('INSERT INTO test (name) VALUES (?)', ['Bob']);
    const rows = db.all<{ name: string }>('SELECT name FROM test ORDER BY id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.name, 'Alice');
    assert.equal(rows[1]!.name, 'Bob');
  });

  test('get() returns undefined for missing row', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    const row = db.get('SELECT * FROM test WHERE id = 999');
    assert.equal(row, undefined);
  });

  test('transaction() commits on success', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    db.transaction(() => {
      db.run('INSERT INTO test (name) VALUES (?)', ['A']);
      db.run('INSERT INTO test (name) VALUES (?)', ['B']);
    });
    assert.equal(db.all('SELECT * FROM test').length, 2);
  });

  test('transaction() rolls back on error', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    assert.throws(() => {
      db.transaction(() => {
        db.run('INSERT INTO test (name) VALUES (?)', ['A']);
        throw new Error('fail');
      });
    });
    assert.equal(db.all('SELECT * FROM test').length, 0);
  });

  test('run() accepts no params', () => {
    const db = openDb(':memory:');
    db.run('CREATE TABLE test2 (x INTEGER)');
  });

  test('all() accepts no params', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE test3 (x INTEGER PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO test3 VALUES (1, ?)', ['a']);
    const rows = db.all<{ v: string }>('SELECT v FROM test3');
    assert.equal(rows[0]!.v, 'a');
  });
});

describe('openDb prepared-statement cache', () => {
  test('is bounded (LRU) and cleared on close', () => {
    const db = openDb(':memory:', { stmtCacheMax: 2 });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.get('SELECT 1');
    db.get('SELECT 2');
    db.get('SELECT 1'); // hit: same statement reused
    assert.equal(stmtCacheSize(db.raw), 2);
    db.get('SELECT 3'); // evicts the LRU entry
    assert.equal(stmtCacheSize(db.raw), 2);
    db.run('INSERT INTO t (id) VALUES (?)', [1]);
    db.run('INSERT INTO t (id) VALUES (?)', [2]); // reused statement, new params
    assert.equal(db.all('SELECT id FROM t').length, 2);
    db.raw.close();
    assert.equal(stmtCacheSize(db.raw), 0);
  });
});
