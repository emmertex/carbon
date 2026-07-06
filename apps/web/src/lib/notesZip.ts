import { zipSync, strToU8, type Zippable } from 'fflate';
import { allItems, getItem, type Db, type Item } from '@carbon/core';
import { noteToMd, noteSlug, exportNoteMd } from './notesMd';
import { getBlob } from './blobs';

// Zip export of every `type:'note'` item, laid out per the plan:
//   notes/{slug}.md   — one file per note (YAML frontmatter + body)
//   assets/{hash}     — every blob referenced by an exported body
//   manifest.json     — metadata to identify each note + its referenced assets
//
// Pure builders (buildNotesZip / notesManifest / collectAssetHashes) take the blob
// bytes as an argument so they're testable without a browser/network. `exportNotesZip`
// wires in the real blob store + a DOM download.

/** A note's entry in the manifest. */
export interface NoteManifestEntry {
  /** Item id (uuid) — the stable identity; slugs can collide/change. */
  id: string;
  title: string;
  /** The `notes/{slug}.md` filename chosen for this note (de-duped, unique). */
  slug: string;
  /** Parent item id, or null for a top-level note. Portable identity across export. */
  parent: string | null;
  /** Content hashes of `/api/blobs/{hash}` assets referenced by this note's body. */
  assets: string[];
}

export interface NotesManifest {
  format: 'carbon-notes';
  version: 1;
  exported_at: string;
  notes: NoteManifestEntry[];
}

/** Matches sha-256 hashes as they appear in bodies: `/api/blobs/{64-hex}`. Covers
 *  markdown `![alt](/api/blobs/{hash})` and bare `/api/blobs/{hash}` references.
 *  Case-insensitive: hashes are generated lowercase, but a hand-edited or
 *  differently-sourced reference could be uppercase — normalize on capture so it
 *  isn't silently dropped from the exported `assets/` folder. */
const BLOB_REF = /\/api\/blobs\/([0-9a-fA-F]{64})/g;

/** All distinct blob hashes referenced by a note body. */
export function collectAssetHashes(body: string | null | undefined): string[] {
  if (!body) return [];
  const out = new Set<string>();
  for (const m of body.matchAll(BLOB_REF)) out.add(m[1]!.toLowerCase());
  return [...out];
}

/** Rewrite `/api/blobs/{hash}` references to the relative path the matching asset
 *  will have inside the export — outside the app there's no server (and no auth
 *  header) to resolve `/api/blobs/...` against, so the exported `.md` needs a plain
 *  relative link to the bundled `assets/{hash}` file to actually open. */
function rewriteBlobRefs(body: string, toPath: (hash: string) => string): string {
  return body.replace(BLOB_REF, (_match, hash: string) => toPath(hash.toLowerCase()));
}

/** Assign each note a unique `{slug}.md` filename, de-duping collisions with a
 *  numeric suffix (`slug.md`, `slug-2.md`, …). Deterministic in item order. Uses
 *  `noteSlug` (shared with the single-note .md export), whose id-derived fallback
 *  for non-Latin titles means this dedup loop rarely needs to fire in practice. */
function assignSlugs(notes: Item[]): Map<string, string> {
  const used = new Set<string>();
  const bySlug = new Map<string, string>(); // item id -> unique slug
  for (const n of notes) {
    const base = noteSlug(n);
    let slug = base;
    let i = 2;
    while (used.has(slug)) slug = `${base}-${i++}`;
    used.add(slug);
    bySlug.set(n.id, slug);
  }
  return bySlug;
}

/** Every `type:'note'` item in the DB (excludes tombstoned rows via allItems). */
export function listNotes(db: Db): Item[] {
  return allItems(db).filter((it) => it.type === 'note');
}

/** Build the manifest for a set of notes, using the given slug assignment. */
export function notesManifest(notes: Item[], slugs: Map<string, string>): NotesManifest {
  return {
    format: 'carbon-notes',
    version: 1,
    exported_at: new Date().toISOString(),
    notes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      slug: `${slugs.get(n.id)!}.md`,
      parent: n.parent_id,
      assets: collectAssetHashes(n.note),
    })),
  };
}

export interface NotesFilesResult {
  files: Record<string, Uint8Array>;
  /** Hashes referenced by a note body that `getAsset` couldn't resolve — omitted from
   *  `assets/` but still recorded in the manifest. Surfaced so callers can warn the
   *  user rather than silently claim a complete export. */
  missingAssets: string[];
}

