// Per-entry field-shape contract for sync pushes (A4).
//
// A sync push is validated in three layers (see apps/server/src/sync-guard.ts + sync-validate.ts):
//   1. whole-body shape (`validateSyncBody`, 400 before any ingest),
//   2. **this module** — the per-entry *data contract*: every field an op carries must be a key
//      of `ItemPatch` with a value `applyOp` can safely bind (wrong type / unknown key / bad
//      timestamp is rejected with an actionable reason BEFORE ingest, so a well-shaped but
//      mistyped push can no longer be persisted into the shared `ops`/`record_ops` log and
//      echoed to every peer — the carried "malformed sync payload corrupts the shared item"
//      finding),
//   3. authorization (ownership / destination / scopes / record identity, `./authorize`).
//
// The contract is derived from the `items` column nullability (schema.ts) and `applyOp`'s
// binding rules (crdt.ts `toStorage`):
//   - required fields (NOT NULL columns): a non-null value of the declared type;
//   - clearable fields: the declared type, or null;
//   - JSON fields (recurrence/geo/thumb/metadata): a JSON string, a decoded object/array, or
//     null — `toStorage` serializes objects, and legacy/foreign ops legitimately carry
//     decoded JSON where the column stores a string;
//   - date fields: a parseable ISO-8601 string (LWW on date columns is lexicographic — a
//     garbage date would sort "after" real ones and win merges);
//   - `ts`: strictly positive (nextTs never issues <= 0) and finite (the |ts| cap lives in
//     the server's sync-validate).

import type { Op, ItemPatch } from "./types";
import type { RecordOp } from "./records";

export type FieldKind =
  "string" | "boolean" | "number" | "json" | "date" | "enum";

export interface FieldSpec {
  kind: FieldKind;
  /** enum: the closed value set. */
  values?: readonly string[];
  /** false = the field must carry a non-null value (NOT NULL column). */
  nullable: boolean;
}

/** The per-field contract for every key of `ItemPatch` (26 fields). */
export const ITEM_FIELD_CONTRACT: Record<keyof ItemPatch, FieldSpec> = {
  parent_id: { kind: "string", nullable: true },
  type: {
    kind: "enum",
    values: ["project", "task", "folder", "note"],
    nullable: false,
  },
  owner_id: { kind: "string", nullable: true },
  title: { kind: "string", nullable: false },
  note: { kind: "string", nullable: true },
  status: {
    kind: "enum",
    values: ["active", "done", "dropped"],
    nullable: false,
  },
  flagged: { kind: "boolean", nullable: false },
  priority: { kind: "number", nullable: false },
  defer_date: { kind: "date", nullable: true },
  due_date: { kind: "date", nullable: true },
  reminder_at: { kind: "date", nullable: true },
  estimate_minutes: { kind: "number", nullable: true },
  completed_at: { kind: "date", nullable: true },
  review_interval: { kind: "number", nullable: true },
  reviewed_at: { kind: "date", nullable: true },
  recurrence: { kind: "json", nullable: true },
  geo: { kind: "json", nullable: true },
  color: { kind: "string", nullable: true },
  notes_project: { kind: "boolean", nullable: false },
  thumb: { kind: "json", nullable: true },
  folder_id: { kind: "string", nullable: true },
  sort_order: { kind: "number", nullable: false },
  order_mode: {
    kind: "enum",
    values: ["parallel", "sequential", "single"],
    nullable: false,
  },
  sys_kind: { kind: "string", nullable: true },
  metadata: { kind: "json", nullable: true },
  deleted: { kind: "boolean", nullable: false },
};

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}([Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isIsoDate(v: unknown): boolean {
  return (
    typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v))
  );
}

function isPlainish(v: unknown): boolean {
  return v !== null && typeof v === "object";
}

