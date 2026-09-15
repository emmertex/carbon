import { reviewEntryId } from '@carbon/core';
import { exportDb, openSnapshot, getDb, persist, commitImport } from './db';
import { getBlob, addImportedBlobs } from './blobs';
import { identityKey } from './identity';
import { ingestOps, ingestRecordOps, blobReferenceInventory, buildBackupManifest,
  decodeVerifiedBackup, sha256Hex, getSchemaVersion, LATEST_SCHEMA_VERSION, opShapeError, recordOpShapeError, planId, type Db, type Op, type RecordOp } from '@carbon/core';

/** A backup is complete or fails with the missing/corrupt hashes; no success download with holes. */
export async function exportBackup(): Promise<void> {
  const identity = identityKey();
  await persist();
  const bytes = exportDb();
  const snap = await openSnapshot(bytes);
  try {
    const blobs: { hash: string; bytes: Uint8Array }[] = [];
    const missing: string[] = [];
    for (const hash of blobReferenceInventory(snap).byHash.keys()) {
      if (identityKey() !== identity) throw new Error('Export cancelled: workspace changed.');
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Backup contains an invalid blob reference.');
      const blob = await getBlob(hash, null);
      const content = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
      if (!content || await sha256Hex(content) !== hash) missing.push(hash);
      else blobs.push({ hash, bytes: content });
    }
    if (identityKey() !== identity) throw new Error('Export cancelled: workspace changed.');
    if (missing.length) throw new Error(`Backup incomplete: ${missing.length} missing or corrupt blobs (${missing.slice(0, 3).join(', ')}). Reconnect or recover these files and retry.`);
    const bundle = buildBackupManifest({ db: bytes, blobs, missing: [] });
    bundle.db_checksum = await sha256Hex(bytes);
    if (identityKey() !== identity) throw new Error('Export cancelled: workspace changed.');
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `carbon-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } finally { snap.close(); }
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
  const decoded = await decodeVerifiedBackup(JSON.parse(await file.text()));
  const dbBytes = decoded.db;
  const blobs = decoded.blobs;
  const snap = await openSnapshot(dbBytes);
  try {
    if (getSchemaVersion(snap) !== LATEST_SCHEMA_VERSION) throw new Error('Unsupported database schema in backup.');
    const integrity = snap.all<Record<string, string>>('PRAGMA integrity_check');
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') throw new Error('Corrupt backup database.');
    // Include trash: restored deleted items must retain their files too.
    for (const hash of blobReferenceInventory(snap).byHash.keys()) {
      if (!blobs[hash]) throw new Error(`Backup incomplete: missing blob ${hash}`);
    }
    const users = snap.all<BackupUser>(
      'SELECT id, username, display_name FROM users WHERE deleted = 0 ORDER BY username',
    );
    return { dbBytes, blobs, users };
  } finally { snap.close(); }
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
  const identity = identityKey();
  const snap = await openSnapshot(parsed.dbBytes);
  try {

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
      case 'review_progress':
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
    if (r.entity === 'share') data.id = `s:${data.item_id}:${data.user_id}`;
    if (r.entity === 'assignee') data.id = `a:${data.item_id}:${data.user_id}`;
    if (r.entity === 'review_progress') data.id = reviewEntryId(String(data.user_id), String(data.item_id), String(data.cycle), String(data.entry_key));
    if (r.entity === 'plan') data.id = planId(data.user_id as string | null, data.item_id as string);
    recs.push({
      id: r.id,
      entity: r.entity,
      row_id: typeof data.id === 'string' ? data.id : r.row_id,
      ts: Number(r.ts),
      device_id: r.device_id,
      data,
    });
  }

  // Merge as unsynced so everything re-pushes to the current server.
  for (const op of ops) {
    const error = opShapeError(op);
    if (error) throw new Error(`Invalid imported task: ${error}`);
  }
  for (const op of recs) {
    const error = recordOpShapeError(op);
    if (error) throw new Error(`Invalid imported record: ${error}`);
  }
  const apply = (db: Db) => {
    if (ops.length && ingestOps(db, ops, false).skipped.length) throw new Error('Import rejected: malformed task records.');
    if (recs.length && ingestRecordOps(db, recs, false).skipped.length) throw new Error('Import rejected: malformed related records.');
  };
  // Preflight against a copy before staging any content. The durable commit repeats
  // the merge against the latest state so concurrent-tab edits survive.
  const preview = await openSnapshot(exportDb());
  try { apply(preview); } finally { preview.close(); }

  // Bring attachment blobs along, queued for upload (skip dropped ones' files lazily).
  if (identityKey() !== identity) throw new Error('Import cancelled: workspace changed.');
  await addImportedBlobs(parsed.blobs);
  await commitImport(apply, identity);
  } finally { snap.close(); }
}
