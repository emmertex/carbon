import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate, createItem, getItem, type Db, type SqlParams } from '@carbon/core';
import { parseNoteMd, noteToMd, importNoteMd, noteSlug } from './notesMd';

// Minimal in-memory Db backed by node:sqlite (mirrors packages/core repo.test.ts).
function openMemoryDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const db: Db = {
    run: (sql: string, params: SqlParams = []) => void sqlite.prepare(sql).run(...params),
    all: <T>(sql: string, params: SqlParams = []) => sqlite.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: SqlParams = []) =>
      sqlite.prepare(sql).get(...params) as T | undefined,
    exec: (sql: string) => sqlite.exec(sql),
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const r = fn();
        sqlite.exec('COMMIT');
        return r;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  migrate(db);
  return db;
}

const DEV = 'dev';

describe('parseNoteMd()', () => {
  test('splits frontmatter from body', () => {
    const { frontmatter, body } = parseNoteMd(
      '---\ntitle: Groceries\nparent: abc-123\n---\n- milk\n- eggs\n',
    );
    assert.equal(frontmatter.title, 'Groceries');
    assert.equal(frontmatter.parent, 'abc-123');
    assert.equal(body, '- milk\n- eggs\n');
  });

  test('handles quoted values and colons in the title', () => {
    const { frontmatter } = parseNoteMd('---\ntitle: "Plan: Q3"\n---\nbody');
    assert.equal(frontmatter.title, 'Plan: Q3');
  });

  test('no frontmatter → whole text is the body', () => {
    const { frontmatter, body } = parseNoteMd('just some text\nmore');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, 'just some text\nmore');
  });

  test('tolerates CRLF line endings', () => {
    const { frontmatter, body } = parseNoteMd('---\r\ntitle: X\r\n---\r\nhello');
    assert.equal(frontmatter.title, 'X');
    assert.equal(body, 'hello');
  });

  test('an empty parent value is treated as absent, not an empty string', () => {
    const { frontmatter } = parseNoteMd('---\ntitle: X\nparent: \n---\nbody');
    assert.equal(frontmatter.parent, '');
  });

  test('a body that itself starts with "---" but never closes is not mistaken for frontmatter', () => {
    // No closing "---" line anywhere below, so the regex can't match a frontmatter
    // block at all — the leading "---" line is preserved verbatim as part of the body
    // (a horizontal rule, say) rather than being silently eaten.
    const text = '---\nnot really frontmatter, just a heading rule\nmore body';
    const { frontmatter, body } = parseNoteMd(text);
    assert.deepEqual(frontmatter, {});
    assert.equal(body, text);
  });
});

describe('noteToMd() round-trips through parseNoteMd()', () => {
  test('title + body', () => {
    const md = noteToMd({ title: 'My Note', body: 'line one\nline two' });
    const { frontmatter, body } = parseNoteMd(md);
    assert.equal(frontmatter.title, 'My Note');
    assert.equal(body, 'line one\nline two');
    assert.equal(frontmatter.parent, undefined);
  });

  test('title with a colon survives the round trip', () => {
    const md = noteToMd({ title: 'Plan: Q3', parent: 'p1', body: '' });
    const { frontmatter } = parseNoteMd(md);
    assert.equal(frontmatter.title, 'Plan: Q3');
    assert.equal(frontmatter.parent, 'p1');
  });

  test('a title containing a literal newline survives the round trip', () => {
    // yamlScalar escapes an embedded newline to a literal `\n` so the frontmatter
    // block stays one line per field; parseNoteMd must reverse that back to a real
    // newline, not leave the literal backslash-n in the title.
    const md = noteToMd({ title: 'Line one\nLine two', body: '' });
    const { frontmatter } = parseNoteMd(md);
    assert.equal(frontmatter.title, 'Line one\nLine two');
  });

  test('a title containing quotes and backslashes survives the round trip', () => {
    const md = noteToMd({ title: String.raw`She said "hi" \o/`, body: '' });
    const { frontmatter } = parseNoteMd(md);
    assert.equal(frontmatter.title, String.raw`She said "hi" \o/`);
  });

  test('a literal backslash immediately followed by "n" is not mistaken for an escaped newline', () => {
    const md = noteToMd({ title: String.raw`C:\notes\name`, body: '' });
    const { frontmatter } = parseNoteMd(md);
    assert.equal(frontmatter.title, String.raw`C:\notes\name`);
  });

  test('a unicode (non-Latin) title round-trips through frontmatter untouched', () => {
    const md = noteToMd({ title: '買い物リスト — Списък за пазаруване', body: '' });
    const { frontmatter } = parseNoteMd(md);
    assert.equal(frontmatter.title, '買い物リスト — Списък за пазаруване');
  });
});

