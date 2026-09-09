/**
 * A5 — the shared `carbon-backup` manifest (export + import + server backup).
 *
 * Centralized here so the web export, the server delete/export bundle, and the
 * importer all speak one format. Platform-agnostic: hashing goes through
 * `globalThis.crypto.subtle` (Web Crypto — present in the browser and in Node
 * 19+) and base64 through the `atob`/`btoa` globals (browser + Node 16+), so
 * this runs unchanged in web and server.
 *
 * A complete export fetches and verifies EVERY referenced blob; a blob that
 * cannot be fetched/verified is recorded in `missing` and the manifest is marked
 * `complete: false` — never silently shipped with a hole. Import is staged:
 * validate the manifest (version / well-formed / reserved keys / unsafe paths),
 * then verify each blob's checksum, and only then activate — on any failure
 * nothing partial is applied.
 */

export const BACKUP_FORMAT = 'carbon-backup';
export const BACKUP_VERSION = 2;
/** Versions an importer accepts. v1 (pre-manifest) stays importable. */
export const SUPPORTED_BACKUP_VERSIONS: readonly number[] = [1, 2];

/** Client blob-store bookkeeping keys that must never ship as blob content. */
const RESERVED_KEYS = new Set(['blobMeta', 'pendingBlobs']);

const HEX64 = /^[a-f0-9]{64}$/;

/** One referenced blob in the manifest. The `hash` is the sha-256 of the
 *  content; `checksum` is the sha-256 of the BYTES AS SHIPPED and must equal
 *  `hash` (content addressing). A mismatch is a rejected blob, never silently
 *  accepted. */
export interface ManifestBlob {
  hash: string;
  /** Declared byte length of the shipped content. */
  size: number;
  /** sha-256 (lowercase hex) of the shipped bytes; equals `hash` when verified. */
  checksum: string;
  /** base64 of the bytes. */
  b64: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  exported_at: string;
  /** True only when every referenced blob was fetched AND verified. */
  complete: boolean;
  /** base64 SQLite bytes. */
  db: string;
  db_checksum?: string;
  /** Verified content (one entry per shipped blob, keyed by hash in practice). */
  blobs: ManifestBlob[];
  /** Referenced blobs that could NOT be fetched/verified. Non-empty ⇒ incomplete. */
  missing: string[];
}

// ----- base64 (chunked to avoid a stack overflow on a huge fromCharCode) ------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ----- hashing (Web Crypto: browser + Node 19+) -------------------------------

/** sha-256 of `bytes` as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (
    globalThis as unknown as {
      crypto: { subtle: { digest: (alg: string, data: Uint8Array) => Promise<ArrayBuffer> } };
    }
  ).crypto.subtle;
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** True when a string is unsafe to use as a path: a null byte, an absolute path
 *  (POSIX leading `/` or a Windows drive), or a `..` traversal segment. Legit
 *  values (hashes, base64, ISO dates) never trip this. */
export function hasUnsafePath(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (s.includes('\0')) return true;
  if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (s.split(/[/\\]/).includes('..')) return true;
  return false;
}

/** Verify one manifest blob: the shipped bytes' sha-256 must equal BOTH its
 *  `hash` and its `checksum`, and the byte length must equal `size`. */
export async function verifyManifestBlob(b: ManifestBlob): Promise<boolean> {
  if (!HEX64.test(b.hash) || !HEX64.test(b.checksum)) return false;
  const bytes = base64ToBytes(b.b64);
  if (bytes.length !== b.size) return false;
  const actual = await sha256Hex(bytes);
  return actual === b.hash && actual === b.checksum;
}

// ----- stage-1 validation (import) --------------------------------------------

/** Validate a parsed manifest (structure, version, reserved keys, unsafe paths).
 *  Throws on any problem — the caller must then activate nothing. */
