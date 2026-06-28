import { exportDb, openSnapshot, getDb, persist } from './db';
import { exportBlobs, replaceBlobs, addImportedBlobs } from './blobs';
import { ingestOps, ingestRecordOps, type Op, type RecordOp } from '@carbon/core';

// A full local backup: the SQLite database plus every cached attachment blob,
// base64-encoded into a single JSON file. Self-contained — no server required.

const FORMAT = 'carbon-backup';
const VERSION = 1;

interface Bundle {
  format: typeof FORMAT;
  version: number;
  exported_at: string;
  db: string; // base64 SQLite bytes
  blobs: Record<string, string>; // hash -> base64 bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build the backup bundle and trigger a download. */
export async function exportBackup(): Promise<void> {
  await persist();
  const blobBufs = await exportBlobs();
  const blobs: Record<string, string> = {};
  for (const [hash, buf] of Object.entries(blobBufs)) {
    blobs[hash] = bytesToBase64(new Uint8Array(buf));
  }
  const bundle: Bundle = {
    format: FORMAT,
    version: VERSION,
    exported_at: new Date().toISOString(),
    db: bytesToBase64(exportDb()),
    blobs,
  };
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `carbon-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ----- smart import (user-remapping merge) ---------------------------------

export interface BackupUser {
  id: string;
  username: string;
  display_name: string | null;
}

export interface ParsedBackup {
  dbBytes: Uint8Array;
  blobs: Record<string, ArrayBuffer>;
  users: BackupUser[];
}

/** Per backup-user choice: fold into an existing account user, drop their data,
 *  or (placeholder) keep them as a federated identity. */
export type UserChoice =
  | { action: 'map'; targetId: string }
  | { action: 'drop' }
  | { action: 'federation'; address: string };

export type UserMapping = Record<string, UserChoice>;

/** Parse + validate a backup and list the users it contains, WITHOUT applying it. */
export async function inspectBackup(file: File): Promise<ParsedBackup> {
  const bundle = JSON.parse(await file.text()) as Partial<Bundle>;
  if (bundle.format !== FORMAT || typeof bundle.db !== 'string') {
    throw new Error('Not a Carbon backup file.');
  }
  const dbBytes = base64ToBytes(bundle.db);
  const blobs: Record<string, ArrayBuffer> = {};
  for (const [hash, b64] of Object.entries(bundle.blobs ?? {})) {
    blobs[hash] = base64ToBytes(b64).buffer as ArrayBuffer;
  }
  const snap = await openSnapshot(dbBytes);
  const users = snap.all<BackupUser>(
    'SELECT id, username, display_name FROM users WHERE deleted = 0 ORDER BY username',
  );
  return { dbBytes, blobs, users };
}

/** Item ids in the snapshot owned by any dropped user, plus their descendants. */
function droppedItems(snap: ReturnType<typeof getDb>, droppedUserIds: Set<string>): Set<string> {
  const dropped = new Set<string>();
  if (!droppedUserIds.size) return dropped;
  const owned = snap.all<{ id: string }>('SELECT id FROM items WHERE owner_id IN (' +
    [...droppedUserIds].map(() => '?').join(',') + ')', [...droppedUserIds]);
  const queue = owned.map((r) => r.id);
  queue.forEach((id) => dropped.add(id));
  while (queue.length) {
    const parent = queue.shift()!;
    for (const k of snap.all<{ id: string }>('SELECT id FROM items WHERE parent_id = ?', [parent])) {
      if (!dropped.has(k.id)) {
        dropped.add(k.id);
        queue.push(k.id);
      }
    }
  }
  return dropped;
}

/**
 * Merge a parsed backup into the current account, remapping each backup user per
 * `mapping`. Items/records owned by dropped users are skipped; all surviving ops
 * are ingested as UNSYNCED so they push to the current server. Non-destructive:
 * the account's existing data is kept (CRDT merge by op id).
 */
export async function applyImport(parsed: ParsedBackup, mapping: UserMapping): Promise<void> {
  const snap = await openSnapshot(parsed.dbBytes);
  const db = getDb();

  const droppedUserIds = new Set(
    Object.entries(mapping)
      .filter(([, c]) => c.action === 'drop')
      .map(([id]) => id),
  );
  const dropItems = droppedItems(snap, droppedUserIds);

  // Resolve a backup user id to its target id here, or null if its data is dropped.
  // Unmapped ids (e.g. null owner, or a federated identity kept as-is) pass through.
  function resolve(oldId: string | null | undefined): string | null | undefined {
    if (oldId == null) return oldId;
    const choice = mapping[oldId];
    if (!choice) return oldId;
    if (choice.action === 'map') return choice.targetId;
    if (choice.action === 'drop') return null;
    return oldId; // federation placeholder: keep the original identity
  }

  // ----- item ops --------------------------------------------------------
  const ops: Op[] = [];
  for (const r of snap.all<{ id: string; item_id: string; ts: number; device_id: string; fields: string }>(
    'SELECT id, item_id, ts, device_id, fields FROM ops ORDER BY ts',
  )) {
    if (dropItems.has(r.item_id)) continue;
    const fields = JSON.parse(r.fields) as Record<string, unknown>;
    if ('owner_id' in fields) fields.owner_id = resolve(fields.owner_id as string | null);
    ops.push({ id: r.id, item_id: r.item_id, ts: Number(r.ts), device_id: r.device_id, fields });
  }

  // ----- record ops (shares, assignees, comments, attachments, timelogs, …) --
  const recs: RecordOp[] = [];
  for (const r of snap.all<{
    id: string;
    entity: string;
    row_id: string;
    ts: number;
    device_id: string;
    data: string;
  }>('SELECT id, entity, row_id, ts, device_id, data FROM record_ops ORDER BY ts')) {
    if (r.entity === 'user') continue; // identities come from the current account
    const data = JSON.parse(r.data) as Record<string, unknown>;
    if (typeof data.item_id === 'string' && dropItems.has(data.item_id)) continue;

    // Remap the entity's primary user reference; drop the record if that user was dropped.
    let skip = false;
    const remapUser = (key: string, dropIfGone: boolean) => {
      if (!(key in data)) return;
      const mapped = resolve(data[key] as string | null);
      if (mapped === null && dropIfGone && data[key] != null) skip = true;
      else data[key] = mapped;
    };
    switch (r.entity) {
      case 'share':
      case 'assignee':
      case 'timelog':
      case 'plan':
        remapUser('user_id', true);
        break;
      case 'comment':
        remapUser('author_id', true); // drop a dropped user's comment
        if (Array.isArray(data.mentions)) {
          data.mentions = (data.mentions as (string | null)[])
            .map((m) => resolve(m))
            .filter((m): m is string => typeof m === 'string');
        }
        break;
      case 'attachment':
        remapUser('created_by', false); // keep the file; just blank a dropped uploader
        break;
      // tag / item_tag: no user references
    }
    if (skip) continue;
    recs.push({
      id: r.id,
      entity: r.entity,
      row_id: r.row_id,
      ts: Number(r.ts),
      device_id: r.device_id,
      data,
    });
  }

  // Merge as unsynced so everything re-pushes to the current server.
  if (ops.length) ingestOps(db, ops, false);
  if (recs.length) ingestRecordOps(db, recs, false);

  // Bring attachment blobs along, queued for upload (skip dropped ones' files lazily).
  await addImportedBlobs(parsed.blobs);
  await persist();
}

/**
 * Legacy whole-snapshot restore (REPLACES all local data). Kept for callers that
 * want a verbatim device restore rather than a user-remapped merge.
 */
export async function importBackup(file: File): Promise<void> {
  const parsed = await inspectBackup(file);
  const { importDb } = await import('./db');
  await importDb(parsed.dbBytes);
  await replaceBlobs(parsed.blobs);
}
