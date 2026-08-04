// Sync-epoch log rebuild + setting record_op compaction.
//
// Tier 1 (compactSettingRecordOps): prune LWW-loser `setting` record_ops without
// breaking rowid cursors (same MAX(rowid) guard as note compaction).
//
// Tier 2 (rebuildSyncLogFromMaterialization): replace ops/record_ops with a
// bootstrap log derived from current materialized tables. Callers bump
// workspace sync_epoch afterward — this alone breaks incremental sync.

import { v4 as uuidv4 } from 'uuid';
import type { Db } from './db';
import type { Item, ItemPatch, Op, User } from './types';
import { createPatch, nextTs, insertOp } from './crdt';
import { insertRecordOp, type RecordOp } from './records';

const EPOCH_DEVICE = 'epoch-reset';

function wins(opTs: number, opDev: string, cur: { ts: number; dev: string }): boolean {
  if (opTs !== cur.ts) return opTs > cur.ts;
  return opDev > cur.dev;
}

export interface CompactSettingOptions {
  /** Only prune ops already pushed (synced=1). Clients MUST set this true. */
  syncedOnly?: boolean;
}

/**
 * Prune superseded `setting` record_ops. Keeps the LWW winner per (row_id, user_id).
 * Never deletes the row holding MAX(rowid) of `record_ops` (rowid-reuse guard).
 */
export function compactSettingRecordOps(db: Db, opts: CompactSettingOptions = {}): number {
  const syncedOnly = opts.syncedOnly ?? false;
  const maxRowid =
    db.get<{ m: number | null }>('SELECT MAX(rowid) AS m FROM record_ops')?.m ?? 0;
  interface Row {
    rowid: number;
    id: string;
    row_id: string;
    ts: number;
    device_id: string;
    data: string;
    synced: number;
  }
  const rows = db.all<Row>(
    `SELECT rowid, id, row_id, ts, device_id, data, synced
     FROM record_ops WHERE entity = 'setting' ORDER BY row_id, ts`,
  );

  // Key: `${row_id}\0${user_id}` — settings are per-user scopes.
  const winners = new Map<string, { ts: number; dev: string; id: string; rowid: number }>();
  const candidates: { id: string; rowid: number }[] = [];

  for (const r of rows) {
    if (syncedOnly && r.synced !== 1) continue;
    let userId = '';
    try {
      const data = JSON.parse(r.data) as { user_id?: string };
      userId = data.user_id ?? '';
    } catch {
      continue;
    }
    const key = `${r.row_id}\0${userId}`;
    const cur = winners.get(key);
    if (!cur) {
      winners.set(key, { ts: r.ts, dev: r.device_id, id: r.id, rowid: r.rowid });
    } else if (wins(r.ts, r.device_id, { ts: cur.ts, dev: cur.dev })) {
      candidates.push({ id: cur.id, rowid: cur.rowid });
      winners.set(key, { ts: r.ts, dev: r.device_id, id: r.id, rowid: r.rowid });
    } else {
      candidates.push({ id: r.id, rowid: r.rowid });
    }
  }

  const toDelete = candidates.filter((c) => c.rowid < maxRowid).map((c) => c.id);
  if (toDelete.length === 0) return 0;
  const BATCH = 500;
  db.transaction(() => {
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const chunk = toDelete.slice(i, i + BATCH);
      const ph = chunk.map(() => '?').join(',');
      db.run(`DELETE FROM record_ops WHERE id IN (${ph})`, chunk);
    }
  });
  return toDelete.length;
}

export interface RebuildSyncLogResult {
  opCount: number;
  recordOpCount: number;
}

/** Collect LWW-winning `setting` ops from the existing log (before truncate). */
function collectSettingWinners(db: Db): RecordOp[] {
  interface Row {
    id: string;
    row_id: string;
    ts: number;
    device_id: string;
    data: string;
  }
  const rows = db.all<Row>(
    `SELECT id, row_id, ts, device_id, data FROM record_ops WHERE entity = 'setting' ORDER BY ts`,
  );
  const winners = new Map<string, RecordOp>();
  for (const r of rows) {
    let userId = '';
    let data: unknown = {};
    try {
      data = JSON.parse(r.data);
      userId = (data as { user_id?: string }).user_id ?? '';
    } catch {
      continue;
    }
    const key = `${r.row_id}\0${userId}`;
    const cur = winners.get(key);
    const next: RecordOp = {
      id: r.id,
      entity: 'setting',
      row_id: r.row_id,
      ts: Number(r.ts),
      device_id: r.device_id,
      data,
    };
    if (!cur || wins(next.ts, next.device_id, { ts: cur.ts, dev: cur.device_id })) {
      winners.set(key, next);
    }
  }
  return [...winners.values()];
}

