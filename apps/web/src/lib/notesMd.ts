import { createItem, getItem, type Db } from '@carbon/core';

// Single-note Markdown import/export with YAML frontmatter. Frontmatter is a tiny,
// dependency-free subset (flat `key: value` pairs, optionally quoted) — enough for
// the two fields the plan defines: `title` and an optional `parent`. Anything more
// exotic is ignored on import; export only ever emits these two keys.

export interface NoteFrontmatter {
  title?: string;
  /** Optional parent item id the note should be created under. */
  parent?: string;
}

export interface ParsedNoteMd {
  frontmatter: NoteFrontmatter;
  body: string;
}

/** Strip a leading/trailing matched pair of quotes from a scalar value, reversing
 *  `yamlScalar`'s backslash-escaping for a double-quoted value (single-quoted values
 *  are never emitted by this module but are accepted, unescaped, for hand-authored
 *  files). A single left-to-right pass over `\X` pairs avoids re-interpreting an
 *  escaped backslash that happens to be followed by a literal "n" (e.g. `\\` + `name`
 *  round-trips to `\name`, not a stray newline). */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t[0] === '"' && t.at(-1) === '"') {
    return t.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
  }
  if (t.length >= 2 && t[0] === "'" && t.at(-1) === "'") {
    return t.slice(1, -1);
  }
  return t;
}

/** Escape a scalar for YAML output — quote it when it could be misparsed. Newlines
 *  are escaped to a literal `\n` (not left as a real line break) because this
 *  frontmatter parser only understands one `key: value` pair per line; an
 *  unescaped embedded newline would otherwise split into unparseable extra lines. */
function yamlScalar(v: string): string {
  if (v === '' || /[:#"'\n]/.test(v) || /^\s|\s$/.test(v)) {
    return (
      '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
    );
  }
  return v;
}

/** Split a `.md` file into `{ frontmatter, body }`. A file with no frontmatter
 *  block yields empty frontmatter and the whole text as the body. */
export function parseNoteMd(text: string): ParsedNoteMd {
  const normalized = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!m) return { frontmatter: {}, body: normalized };

  const frontmatter: NoteFrontmatter = {};
  for (const line of m[1]!.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = unquote(line.slice(idx + 1));
    if (key === 'title') frontmatter.title = value;
    else if (key === 'parent') frontmatter.parent = value;
  }
  return { frontmatter, body: normalized.slice(m[0].length) };
}

/** Serialize a note to a `.md` string with `title` (+ optional `parent`) frontmatter. */
export function noteToMd(opts: { title: string; parent?: string | null; body: string }): string {
  const lines = ['---', `title: ${yamlScalar(opts.title ?? '')}`];
  if (opts.parent) lines.push(`parent: ${yamlScalar(opts.parent)}`);
  lines.push('---', '');
  return lines.join('\n') + (opts.body ?? '');
}

/** Create a `type:'note'` item from parsed `.md`. The frontmatter `parent` is
 *  honoured only when it names an existing item; otherwise the note is top-level. */
export function importNoteMd(
  db: Db,
  deviceId: string,
  text: string,
  opts: { ownerId?: string | null; parentId?: string | null } = {},
) {
  const { frontmatter, body } = parseNoteMd(text);
  const fmParent = frontmatter.parent && getItem(db, frontmatter.parent) ? frontmatter.parent : null;
  return createItem(db, deviceId, {
    type: 'note',
    title: (frontmatter.title ?? '').trim(),
    note: body.length ? body : null,
    // Preserve explicit frontmatter parent on round-trip imports; use the drop
    // context only when the file doesn't provide a valid parent.
    parentId: fmParent ?? opts.parentId ?? null,
    ownerId: opts.ownerId ?? null,
  });
}

/** Turn a title into a filesystem-safe slug (lowercase, hyphenated, bounded). A
 *  non-Latin title (Cyrillic, CJK, ...) strips down to nothing under the a-z0-9
 *  filter — fall back to an id-derived slug rather than a bare "note", so exporting
 *  several such notes doesn't collapse them all onto the same filename base. */
export function noteSlug(item: { id: string; title: string }): string {
  return (
    (item.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `note-${item.id.slice(0, 8)}`
  );
}

/** Trigger a browser download of a single note as `<slug>.md` with frontmatter. */
export function exportNoteMd(db: Db, id: string): void {
  const item = getItem(db, id);
  if (!item) return;
  const md = noteToMd({ title: item.title, parent: item.parent_id, body: item.note ?? '' });
  const slug = noteSlug(item);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