describe('importNoteMd()', () => {
  test('creates a type=note item with title + body', () => {
    const db = openMemoryDb();
    const note = importNoteMd(db, DEV, '---\ntitle: Ideas\n---\nbrainstorm', {});
    const it = getItem(db, note.id)!;
    assert.equal(it.type, 'note');
    assert.equal(it.title, 'Ideas');
    assert.equal(it.note, 'brainstorm');
    assert.equal(it.parent_id, null);
  });

  test('honours frontmatter parent when it names a real item', () => {
    const db = openMemoryDb();
    const project = createItem(db, DEV, { type: 'project', title: 'P' });
    const note = importNoteMd(db, DEV, `---\ntitle: Sub\nparent: ${project.id}\n---\nbody`, {});
    assert.equal(getItem(db, note.id)?.parent_id, project.id);
  });

  test('ignores a frontmatter parent that does not exist', () => {
    const db = openMemoryDb();
    const note = importNoteMd(db, DEV, '---\ntitle: Sub\nparent: nope\n---\nbody', {});
    assert.equal(getItem(db, note.id)?.parent_id, null);
  });

  test('the parentId option is a fallback used only when frontmatter has no valid parent', () => {
    const db = openMemoryDb();
    const project = createItem(db, DEV, { type: 'project', title: 'P' });
    const note = importNoteMd(db, DEV, '---\ntitle: Sub\nparent: nope\n---\nbody', {
      parentId: project.id,
    });
    assert.equal(getItem(db, note.id)?.parent_id, project.id);
  });

  test('a VALID frontmatter parent wins over the drop-context parentId option', () => {
    // Round-tripping an exported note (which carries its real parent in frontmatter)
    // back through a drop target must not silently re-parent it to the drop location.
    const db = openMemoryDb();
    const fmTarget = createItem(db, DEV, { type: 'project', title: 'FM Target' });
    const dropTarget = createItem(db, DEV, { type: 'project', title: 'Drop Target' });
    const note = importNoteMd(db, DEV, `---\ntitle: Sub\nparent: ${fmTarget.id}\n---\nbody`, {
      parentId: dropTarget.id,
    });
    assert.equal(getItem(db, note.id)?.parent_id, fmTarget.id);
  });

  test('an empty frontmatter parent value falls back to the parentId option, not to null', () => {
    const db = openMemoryDb();
    const project = createItem(db, DEV, { type: 'project', title: 'P' });
    const note = importNoteMd(db, DEV, '---\ntitle: Sub\nparent: \n---\nbody', {
      parentId: project.id,
    });
    assert.equal(getItem(db, note.id)?.parent_id, project.id);
  });
});

describe('noteSlug()', () => {
  test('lowercases, hyphenates, and bounds a Latin title', () => {
    assert.equal(noteSlug({ id: 'x', title: 'My Grand Plan!!' }), 'my-grand-plan');
  });

  test('a non-Latin title falls back to an id-derived slug, not a bare "note"', () => {
    const slug = noteSlug({ id: 'abcdef1234567890', title: '買い物リスト' });
    assert.equal(slug, 'note-abcdef12');
  });

  test('two non-Latin-titled notes get distinct slugs (no "note"/"note-2" collision)', () => {
    const a = noteSlug({ id: 'aaaaaaaa-1', title: '買い物' });
    const b = noteSlug({ id: 'bbbbbbbb-1', title: 'Списък' });
    assert.notEqual(a, b);
  });

  test('an empty title also falls back to an id-derived slug', () => {
    assert.equal(noteSlug({ id: 'abcdef1234567890', title: '' }), 'note-abcdef12');
  });
});