/** Check one field value against its spec. Returns an actionable reason, or null. */
export function fieldValueError(
  field: string,
  spec: FieldSpec,
  v: unknown,
): string | null {
  if (v === null)
    return spec.nullable ? null : `field ${field} must not be null`;
  switch (spec.kind) {
    case "string":
      if (typeof v !== "string")
        return `field ${field} must be a string, got ${typeName(v)}`;
      return null;
    case "boolean":
      if (typeof v !== "boolean")
        return `field ${field} must be a boolean, got ${typeName(v)}`;
      return null;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v))
        return `field ${field} must be a finite number, got ${typeName(v)}`;
      return null;
    case "enum":
      if (typeof v !== "string" || !(spec.values ?? []).includes(v))
        return `field ${field} must be one of ${JSON.stringify(spec.values)}, got ${JSON.stringify(v)}`;
      return null;
    case "date":
      if (!isIsoDate(v))
        return `field ${field} must be an ISO-8601 date string, got ${JSON.stringify(v)}`;
      return null;
    case "json":
      if (typeof v !== "string" && !isPlainish(v))
        return `field ${field} must be a JSON string or object, got ${typeName(v)}`;
      return null;
  }
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

/** Validate the op envelope (id/item_id/ts/device_id) + every field in `op.fields`.
 *  Returns the first actionable reason, or null when the entry is well-formed. */
export function opShapeError(op: Op): string | null {
  if (!op || typeof op !== "object") return "op entry must be an object";
  if (typeof op.id !== "string" || !op.id.length || op.id.length > 64)
    return `op.id must be a non-empty string of at most 64 chars`;
  if (
    typeof op.item_id !== "string" ||
    !op.item_id.length ||
    op.item_id.length > 64
  )
    return `op.item_id must be a non-empty string of at most 64 chars`;
  if (typeof op.ts !== "number" || !Number.isFinite(op.ts) || op.ts <= 0)
    return "op.ts must be a positive finite number (client clock error)";
  if (
    typeof op.device_id !== "string" ||
    !op.device_id.length ||
    op.device_id.length > 64
  )
    return `op.device_id must be a non-empty string of at most 64 chars`;

  const fields = op.fields;
  if (fields === undefined || fields === null) return null; // an op with no fields is a no-op apply
  if (typeof fields !== "object" || Array.isArray(fields))
    return "op.fields must be an object";
  for (const [k, v] of Object.entries(fields)) {
    const spec = (ITEM_FIELD_CONTRACT as Record<string, FieldSpec | undefined>)[
      k
    ];
    if (!spec) return `unknown field "${k}" (not part of the item contract)`;
    const err = fieldValueError(k, spec, v);
    if (err) return err;
  }
  return null;
}

// Record-op data contract: the minimal per-entity type checks that close the same hole
// for the record log. Identity/row-association is A1's (`authorize.validateRecordOp`);
// this checks the DATA the upserts bind — a mistyped `attachment.hash` is exactly the
// "metadata synced without content" entry (a reference that can never be satisfied).
const HASH64 = /^[0-9a-f]{64}$/;

function str(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && v.length ? v : null;
}

function recordContentShapeError(op: RecordOp): string | null {
  if (!op || typeof op !== "object") return "record op entry must be an object";
  if (typeof op.id !== "string" || !op.id.length || op.id.length > 64)
    return `record op.id must be a non-empty string of at most 64 chars`;
  if (
    typeof op.entity !== "string" ||
    !op.entity.length ||
    op.entity.length > 32
  )
    return "record op.entity must be a non-empty string of at most 32 chars";
  if (
    typeof op.row_id !== "string" ||
    !op.row_id.length ||
    op.row_id.length > 128
  )
    return `record op.row_id must be a non-empty string of at most 128 chars`;
  if (typeof op.ts !== "number" || !Number.isFinite(op.ts) || op.ts <= 0)
    return "record op.ts must be a positive finite number (client clock error)";
  const data =
    op.data && typeof op.data === "object" && !Array.isArray(op.data)
      ? (op.data as Record<string, unknown>)
      : null;
  if (!data) return "record op.data must be a JSON object";

  switch (op.entity) {
    case "attachment": {
      const hash = str(data, "hash");
      if (!hash || !HASH64.test(hash))
        return "attachment.hash must be a 64-char hex content hash (the content reference)";
      if (
        typeof data.size !== "number" ||
        !Number.isFinite(data.size) ||
        data.size < 0
      )
        return "attachment.size must be a non-negative number";
      if (!str(data, "filename"))
        return "attachment.filename must be a non-empty string";
      return null;
    }
    case "tag":
      return str(data, "name") ? null : "tag.name must be a non-empty string";
    case "share":
    case "assignee":
      return str(data, "user_id")
        ? null
        : `${op.entity}.user_id must be a non-empty string`;
    case "timelog":
      return isIsoDate(data.start_time)
        ? null
        : "timelog.start_time must be an ISO-8601 datetime string";
    default:
      return null; // other entities: A1's per-entity rules + the upserts' own binding
  }
}

