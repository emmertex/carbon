import {
  opShapeError,
  recordOpShapeError,
  type Op,
  type RecordOp,
} from "@carbon/core";

/** Fail before binding epochs, applying rows, acknowledging work or moving cursors. */
export function assertSyncResponse(
  value: unknown,
  since: number,
  rsince: number,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid sync response object");
  const data = value as Record<string, unknown>;
  for (const [key, floor] of [
    ["cursor", since],
    ["rcursor", rsince],
    ["syncEpoch", 1],
  ] as const) {
    if (!Number.isSafeInteger(data[key]) || Number(data[key]) < floor)
      throw new Error(`Invalid sync response ${key}; local state retained`);
  }
  for (const key of ["ops", "recordOps", "users"])
    if (!Array.isArray(data[key]))
      throw new Error(`Invalid sync response ${key} array`);
  for (const op of data.ops as Op[])
    if (opShapeError(op))
      throw new Error("Invalid sync response item operation");
  for (const op of data.recordOps as RecordOp[]) {
    if (recordOpShapeError(op))
      throw new Error("Invalid sync response record operation");
  }
  for (const user of data.users as Array<Record<string, unknown>>) {
    if (
      !user ||
      typeof user !== "object" ||
      recordOpShapeError({
        id: "roster",
        row_id: String(user.id ?? ""),
        entity: "user",
        ts: 1,
        device_id: "server",
        data: user,
      })
    )
      throw new Error("Invalid sync response user");
  }
  const ack = data.acknowledged as
    { ops?: unknown; recordOps?: unknown } | undefined;
  if (
    !ack ||
    !Array.isArray(ack.ops) ||
    !Array.isArray(ack.recordOps) ||
    ![...ack.ops, ...ack.recordOps].every(
      (id) => typeof id === "string" && id.length > 0,
    )
  ) {
    throw new Error(
      "Sync response has no valid acknowledgements; pending work retained",
    );
  }
  if (data.backfill !== undefined) {
    const b = data.backfill as Record<string, unknown>;
    if (
      !b ||
      typeof b.root !== "string" ||
      typeof b.done !== "boolean" ||
      !Number.isSafeInteger(b.cursor) ||
      Number(b.cursor) < 0 ||
      !Number.isSafeInteger(b.rcursor) ||
      Number(b.rcursor) < 0
    )
      throw new Error("Invalid sync backfill cursor");
  }
  if (
    data.rosterCursor !== undefined &&
    (!Number.isSafeInteger(data.rosterCursor) || Number(data.rosterCursor) < 0)
  )
    throw new Error("Invalid roster cursor");
}
