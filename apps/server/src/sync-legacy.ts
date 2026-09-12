/** Upgrade historical log payloads for current clients without rewriting the log.
 * Defaults mirror schema migrations 9/10/13/16/19. Only absent fields are filled:
 * explicit invalid values must still fail validation rather than being hidden.
 */
export function legacyRecordData(entity: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  if (entity === "tag")
    return { status: "active", sort_order: 0, geo: null, ...data };
  if (entity === "timelog")
    return {
      kind: "task",
      session_id: null,
      deleted: false,
      updated_at: data.end_time ?? data.start_time,
      ...data,
    };
  return value;
}
