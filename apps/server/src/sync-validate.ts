// ----- sync push shape validation (A2) ----------------------------------------
// Structural validation of the /api/sync request body: shape and types, not just
// byte length. The byte caps (JSON_BODY_LIMIT_KB / SYNC_BODY_LIMIT_MB) bound the
// body size; the per-array count cap (MAX_SYNC_BATCH in ./sync-guard) bounds the
// work; this module rejects structurally invalid bodies with 400 *before* any
// ingest, so a malformed push can't be partially applied and then fail.
//
// Authorization (ownership, destination, scopes) is deliberately NOT here — that
// is ./sync-guard + ./authorize (A1). A rejected push (400/413/429/507) is never
// ingested, so the client's unsynced ops stay unsynced and are retried (the web
// sync loop marks ops synced only on a 2xx — see apps/web/src/lib/sync.ts).
//
// Limits here are per-field sanity caps, sized well below the body caps:
//  - ids: 64 chars (item/user ids are 36-char UUIDs; op ids are short `op-…`/`r-…`);
//  - record row_id: 128 chars. This is an OPAQUE record key, not a simple id —
//    shares/assignees are composite `s:<itemId>:<userId>` / `a:<itemId>:<userId>`
//    (= 2+36+1+36 = 75 for two UUIDs). A 64 cap would reject legitimate grants
//    (discovered via the A1 forged-share suite). 128 leaves headroom for longer
//    agent ids while staying far below the body caps;
//  - string field values: 2 MB each (the 16 MB sync body cap is the true ceiling;
//    a note body is a full-value LWW field and is the largest realistic string);
//  - ts: finite, |ts| <= 1e15 (a hybrid-logical-clock millisecond epoch).
const MAX_ID_LEN = 64;
const MAX_ROW_ID_LEN = 128;
const MAX_FIELD_STRING_LEN = 2 * 1024 * 1024;
const MAX_TS_MAGNITUDE = 1e15;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkTs(v: unknown, where: string): string | null {
  if (v === undefined) return null;
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    Math.abs(v) > MAX_TS_MAGNITUDE
  )
    return `${where} must be a finite number (|ts| <= ${MAX_TS_MAGNITUDE})`;
  return null;
}

function checkId(v: unknown, where: string, max = MAX_ID_LEN): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || !v.length || v.length > max)
    return `${where} must be a non-empty string of at most ${max} chars`;
  return null;
}

/** Validate the sync request body's shape. Returns an error detail string, or null
 *  when the body is structurally sound (authorization is checked downstream). */
export function validateSyncBody(body: unknown): string | null {
  if (!isPlainObject(body)) return "body must be a JSON object";

  for (const k of ["since", "rsince", "rosterCursor", "reviewSince"] as const) {
    const v = body[k];
    if (
      v !== undefined &&
      (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    ) {
      return `${k} must be a non-negative number`;
    }
  }

  if (
    body.syncEpoch !== undefined &&
    (!Number.isSafeInteger(body.syncEpoch) || Number(body.syncEpoch) < 1)
  )
    return "syncEpoch must be a positive integer";

  const ops = body.ops;
  if (ops !== undefined) {
    if (!Array.isArray(ops)) return "ops must be an array";
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!isPlainObject(op)) return `ops[${i}] must be an object`;
      let e = checkId(op.item_id, `ops[${i}].item_id`);
      if (e) return e;
      e = checkId(op.id, `ops[${i}].id`);
      if (e) return e;
      e = checkTs(op.ts, `ops[${i}].ts`);
      if (e) return e;
      if (op.fields !== undefined) {
        if (!isPlainObject(op.fields))
          return `ops[${i}].fields must be an object`;
        for (const [k, v] of Object.entries(op.fields)) {
          if (typeof v === "string" && v.length > MAX_FIELD_STRING_LEN) {
            return `ops[${i}].fields.${k} exceeds ${MAX_FIELD_STRING_LEN} chars`;
          }
          if (
            v !== null &&
            typeof v !== "string" &&
            typeof v !== "number" &&
            typeof v !== "boolean" &&
            !Array.isArray(v) &&
            !isPlainObject(v)
          ) {
            return `ops[${i}].fields.${k} must be a JSON value`;
          }
        }
      }
    }
  }

  const recordOps = body.recordOps;
  if (recordOps !== undefined) {
    if (!Array.isArray(recordOps)) return "recordOps must be an array";
    for (let i = 0; i < recordOps.length; i++) {
      const op = recordOps[i];
      if (!isPlainObject(op)) return `recordOps[${i}] must be an object`;
      let e = checkId(op.id, `recordOps[${i}].id`);
      if (e) return e;
      if (
        typeof op.entity !== "string" ||
        !op.entity ||
        op.entity.length > 32
      ) {
        return `recordOps[${i}].entity must be a non-empty string of at most 32 chars`;
      }
      e = checkId(op.row_id, `recordOps[${i}].row_id`, MAX_ROW_ID_LEN);
      if (e) return e;
      e = checkTs(op.ts, `recordOps[${i}].ts`);
      if (e) return e;
      if (op.data !== undefined && !isPlainObject(op.data)) {
        return `recordOps[${i}].data must be an object`;
      }
    }
  }

  if (body.backfill !== undefined) {
    const b = body.backfill;
    if (
      !isPlainObject(b) ||
      typeof b.root !== "string" ||
      b.root.length > MAX_ID_LEN ||
      !Number.isSafeInteger(b.cursor) ||
      Number(b.cursor) < 0 ||
      !Number.isSafeInteger(b.rcursor) ||
      Number(b.rcursor) < 0
    )
      return "invalid backfill cursor";
  }
  const need = body.need;
  if (need !== undefined) {
    if (!Array.isArray(need)) return "need must be an array";
    for (let i = 0; i < need.length; i++) {
      const id = need[i];
      if (typeof id !== "string" || !id.length || id.length > MAX_ID_LEN) {
        return `need[${i}] must be a non-empty string of at most ${MAX_ID_LEN} chars`;
      }
    }
  }

  return null;
}
