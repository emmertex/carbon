import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  migrate,
  createItem,
  updateItem,
  createTag,
  setItemTags,
  type Db,
  type SqlParams,
} from '@carbon/core';
import { treeToMarkdown } from './exportMarkdown';

// Minimal in-memory Db backed by node:sqlite (mirrors packages/core repo.test.ts).
function openMemoryDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const db: Db = {
    run(sql: string, params: SqlParams = []): void {
      sqlite.prepare(sql).run(...params);
    },
    all<T>(sql: string, params: SqlParams = []): T[] {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: SqlParams = []): T | undefined {
      return sqlite.prepare(sql).get(...params) as T | undefined;
    },
    exec(sql: string): void {
      sqlite.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const result = fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  migrate(db);
  return db;
}

const DEV = 'test-device';

describe('treeToMarkdown()', () => {
  test('nests subtasks and marks each status', () => {
    const db = openMemoryDb();
    const root = createItem(db, DEV, { type: 'project', title: 'Trip' });
    const a = createItem(db, DEV, { type: 'task', title: 'Book flights', parentId: root.id });
    createItem(db, DEV, { type: 'task', title: 'Pick seats', parentId: a.id });
    const c = createItem(db, DEV, { type: 'task', title: 'Renew passport', parentId: root.id });
    updateItem(db, DEV, a.id, { status: 'done', completed_at: new Date().toISOString() });
    updateItem(db, DEV, c.id, { status: 'dropped' });

    assert.equal(
      treeToMarkdown(db, root.id),
      [
        '* [ ] Trip',
        '  * [x] Book flights',
        '    * [ ] Pick seats',
        '  * [/] Renew passport',
      ].join('\n'),
    );
  });

  test('renders tags (including colon paths)', () => {
    const db = openMemoryDb();
    const root = createItem(db, DEV, { type: 'task', title: 'Buy groceries' });
    const fruit = createTag(db, DEV, 'fruit');
    const coles = createTag(db, DEV, 'Shopping:Coles');
    setItemTags(db, DEV, root.id, [fruit.id, coles.id]);

    const md = treeToMarkdown(db, root.id);
    assert.match(md, /^\* \[ \] Buy groceries /);
    assert.match(md, /#fruit/);
    assert.match(md, /#Shopping:Coles/);
  });

  test('emits @due: as yyyyMMdd (all-day) or yyyyMMddHHmm (timed)', () => {
    const db = openMemoryDb();
    const allDay = createItem(db, DEV, {
      type: 'task',
      title: 'All day',
      dueDate: new Date(2026, 5, 28, 23, 59).toISOString(),
    });
    const timed = createItem(db, DEV, {
      type: 'task',
      title: 'Timed',
      dueDate: new Date(2026, 5, 28, 18, 30).toISOString(),
    });
    const none = createItem(db, DEV, { type: 'task', title: 'No due' });

    assert.equal(treeToMarkdown(db, allDay.id), '* [ ] All day @due:20260628');
    assert.equal(treeToMarkdown(db, timed.id), '* [ ] Timed @due:202606281830');
    assert.equal(treeToMarkdown(db, none.id), '* [ ] No due');
  });

  test('skips deleted descendants', () => {
    const db = openMemoryDb();
    const root = createItem(db, DEV, { type: 'project', title: 'P' });
    const keep = createItem(db, DEV, { type: 'task', title: 'Keep', parentId: root.id });
    const gone = createItem(db, DEV, { type: 'task', title: 'Gone', parentId: root.id });
    updateItem(db, DEV, gone.id, { deleted: true });

    assert.equal(treeToMarkdown(db, root.id), ['* [ ] P', '  * [ ] Keep'].join('\n'));
    void keep;
  });

  test('returns empty string for a missing item', () => {
    const db = openMemoryDb();
    assert.equal(treeToMarkdown(db, 'nope'), '');
  });
});
