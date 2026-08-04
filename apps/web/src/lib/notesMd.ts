import { createItem, getItem, type Db } from '@carbon/core';
import { readNoteMeta, type NoteMeta } from './noteMeta';
import type { NoteMode, UnitMode } from './recipe';

// Single-note Markdown import/export with YAML frontmatter. Frontmatter is a tiny,
// dependency-free subset (flat `key: value` pairs, optionally quoted) — enough for
// `title`, an optional `parent`, and the note-mode/recipe settings that otherwise
// live in `items.metadata` (a recipe exported as .md must come back as a recipe,
// not as a plain note that has forgotten its servings). Anything more exotic is
// ignored on import; export only ever emits these keys.

export interface NoteFrontmatter {
  title?: string;
  /** Optional parent item id the note should be created under. */
  parent?: string;
  /** Note mode; absent means the note has no explicit mode (i.e. plain notes). */
  mode?: NoteMode;
  /** Recipe target servings — the scaling factor's numerator. */
  servings?: number;
  /** Recipe unit-conversion mode. */
  units?: UnitMode;
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

// A `.md` file is hand-editable, so the three metadata keys are validated against
// the recipe engine's own unions on the way in AND on the way out — an unrecognised
// value is dropped, never stored, so a typo can't produce a note the app can't
// render (and can't be written back out into the next export either).

function asNoteMode(v: unknown): NoteMode | undefined {
  return v === 'notes' || v === 'recipe' ? v : undefined;
}

function asUnitMode(v: unknown): UnitMode | undefined {
  return v === 'original' || v === 'mlCups' || v === 'mlAll' ? v : undefined;
}

/** Servings must be a finite positive count; `0`, `-3`, `abc`, `Infinity` and a
 *  missing value all drop out. Accepts the frontmatter string or a stored number. */
function asServings(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
    else if (key === 'mode') {
      const mode = asNoteMode(value);
      if (mode) frontmatter.mode = mode;
    } else if (key === 'servings') {
      const servings = asServings(value);
      if (servings !== undefined) frontmatter.servings = servings;
    } else if (key === 'units') {
      const units = asUnitMode(value);
      if (units) frontmatter.units = units;
    }
  }
  return { frontmatter, body: normalized.slice(m[0].length) };
}

/** Serialize a note to a `.md` string with `title` (+ optional `parent`) frontmatter,
 *  plus `mode`/`servings`/`units` for whichever of those the item's `meta` carries —
 *  a plain note still emits the original two keys and nothing else. */
export function noteToMd(opts: {
  title: string;
  parent?: string | null;
  body: string;
  /** The item's decoded metadata, from `readNoteMeta`. */
  meta?: NoteMeta | null;
}): string {
  const lines = ['---', `title: ${yamlScalar(opts.title ?? '')}`];
  if (opts.parent) lines.push(`parent: ${yamlScalar(opts.parent)}`);
  const mode = asNoteMode(opts.meta?.noteMode);
  if (mode) lines.push(`mode: ${mode}`);
  const servings = asServings(opts.meta?.recipe?.servings);
  if (servings !== undefined) lines.push(`servings: ${servings}`);
  const units = asUnitMode(opts.meta?.recipe?.units);
  if (units) lines.push(`units: ${units}`);
  lines.push('---', '');
  return lines.join('\n') + (opts.body ?? '');
}

/** The metadata JSON a note's frontmatter implies, or null when it carries none of
 *  the three keys — an ordinary note must import with `metadata: null` rather than
 *  an empty object. Shape matches what `readNoteMeta` reads back. */
function frontmatterMeta(fm: NoteFrontmatter): Record<string, unknown> | null {
  const recipe: Record<string, unknown> = {};
  if (fm.servings !== undefined) recipe.servings = fm.servings;
  if (fm.units) recipe.units = fm.units;
  const meta: Record<string, unknown> = {};
  if (fm.mode) meta.noteMode = fm.mode;
  if (Object.keys(recipe).length) meta.recipe = recipe;
  return Object.keys(meta).length ? meta : null;
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
    metadata: frontmatterMeta(frontmatter),
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
  const md = noteToMd({
    title: item.title,
    parent: item.parent_id,
    body: item.note ?? '',
    meta: readNoteMeta(item),
  });
  const slug = noteSlug(item);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
