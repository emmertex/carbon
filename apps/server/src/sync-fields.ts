// ----- sync push per-entry shape filtering (A4) --------------------------------
// The sync push is validated in three layers:
//   1. `sync-validate.ts` — whole-body shape/types → 400 BEFORE any ingest (atomic push).
//   2. **this module** — per-entry field-shape validation (the core `field-shape`
//      contract): a well-shaped but mistyped / unknown-field / bad-timestamp entry is
//      dropped with an actionable reason and is NEVER ingested (no log row, no
//      materialization, no echo to peers). A bad entry can no longer poison the shared
//      log — and it never poisons its batch: the rest of the push ingests as usual
//      (per-entry model; see the `rejected` response field below).
//   3. `sync-guard.ts` + `authorize.ts` — ownership / destination / scopes / record
//      identity (A1).
//
// The handler runs layer 2 in EVERY auth mode (open included — a data contract is not
// an access decision) and layers the results into the response:
//
//   rejected: {
//     ops, recordOps,          // A2 counts (kept byte-compatible)
//     ops_ids, record_ops_ids, // A4: the ids the server did not ingest — the client
//                              // marks ONLY the accepted ones synced, so a rejection
//                              // is never a silent loss (rejected entries stay
//                              // unsynced and are re-pushed; the count surfaces them)
//     detail,                  // A4: actionable per-entry reasons (capped at 100)
//   }

import type { Op, RecordOp } from '@carbon/core';
import { opShapeError, recordOpShapeError } from '@carbon/core';

export const REJECTED_DETAIL_CAP = 100;

export interface ShapeReject {
  index: number;
  kind: 'op' | 'recordOp';
  /** The entry's id when it had one (for the client's mark-synced split). */
  id?: string;
  reason: string;
}

export interface ShapeFilterResult<T> {
  ops: T[];
  rejected: ShapeReject[];
}

/** Per-entry field-shape filter for item ops. */
export function filterOpsByShape(ops: Op[]): ShapeFilterResult<Op> {
  const kept: Op[] = [];
  const rejected: ShapeReject[] = [];
  ops.forEach((op, index) => {
    const err = opShapeError(op);
    if (err) {
      rejected.push({
        index,
        kind: 'op',
        id: typeof op?.id === 'string' ? op.id : undefined,
        reason: err,
      });
      return;
    }
    kept.push(op);
  });
  return { ops: kept, rejected };
}

/** Per-entry field-shape filter for record ops. */
export function filterRecordOpsByShape(ops: RecordOp[]): ShapeFilterResult<RecordOp> {
  const kept: RecordOp[] = [];
  const rejected: ShapeReject[] = [];
  ops.forEach((op, index) => {
    const err = recordOpShapeError(op);
    if (err) {
      rejected.push({
        index,
        kind: 'recordOp',
        id: typeof op?.id === 'string' ? op.id : undefined,
        reason: err,
      });
      return;
    }
    kept.push(op);
  });
  return { ops: kept, rejected };
}
