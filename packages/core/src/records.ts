import type { Db } from './db';

/** A synced change to a row-level entity (share, assignee, …). `data` is the full
 *  JSON row; merge is LWW by the row's own updated_at, applied by entity upserts. */
export interface RecordOp {
  id: string;
  entity: string;
  row_id: string;
  ts: number;
  device_id: string;
  data: unknown;
}

interface RecordOpRow {
  id: string;
  entity: string;
  row_id: string;
  ts: number;
  device_id: string;
  data: string;
}

function rowToRecordOp(r: RecordOpRow): RecordOp {
  return {
    id: r.id,
    entity: r.entity,
    row_id: r.row_id,
    ts: Number(r.ts),
    device_id: r.device_id,
    data: JSON.parse(r.data),
  };
}

export function insertRecordOp(db: Db, op: RecordOp, synced: boolean): void {
  db.run(
    `INSERT INTO record_ops (id, entity, row_id, ts, device_id, data, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [op.id, op.entity, op.row_id, op.ts, op.device_id, JSON.stringify(op.data), synced ? 1 : 0],
  );
}

export function getUnsyncedRecordOps(db: Db): RecordOp[] {
  return db
    .all<RecordOpRow>(
      'SELECT id, entity, row_id, ts, device_id, data FROM record_ops WHERE synced = 0 ORDER BY ts',
    )
    .map(rowToRecordOp);
}

export function markRecordOpsSynced(db: Db, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.run(`UPDATE record_ops SET synced = 1 WHERE id IN (${placeholders})`, ids);
}

export function recordOpExists(db: Db, id: string): boolean {
  return !!db.get('SELECT 1 AS x FROM record_ops WHERE id = ?', [id]);
}