/**
 * Assemble the zip file map from the DB and a blob resolver. Returns the flat
 * path→bytes entry map (also handy for assertions) plus any asset hashes that
 * couldn't be resolved. `getAsset` returns the raw bytes for a hash, or null when
 * the blob is unavailable (missing assets are simply omitted from `files` — the
 * manifest still records the reference). Pure: no DOM, no network of its own.
 */
export async function buildNotesFiles(
  db: Db,
  getAsset: (hash: string) => Promise<Uint8Array | null>,
): Promise<NotesFilesResult> {
  const notes = listNotes(db);
  const slugs = assignSlugs(notes);
  const files: Record<string, Uint8Array> = {};

  // notes/{slug}.md — image refs point at the sibling assets/ folder, one level up
  // from notes/.
  for (const n of notes) {
    const body = rewriteBlobRefs(n.note ?? '', (hash) => `../assets/${hash}`);
    const md = noteToMd({ title: n.title, parent: n.parent_id, body });
    files[`notes/${slugs.get(n.id)!}.md`] = strToU8(md);
  }

  // assets/{hash} — union of every referenced hash across all bodies.
  const hashes = new Set<string>();
  for (const n of notes) for (const h of collectAssetHashes(n.note)) hashes.add(h);
  const missingAssets: string[] = [];
  for (const h of hashes) {
    const bytes = await getAsset(h);
    if (bytes) files[`assets/${h}`] = bytes;
    else missingAssets.push(h);
  }

  // manifest.json
  const manifest = notesManifest(notes, slugs);
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  return { files, missingAssets };
}

/** Zip a path→bytes map with fflate (deterministic, no compression-level surprises). */
export function zipFiles(files: Record<string, Uint8Array>): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, bytes] of Object.entries(files)) zippable[path] = bytes;
  return zipSync(zippable);
}

export interface NotesZipResult {
  bytes: Uint8Array;
  missingAssets: string[];
}

/**
 * Build the notes zip from the DB + blob resolver. Split from the download step so
 * tests can inspect the bytes/layout directly.
 */
export async function buildNotesZip(
  db: Db,
  getAsset: (hash: string) => Promise<Uint8Array | null>,
): Promise<NotesZipResult> {
  const { files, missingAssets } = await buildNotesFiles(db, getAsset);
  return { bytes: zipFiles(files), missingAssets };
}

/** Resolve a blob hash to raw bytes via the local cache (falling back to the server
 *  download that `getBlob` performs). null when the blob can't be found. */
async function assetFromBlobStore(hash: string): Promise<Uint8Array | null> {
  const blob = await getBlob(hash, null);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** Build the notes zip and trigger a browser download of `carbon-notes-<date>.zip`.
 *  Returns the count of referenced assets that couldn't be bundled, so the caller
 *  (DataBackup UI) can warn rather than silently claim a complete export. */
export async function exportNotesZip(db: Db): Promise<{ missingAssetCount: number }> {
  const { bytes, missingAssets } = await buildNotesZip(db, assetFromBlobStore);
  // Copy into a fresh ArrayBuffer-backed view so Blob doesn't retain fflate's buffer.
  const blob = new Blob([bytes.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `carbon-notes-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  return { missingAssetCount: missingAssets.length };
}

/** Export a single note: a plain `.md` download (via `exportNoteMd`) when its body
 *  references no image blobs, or a `{slug}.zip` (the `.md` plus every referenced
 *  `assets/{hash}`) when it does — an image-only `.md` would just be a broken link
 *  once separated from the blob store. Returns null if the item doesn't exist. */
export async function exportSingleNote(
  db: Db,
  id: string,
): Promise<{ missingAssetCount: number } | null> {
  const item = getItem(db, id);
  if (!item) return null;

  const hashes = collectAssetHashes(item.note);
  if (!hashes.length) {
    exportNoteMd(db, id);
    return { missingAssetCount: 0 };
  }

  const slug = noteSlug(item);
  // Image refs point at the sibling assets/ folder — the .md sits at the zip root
  // here, unlike the bulk export's notes/ subfolder.
  const body = rewriteBlobRefs(item.note ?? '', (hash) => `assets/${hash}`);
  const md = noteToMd({ title: item.title, parent: item.parent_id, body });
  const files: Record<string, Uint8Array> = { [`${slug}.md`]: strToU8(md) };
  const missingAssets: string[] = [];
  for (const h of hashes) {
    const bytes = await assetFromBlobStore(h);
    if (bytes) files[`assets/${h}`] = bytes;
    else missingAssets.push(h);
  }

  const bytes = zipFiles(files);
  const blob = new Blob([bytes.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  return { missingAssetCount: missingAssets.length };
}