function bool(n: number | null | undefined): boolean {
  return !!n;
}

/**
 * Replace `ops` and `record_ops` with a bootstrap log from materialized tables.
 * Leaves items / entity tables unchanged. Emits fresh op ids; uses device_id
 * `epoch-reset`. Setting winners are preserved from the old log (no materialization).
 */
export function rebuildSyncLogFromMaterialization(db: Db): RebuildSyncLogResult {
  const settings = collectSettingWinners(db);

  // Include deleted rows so a wipe+re-pull client converges with server materialization
  // (Recently Deleted / tombstones).
  const items = db
    .all<{
      id: string;
      parent_id: string | null;
      type: string;
      owner_id: string | null;
      title: string;
      note: string | null;
      status: string;
      flagged: number;
      priority: number;
      defer_date: string | null;
      due_date: string | null;
      reminder_at: string | null;
      estimate_minutes: number | null;
      completed_at: string | null;
      review_interval: number | null;
      reviewed_at: string | null;
      recurrence: string | null;
      geo: string | null;
      color: string | null;
      notes_project: number;
      thumb: string | null;
      folder_id: string | null;
      sort_order: number;
      order_mode: string;
      sys_kind: string | null;
      metadata: string | null;
      created_at: string;
      updated_at: string;
      deleted: number;
    }>('SELECT * FROM items')
    .map(
      (r): Item => ({
        id: r.id,
        parent_id: r.parent_id,
        type: r.type as Item['type'],
        owner_id: r.owner_id,
        title: r.title,
        note: r.note,
        status: r.status as Item['status'],
        flagged: bool(r.flagged),
        priority: r.priority,
        defer_date: r.defer_date,
        due_date: r.due_date,
        reminder_at: r.reminder_at,
        estimate_minutes: r.estimate_minutes,
        completed_at: r.completed_at,
        review_interval: r.review_interval,
        reviewed_at: r.reviewed_at,
        recurrence: r.recurrence,
        geo: r.geo,
        color: r.color,
        notes_project: bool(r.notes_project),
        thumb: r.thumb,
        folder_id: r.folder_id,
        sort_order: r.sort_order,
        order_mode: (r.order_mode as Item['order_mode']) || 'parallel',
        sys_kind: r.sys_kind,
        metadata: r.metadata,
        created_at: r.created_at,
        updated_at: r.updated_at,
        deleted: bool(r.deleted),
      }),
    );

  // Prefer live non-deleted users for roster bootstrap; soft-deleted users still
  // needed if referenced — include all.
  const users = db
    .all<{
      id: string;
      username: string;
      display_name: string | null;
      role: string;
      is_bot: number;
      avatar_color: string | null;
      avatar_initial: string | null;
      plan_startup_min: number | null;
      plan_default_estimate_min: number | null;
      is_remote: number;
      home_server: string | null;
      created_at: string;
      updated_at: string;
      deleted: number;
    }>('SELECT * FROM users')
    .map(
      (r): User => ({
        id: r.id,
        username: r.username,
        display_name: r.display_name,
        role: r.role as User['role'],
        is_bot: bool(r.is_bot),
        avatar_color: r.avatar_color,
        avatar_initial: r.avatar_initial,
        plan_startup_min: r.plan_startup_min,
        plan_default_estimate_min: r.plan_default_estimate_min,
        is_remote: bool(r.is_remote),
        home_server: r.home_server,
        created_at: r.created_at,
        updated_at: r.updated_at,
        deleted: bool(r.deleted),
      }),
    );

  type RecSpec = { entity: string; row_id: string; data: unknown };
  const records: RecSpec[] = [];

  for (const u of users) {
    records.push({ entity: 'user', row_id: u.id, data: u });
  }

  for (const t of db.all<Record<string, unknown>>('SELECT * FROM tags')) {
    records.push({
      entity: 'tag',
      row_id: String(t.id),
      data: {
        id: t.id,
        name: t.name,
        color: t.color,
        status: t.status || 'active',
        sort_order: t.sort_order ?? 0,
        geo: t.geo ?? null,
        created_at: t.created_at,
        updated_at: t.updated_at,
        deleted: bool(t.deleted as number),
      },
    });
  }

  for (const it of db.all<{ item_id: string; tag_id: string; updated_at: string; deleted: number }>(
    'SELECT * FROM item_tags',
  )) {
    records.push({
      entity: 'item_tag',
      row_id: `it:${it.item_id}:${it.tag_id}`,
      data: {
        item_id: it.item_id,
        tag_id: it.tag_id,
        updated_at: it.updated_at,
        deleted: bool(it.deleted),
      },
    });
  }

  for (const d of db.all<{ pred_id: string; succ_id: string; updated_at: string; deleted: number }>(
    'SELECT * FROM item_deps',
  )) {
    records.push({
      entity: 'item_dep',
      row_id: `dep:${d.pred_id}:${d.succ_id}`,
      data: {
        pred_id: d.pred_id,
        succ_id: d.succ_id,
        updated_at: d.updated_at,
        deleted: bool(d.deleted),
      },
    });
  }

  for (const s of db.all<Record<string, unknown>>('SELECT * FROM shares')) {
    records.push({
      entity: 'share',
      row_id: String(s.id),
      data: {
        id: s.id,
        item_id: s.item_id,
        user_id: s.user_id,
        permission: s.permission ?? 'read',
        created_at: s.created_at,
        updated_at: s.updated_at,
        deleted: bool(s.deleted as number),
      },
    });
  }

  for (const a of db.all<Record<string, unknown>>('SELECT * FROM assignees')) {
    records.push({
      entity: 'assignee',
      row_id: String(a.id),
      data: {
        id: a.id,
        item_id: a.item_id,
        user_id: a.user_id,
        created_at: a.created_at,
        updated_at: a.updated_at,
        deleted: bool(a.deleted as number),
      },
    });
  }

  for (const c of db.all<Record<string, unknown>>('SELECT * FROM comments')) {
    let mentions: string[] = [];
    try {
      mentions = JSON.parse(String(c.mentions ?? '[]')) as string[];
    } catch {
      mentions = [];
    }
    records.push({
      entity: 'comment',
      row_id: String(c.id),
      data: {
        id: c.id,
        item_id: c.item_id,
        author_id: c.author_id,
        body: c.body,
        mentions,
        created_at: c.created_at,
        updated_at: c.updated_at,
        deleted: bool(c.deleted as number),
      },
    });
  }

  for (const a of db.all<Record<string, unknown>>('SELECT * FROM attachments')) {
    records.push({
      entity: 'attachment',
      row_id: String(a.id),
      data: {
        id: a.id,
        parent_type: a.parent_type,
        parent_id: a.parent_id,
        item_id: a.item_id ?? null,
        filename: a.filename,
        mime_type: a.mime_type,
        size: a.size,
        hash: a.hash,
        created_by: a.created_by,
        created_at: a.created_at,
        deleted: bool(a.deleted as number),
      },
    });
  }

  for (const t of db.all<Record<string, unknown>>('SELECT * FROM time_logs')) {
    records.push({
      entity: 'timelog',
      row_id: String(t.id),
      data: {
        id: t.id,
        item_id: t.item_id,
        user_id: t.user_id,
        start_time: t.start_time,
        end_time: t.end_time,
        note: t.note,
        created_at: t.created_at,
        updated_at: t.updated_at,
        kind: t.kind,
        session_id: t.session_id,
        deleted: bool(t.deleted as number),
      },
    });
  }

  for (const p of db.all<Record<string, unknown>>('SELECT * FROM plan')) {
    records.push({
      entity: 'plan',
      row_id: String(p.id),
      data: {
        id: p.id,
        user_id: p.user_id,
        item_id: p.item_id,
        added_at: p.added_at,
        deleted: bool(p.deleted as number),
      },
    });
  }

  for (const s of settings) {
    records.push({ entity: 'setting', row_id: s.row_id, data: s.data });
  }

  const ops: Op[] = [];
  const recordOps: RecordOp[] = [];

  db.transaction(() => {
    db.run('DELETE FROM ops');
    db.run('DELETE FROM record_ops');

    for (const item of items) {
      const fields: ItemPatch = createPatch(item);
      const op: Op = {
        id: uuidv4(),
        item_id: item.id,
        ts: nextTs(db),
        device_id: EPOCH_DEVICE,
        fields,
      };
      insertOp(db, op, true);
      ops.push(op);
    }

    for (const r of records) {
      const op: RecordOp = {
        id: uuidv4(),
        entity: r.entity,
        row_id: r.row_id,
        ts: nextTs(db),
        device_id: EPOCH_DEVICE,
        data: r.data,
      };
      insertRecordOp(db, op, true);
      recordOps.push(op);
    }
  });

  return { opCount: ops.length, recordOpCount: recordOps.length };
}