/** Current-version record rows are complete; validate every value an upsert binds. */
export function recordOpShapeError(op: RecordOp): string | null {
  const basic = recordContentShapeError(op);
  if (basic) return basic;
  if (
    typeof op.device_id !== "string" ||
    !op.device_id.length ||
    op.device_id.length > 64
  )
    return "record op.device_id must be a non-empty string of at most 64 chars";
  const data = op.data as Record<string, unknown>;
  const shapes: Record<string, Record<string, string>> = {
    user: {
      id: "id",
      username: "string",
      display_name: "string?",
      role: "admin|member",
      is_bot: "boolean",
      avatar_color: "string?",
      avatar_initial: "string?",
      plan_startup_min: "number?",
      plan_default_estimate_min: "number?",
      is_remote: "boolean",
      home_server: "string?",
      created_at: "date",
      updated_at: "date",
      deleted: "boolean",
    },
    share: {
      id: "id",
      item_id: "id",
      user_id: "id",
      permission: "read|write",
      created_at: "date",
      updated_at: "date",
      deleted: "boolean",
    },
    assignee: {
      id: "id",
      item_id: "id",
      user_id: "id",
      created_at: "date",
      updated_at: "date",
      deleted: "boolean",
    },
    comment: {
      id: "id",
      item_id: "id",
      author_id: "id?",
      body: "string",
      mentions: "strings",
      created_at: "date",
      updated_at: "date",
      deleted: "boolean",
    },
    attachment: {
      id: "id",
      item_id: "id",
      parent_type: "item|comment",
      parent_id: "id",
      filename: "string",
      mime_type: "string?",
      size: "number",
      hash: "id",
      created_by: "id?",
      created_at: "date",
      deleted: "boolean",
    },
    timelog: {
      id: "id",
      item_id: "id",
      user_id: "id?",
      start_time: "date",
      end_time: "date?",
      note: "string?",
      created_at: "date",
      updated_at: "date",
      kind: "session|task|pause|complete|note",
      session_id: "id?",
      deleted: "boolean",
    },
    plan: {
      id: "id",
      user_id: "id?",
      item_id: "id",
      added_at: "date",
      deleted: "boolean",
    },
    tag: {
      id: "id",
      name: "string",
      color: "string?",
      status: "active|on-hold",
      sort_order: "number",
      geo: "string?",
      created_at: "date",
      updated_at: "date",
      deleted: "boolean",
    },
    item_tag: {
      item_id: "id",
      tag_id: "id",
      updated_at: "date",
      deleted: "boolean",
    },
    item_dep: {
      pred_id: "id",
      succ_id: "id",
      updated_at: "date",
      deleted: "boolean",
    },
    setting: { user_id: "id", payload: "object" },
  };
  const shape = shapes[op.entity];
  if (!shape) return `unsupported record entity ${op.entity}`;
  for (const [key, spec] of Object.entries(shape)) {
    const value = data[key];
    if (spec.endsWith("?") && value === null) continue;
    const type = spec.replace(/\?$/, "");
    const valid =
      type === "id"
        ? typeof value === "string" && value.length > 0 && value.length <= 256
        : type === "date"
          ? typeof value === "string" &&
            /^\d{4}-/.test(value) &&
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString() === value
          : type === "strings"
            ? Array.isArray(value) &&
              value.length <= 1000 &&
              value.every((v) => typeof v === "string" && v.length <= 256)
            : type === "object"
              ? value !== null &&
                typeof value === "object" &&
                !Array.isArray(value)
              : type === "number"
                ? typeof value === "number" && Number.isFinite(value)
                : type.includes("|")
                  ? typeof value === "string" && type.split("|").includes(value)
                  : typeof value === type;
    if (!valid)
      return `${op.entity}.${key} must be ${spec} (complete current-version row required)`;
  }
  return null;
}