export function validateManifest(m: unknown): BackupManifest {
  if (typeof m !== 'object' || m === null) throw new Error('Not a Carbon backup.');
  const man = m as Partial<BackupManifest>;
  if (man.format !== BACKUP_FORMAT) throw new Error('Not a Carbon backup file.');
  if (typeof man.version !== 'number' || !SUPPORTED_BACKUP_VERSIONS.includes(man.version)) {
    throw new Error(`Unsupported backup version: ${String(man.version)}`);
  }
  if (typeof man.db !== 'string' || man.db.length === 0) {
    throw new Error('Backup is missing its database.');
  }
  let rawBlobs: ManifestBlob[];
  if (man.version === 1 && man.blobs && !Array.isArray(man.blobs) && typeof man.blobs === 'object') {
    rawBlobs = Object.entries(man.blobs).map(([hash, b64]) => {
      if (typeof b64 !== 'string') throw new Error('Malformed legacy blob.');
      return { hash, b64, checksum: hash, size: base64ToBytes(b64).length };
    });
  } else if (Array.isArray(man.blobs)) rawBlobs = man.blobs;
  else throw new Error('Backup is missing its blob inventory.');
  const seen = new Set<string>();
  const blobs: ManifestBlob[] = [];
  for (const rec of rawBlobs) {
    if (typeof rec !== 'object' || rec === null) throw new Error('Malformed blob record.');
    const b = rec as ManifestBlob;
    if (typeof b.hash !== 'string' || !HEX64.test(b.hash)) {
      throw new Error(`Invalid or reserved blob key: ${String(b.hash)}`);
    }
    if (RESERVED_KEYS.has(b.hash)) throw new Error(`Reserved key: ${b.hash}`);
    if (!Number.isSafeInteger(b.size) || b.size < 0) {
      throw new Error('Malformed blob record (size).');
    }
    if (typeof b.checksum !== 'string' || !HEX64.test(b.checksum)) {
      throw new Error('Malformed blob record (checksum).');
    }
    if (typeof b.b64 !== 'string') throw new Error('Malformed blob record (b64).');
    if (seen.has(b.hash)) throw new Error(`Duplicate blob: ${b.hash}`);
    seen.add(b.hash);
    // Any path-shaped string the record carries (a slug/filename in a future
    // revision) must be safe — reject traversal / absolute / null bytes.
    for (const [key, v] of Object.entries(rec as unknown as Record<string, unknown>)) {
      if (key !== 'b64' && typeof v === 'string' && hasUnsafePath(v)) {
        throw new Error(`Unsafe path in blob record: ${v}`);
      }
    }
    blobs.push(b);
  }
  const missing = Array.isArray(man.missing)
    ? man.missing.filter((h): h is string => typeof h === 'string')
    : [];
  return {
    format: BACKUP_FORMAT,
    version: man.version,
    exported_at: typeof man.exported_at === 'string' ? man.exported_at : new Date().toISOString(),
    // Trust the exporter's flag, but never let a non-empty missing list claim
    // completeness (a tampered manifest can't hide a hole).
    complete: man.complete === true && missing.length === 0,
    db: man.db,
    db_checksum: man.db_checksum,
    blobs,
    missing,
  };
}

/** Parse + validate a backup file's text (import stage 1). */
export function parseBackupManifest(text: string): BackupManifest {
  return validateManifest(JSON.parse(text));
}

// ----- building (export) ------------------------------------------------------

/** Assemble a manifest from verified blobs + the unfetchable list. `complete` is
 *  true iff `missing` is empty. */
export function buildBackupManifest(opts: {
  db: Uint8Array;
  blobs: { hash: string; bytes: Uint8Array }[];
  missing: string[];
}): BackupManifest {
  const blobs: ManifestBlob[] = opts.blobs.map((b) => ({
    hash: b.hash,
    size: b.bytes.length,
    // Content addressing: the verified bytes hash to the name, so checksum == hash.
    checksum: b.hash,
    b64: bytesToBase64(b.bytes),
  }));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    complete: opts.missing.length === 0,
    db: bytesToBase64(opts.db),
    blobs,
    missing: [...new Set(opts.missing)],
  };
}

/** Verify all shipped bytes before a caller opens the database or activates content. */
export async function decodeVerifiedBackup(value: unknown): Promise<{
  manifest: BackupManifest; db: Uint8Array; blobs: Record<string, ArrayBuffer>;
}> {
  const manifest = validateManifest(value);
  if (manifest.version === 2 && (!manifest.complete || manifest.missing.length))
    throw new Error('Incomplete backup: restore the missing content before importing.');
  const db = base64ToBytes(manifest.db);
  if (manifest.version === 2 && (!manifest.db_checksum || await sha256Hex(db) !== manifest.db_checksum))
    throw new Error('Backup database checksum mismatch.');
  const blobs: Record<string, ArrayBuffer> = Object.create(null);
  for (const blob of manifest.blobs) {
    if (!await verifyManifestBlob(blob)) throw new Error(`Corrupt backup blob: ${blob.hash}`);
    blobs[blob.hash] = base64ToBytes(blob.b64).buffer as ArrayBuffer;
  }
  return { manifest, db, blobs };
}
