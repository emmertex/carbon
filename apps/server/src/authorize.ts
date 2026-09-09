/**
 * Shared authorization — the single source of truth for "who may do what to what"
 * across every server surface: REST, sync, built-in AI (agent-ops), Telegram, imports,
 * and federation. Introducing a second, divergent authorization path is a bug; every
 * surface resolves access through the functions here.
 *
 * Two orthogonal concerns are combined for a (credential, target) pair:
 *
 *  1. **Credential level** — the *type* of credential and its scopes. A closed set of
 *     auth methods is known (`open`, `mfa_challenge`, `session`, `token`, `basic`);
 *     **anything else is denied by default**. A token's *own* scopes bind; a human
 *     session (session/open/basic) acts as its full user (all scopes); an MFA challenge
 *     (and any unknown method) carries no scopes.
 *
 *  2. **Target level** — the caller's *data* access to a specific row: ownership,
 *     write, or read (via the @carbon/core access primitives). `local` (open mode) and
 *     bot users keep their existing full-visibility semantics.
 *
 * On top of those two, the module enforces the A1 record/destination rules:
 *   - **Record identity** — before an update is accepted, the pushed row's identity
 *     (its id, its item/row association, and its immutable fields) must agree with the
 *     existing row. A forged share can no longer upgrade a read grant to write by
 *     colliding with an unrelated row; a mismatched comment can no longer overwrite
 *     someone else's comment.
 *   - **Destination access** — a create/move's parent must be writable by the caller;
 *     hierarchy cycles are rejected; invalid parent types (a project nested under a task,
 *     a task nested under a folder) are rejected.
 *   - **Owner-only onward sharing** — only an item's owner may grant/revoke access on it
 *     (a non-owner sharee may only remove their *own* grant); the sole exception is a
 *     write-sharee replicating their *own* grant onto a just-created recurring spawn.
 *   - **Comment management** — only a comment's author or the item's owner may edit or
 *     delete that comment.
 *
 * The module is Hono-agnostic: it operates on a plain {@link Credential} value (built by
 * each surface from its context) and a {@link Db}. It performs no persistence — it is a
 * pure access decision plus a pure transform of pushed ops.
 */
import {
  type Db,
  type Op,
  type RecordOp,
  type ItemPatch,
  type ItemType,
  getItem,
  getUser,
  hasWriteAccess,
  hasReadAccess,
  subtreeIds,
} from "@carbon/core";
import { SCOPES, type Scope } from "./auth";

// ----- credential level -------------------------------------------------------

/** The closed set of auth methods the server mints (see `auth.ts` `AuthMethod`). */
export const KNOWN_AUTH_METHODS = [
  "open",
  "mfa_challenge",
  "session",
  "token",
  "basic",
] as const;
export type KnownAuthMethod = (typeof KNOWN_AUTH_METHODS)[number];

/** A credential as resolved by a surface from its request context. `authMethod` is kept a
 *  plain string so a forged/unknown value can be denied by default rather than assumed. */
export interface Credential {
  authMethod: string;
  userId: string;
  role: "admin" | "member";
  scopes: string[];
  /** When set, this credential is restricted to a specific project subtree (API key restriction). */
  restrictedProjectId?: string;
}

/** Build a {@link Credential} from Hono's `AuthVars` context values. */
export function credentialFromVars(v: {
  authMethod?: unknown;
  userId?: unknown;
  role?: unknown;
  scopes?: unknown;
  restrictedProjectId?: unknown;
}): Credential {
  return {
    authMethod: typeof v.authMethod === "string" ? v.authMethod : "",
    userId: typeof v.userId === "string" ? v.userId : "",
    role: v.role === "admin" ? "admin" : "member",
    scopes: Array.isArray(v.scopes) ? v.scopes.map(String) : [],
    restrictedProjectId: typeof v.restrictedProjectId === "string" && v.restrictedProjectId ? v.restrictedProjectId : undefined,
  };
}

/** A synthetic full-identity credential for a bare userId (surfaces that already carry a
 *  resolved user but no request credential — e.g. the data-level sync guards and agent-ops,
 *  where the user is a real human session). Unknown auth methods are never produced here. */
export function sessionCredentialFor(userId: string): Credential {
  return { authMethod: "session", userId, role: "member", scopes: [...SCOPES] };
}

export function isKnownAuthMethod(m: string): m is KnownAuthMethod {
  return (KNOWN_AUTH_METHODS as readonly string[]).includes(m);
}

/** A request is denied outright for an unsupported/unknown credential type. */
export function isDenied(cred: Credential): boolean {
  return !isKnownAuthMethod(cred.authMethod);
}

/**
 * The credential's *effective* scopes. A token's own scopes bind; a human session
 * (session/open/basic) acts as its full user (every scope); an MFA challenge — and any
 * unknown method — carries none. This is what makes a read-only API token stay read-only
 * on every surface (it holds no write scope) while a human session keeps full-user rights.
 */
export function effectiveScopes(cred: Credential): string[] {
  if (isDenied(cred)) return [];
  switch (cred.authMethod as KnownAuthMethod) {
    case "token":
      return Array.isArray(cred.scopes) ? [...cred.scopes] : [];
    case "mfa_challenge":
      return [];
    case "session":
    case "open":
    case "basic":
      return [...SCOPES];
  }
}

/** Does the credential hold `scope` (see {@link effectiveScopes})? */
export function hasScope(cred: Credential, scope: Scope): boolean {
  return effectiveScopes(cred).includes(scope);
}

/** A human session (session/open/basic) — full-user semantics for every scope. */
export function isHumanSession(cred: Credential): boolean {
  if (isDenied(cred)) return false;
  return (
    (cred.authMethod as KnownAuthMethod) === "session" ||
    (cred.authMethod as KnownAuthMethod) === "open" ||
    (cred.authMethod as KnownAuthMethod) === "basic"
  );
}

/**
 * May this credential push *writes* (item ops and write record ops)? A sync push is a
 * write. A token needs tasks:write; inbox:write only authorizes the capture route.
 */
export function canPushWrites(cred: Credential): boolean {
  return hasScope(cred, "tasks:write");
}

// ----- target level -----------------------------------------------------------

export type AccessLevel = "none" | "read" | "write" | "own";

/** `local` (open mode, single trusted user) and bot users keep full visibility. */
export function isLocalOrBot(db: Db, userId: string): boolean {
  if (userId === "local") return true;
  if (!userId) return false;
  return !!getUser(db, userId)?.is_bot;
}

/**
 * The caller's effective data access to `itemId`. Unknown credential types deny by
 * default. `local`/bots map to `own` (their existing full-visibility semantics);
 * otherwise ownership cascades down the tree, then effective shares decide write vs read.
 */
export function effectiveAccess(
  db: Db,
  cred: Credential,
  itemId: string,
): AccessLevel {
  if (isDenied(cred)) return "none";
  const uid = cred.userId;
  if (isLocalOrBot(db, uid)) return "own";
  const item = getItem(db, itemId);
  if (item && item.owner_id === uid) return "own";
  if (hasWriteAccess(db, itemId, uid)) return "write";
  if (hasReadAccess(db, itemId, uid)) return "read";
  return "none";
}

// Check if the item is a descendant of the restricted project
function isItemInRestrictedSubtree(db: Db, cred: Credential, itemId: string): boolean {
  if (!cred.restrictedProjectId) return true;
  if (itemId === cred.restrictedProjectId) return true;
  return subtreeIds(db, [cred.restrictedProjectId]).has(itemId);
}

export function canReadItem(db: Db, cred: Credential, itemId: string): boolean {
  return effectiveAccess(db, cred, itemId) !== "none" && isItemInRestrictedSubtree(db, cred, itemId);
}

export function canWriteItem(
  db: Db,
  cred: Credential,
  itemId: string,
): boolean {
  const a = effectiveAccess(db, cred, itemId);
  return (a === "write" || a === "own") && isItemInRestrictedSubtree(db, cred, itemId);
}

/** True only when the credential's user is the item's owner (or local/bot). */
export function isItemOwner(db: Db, cred: Credential, itemId: string): boolean {
  return effectiveAccess(db, cred, itemId) === "own" && isItemInRestrictedSubtree(db, cred, itemId);
}

// ----- destination access (creation & moves) ----------------------------------

export type DestinationReason =
  "ok" | "no-access" | "missing-parent" | "bad-parent-type" | "cycle";

export interface DestinationCheck {
  itemId: string;
  /** The item's type: explicit on a create; the existing type on a move. */
  type: ItemType;
  /** The new parent (null = top level / inbox). */
  parentId: string | null;
  /** Item ids created earlier in this same push (a parent may be a same-push create). */
  justCreated?: ReadonlySet<string>;
}

/**
 * Validate a create's or move's destination. Returns `'ok'` or the reason to reject:
 *  - `no-access`      — the caller cannot write the parent (gap 2: creating inside a
 *                        foreign/inaccessible container).
 *  - `missing-parent` — the parent does not exist (and is not a same-push create).
 *  - `bad-parent-type`— an invalid parent type (a project nested under anything, or a
 *                        task/note nested under a folder — folders are visual-only and
 *                        live in `folder_id`, never `parent_id`).
 *  - `cycle`          — the move would place an item under itself or its own descendant.
 */
export function checkDestination(
  db: Db,
  cred: Credential,
  c: DestinationCheck,
): DestinationReason {
  if (isDenied(cred)) return "no-access";
  if (c.parentId === null) return "ok"; // top level / inbox is always a valid destination

  const parent = getItem(db, c.parentId);
  if (!parent) return "missing-parent";

  // Destination must be writable by the caller (a same-push create is the caller's own).
  if (parent && !canWriteItem(db, cred, c.parentId)) {
    return "no-access";
  }

  // Invalid parent types. Projects are top-level containers — never nested. Folders are
  // visual-only grouping (folder_id) and must never host task/note nesting via parent_id.
  if (c.type === "project") return "bad-parent-type";
  if (parent && parent.type === "folder") return "bad-parent-type";

  // Hierarchy cycle: a move must not place the item under itself or a descendant of it.
  const subtree = subtreeIds(db, [c.itemId]);
  if (subtree.has(c.parentId)) return "cycle";
  return "ok";
}

/** Convenience: does the destination pass? (used by sync + agent-ops). */
export function isDestinationAllowed(
  db: Db,
  cred: Credential,
  c: DestinationCheck,
): boolean {
  return checkDestination(db, cred, c) === "ok";
}

// ----- record identity & per-entity rules -------------------------------------

/**
 * Validate a pushed record op against the A1 rules and return a sanitized copy, or `null`
 * to drop the op. This is the single record-authorization path used by sync and federation.
 *
 * For each entity it enforces:
 *  - **Create** (no existing row): the create-time access bar (see per-entity notes below),
 *    with identity-forcing (author/owner/user stamped to the caller where applicable).
 *  - **Update** (an existing row — identity collision): the pushed row's *immutable* fields
 *    must agree with the existing row, and the caller must be permitted to manage that row
 *    (owner-only sharing; author-or-item-owner comment management). A mismatch is dropped —
 *    this is what stops a forged share from upgrading a read grant to write and a mismatched
 *    comment from overwriting another user's comment.
 *
 * `justCreated` (item ids created earlier in this same push) keeps the legitimate
 * recurring-series completion path working: a write-sharee completing a series may replicate
 * their *own* grant onto the just-created spawn (still owned by the series owner).
 */
export function validateRecordOp(
  db: Db,
  cred: Credential,
  op: RecordOp,
  justCreated?: ReadonlySet<string>,
): RecordOp | null {
  if (isDenied(cred)) return null;
  if (!op || typeof op !== "object") return null;
  const just = justCreated ?? new Set<string>();
  const data: Record<string, unknown> =
    op.data && typeof op.data === "object"
      ? { ...(op.data as Record<string, unknown>) }
      : {};
  const itemId = typeof data.item_id === "string" ? data.item_id : null;
  const uid = cred.userId;
  // Every id-keyed upsert uses data.id; a mismatched envelope must never be
  // mistaken for a new row. Composite-key entities have no data.id.
  if (
    [
      "comment",
      "share",
      "assignee",
      "attachment",
      "timelog",
      "plan",
      "tag",
    ].includes(op.entity) &&
    (!rowIdOf(op, data) || (data.id != null && data.id !== op.row_id))
  )
    return null;
  if (
    [
      "comment",
      "share",
      "assignee",
      "attachment",
      "timelog",
      "plan",
      "tag",
    ].includes(op.entity)
  )
    data.id = op.row_id;

  switch (op.entity) {
    // --- comment: create needs read access (author forced to caller); manage only if the
    // --- caller is the comment's author or the item's owner.
    case "comment": {
      if (!itemId || !canReadItem(db, cred, itemId)) return null;
      const rowId = rowIdOf(op, data);
      const existing = rowId
        ? db.get<{ id: string; item_id: string; author_id: string | null }>(
            "SELECT id, item_id, author_id FROM comments WHERE id = ?",
            [rowId],
          )
        : null;
      if (existing) {
        // Update/delete of an existing comment: identity must agree and the caller must be
        // the author or the item's owner.
        if (data.item_id !== existing.item_id) return null;
        const authorId = (data.author_id as string | null | undefined) ?? null;
        if (authorId !== existing.author_id) return null;
        const isOwner = isItemOwner(db, cred, existing.item_id);
        if (!isOwner && existing.author_id !== uid) return null;
        data.author_id = existing.author_id; // never re-attribute
      } else {
        data.author_id = uid; // new comment: authored by the caller
      }
      return { ...op, data };
    }

    // --- share: only the owner controls onward sharing. A non-owner may only remove their
    // --- *own* grant, or replicate their own grant onto a just-created recurring spawn.
    case "share": {
      if (!itemId) return null;
      const rowId = rowIdOf(op, data);
      const existing = rowId
        ? db.get<{ id: string; item_id: string; user_id: string }>(
            "SELECT id, item_id, user_id FROM shares WHERE id = ?",
            [rowId],
          )
        : null;
      if (existing) {
        // Modify an existing grant: identity must agree, and only the owner (or the grantee
        // removing their own grant) may touch it.
        if (data.item_id !== existing.item_id) return null;
        if ((data.user_id as string | undefined) !== existing.user_id)
          return null;
        const isOwner = isItemOwner(db, cred, existing.item_id);
        const ownGrant = existing.user_id === uid;
        const removing = data.deleted === true;
        if (
          !isOwner &&
          !(ownGrant && removing && canReadItem(db, cred, existing.item_id))
        ) {
          return null;
        }
        return { ...op, data };
      }
      // Create a grant: owner-only. Sole exception — a write-sharee replicating their own
      // grant onto a just-created recurring spawn (still owned by the series owner).
      const target = typeof data.user_id === "string" ? data.user_id : null;
      if (isItemOwner(db, cred, itemId)) return { ...op, data };
      if (
        target === uid &&
        just.has(itemId) &&
        (hasWriteAccess(db, itemId, uid) ||
          itemOwnedBySeriesCaller(db, itemId, uid))
      ) {
        return { ...op, data };
      }
      return null;
    }

    // --- assignee: write access to the item; identity must agree on an existing row.
    case "assignee": {
      if (!itemId || !canWriteItem(db, cred, itemId)) return null;
      const rowId = rowIdOf(op, data);
      const existing = rowId
        ? db.get<{ id: string; item_id: string; user_id: string }>(
            "SELECT id, item_id, user_id FROM assignees WHERE id = ?",
            [rowId],
          )
        : null;
      if (existing) {
        if (data.item_id !== existing.item_id) return null;
        if ((data.user_id as string | undefined) !== existing.user_id)
          return null;
      }
      return { ...op, data };
    }

    // Attachment tombstones mutate existing rows too: validate immutable identity.
    case "attachment": {
      if (!itemId || !canWriteItem(db, cred, itemId)) return null;
      const existing = db.get<Record<string, unknown>>(
        "SELECT * FROM attachments WHERE id = ?",
        [op.row_id],
      );
      if (
        existing &&
        [
          "item_id",
          "parent_type",
          "parent_id",
          "hash",
          "created_by",
          "created_at",
          "filename",
          "mime_type",
          "size",
        ].some((k) => (data[k] ?? null) !== (existing[k] ?? null))
      )
        return null;
      if (data.parent_type === "item" && data.parent_id !== itemId) return null;
      if (data.parent_type === "comment") {
        const comment = db.get<{ item_id: string }>(
          "SELECT item_id FROM comments WHERE id = ?",
          [String(data.parent_id)],
        );
        if (comment?.item_id !== itemId) return null;
      }
      return { ...op, data };
    }
    case "item_tag":
      if (op.row_id !== `it:${data.item_id}:${data.tag_id}`) return null;
      if (!itemId || !canWriteItem(db, cred, itemId)) return null;
      return { ...op, data };

    // --- item_dep: write access to BOTH endpoints (the edge touches two items).
    case "item_dep": {
      if (op.row_id !== `dep:${data.pred_id}:${data.succ_id}`) return null;
      const predId = typeof data.pred_id === "string" ? data.pred_id : null;
      const succId = typeof data.succ_id === "string" ? data.succ_id : null;
      if (
        !predId ||
        !succId ||
        !canWriteItem(db, cred, predId) ||
        !canWriteItem(db, cred, succId)
      ) {
        return null;
      }
      return { ...op, data };
    }

    // --- per-user rows: only your own.
    case "timelog":
    case "plan": {
      const table = op.entity === "plan" ? "plan" : "time_logs";
      const existing = db.get<{
        user_id: string | null;
        item_id: string | null;
      }>(`SELECT user_id, item_id FROM ${table} WHERE id = ?`, [op.row_id]);
      if (
        existing &&
        (existing.user_id !== uid ||
          (data.item_id ?? null) !== existing.item_id)
      )
        return null;
      if (itemId && !canReadItem(db, cred, itemId)) return null;
      data.user_id = uid;
      return { ...op, data };
    }
    case "setting":
      if (!["ui", "views"].includes(op.row_id)) return null;
      data.user_id = uid;
      return { ...op, data };

    // --- tag: global shared vocabulary.
    case "tag":
      return { ...op, data };

    // --- user: roster is server-managed (REST admin + roster pull); never client-pushed.
    case "user":
      return null;

    default:
      return null; // unknown entity
  }
}

/** Sanitize a batch of record ops (see {@link validateRecordOp}). Drops disallowed ops. */
export function validateRecordOps(
  db: Db,
  cred: Credential,
  ops: RecordOp[],
  justCreated?: ReadonlySet<string>,
): RecordOp[] {
  const out: RecordOp[] = [];
  // Reserve immutable identities within this batch as well as checking stored rows.
  const identities = new Map<string, string>();
  const immutable: Record<string, string[]> = {
    comment: ["id", "item_id", "author_id"],
    share: ["id", "item_id", "user_id"],
    assignee: ["id", "item_id", "user_id"],
    attachment: [
      "id",
      "item_id",
      "parent_type",
      "parent_id",
      "hash",
      "created_by",
    ],
    timelog: ["id", "item_id", "user_id"],
    plan: ["id", "item_id", "user_id"],
  };
  for (const op of ops) {
    const ok = validateRecordOp(db, cred, op, justCreated);
    if (!ok) continue;
    const fields = immutable[ok.entity];
    if (fields) {
      const data = ok.data as Record<string, unknown>;
      const key = `${ok.entity}:${ok.row_id}`;
      const identity = JSON.stringify(fields.map((f) => data[f] ?? null));
      if (identities.has(key) && identities.get(key) !== identity) continue;
      identities.set(key, identity);
    }
    out.push(ok);
  }
  return out;
}

// ----- helpers ----------------------------------------------------------------

/** The row id of a record op: `row_id` is authoritative; `data.id` must agree. */
function rowIdOf(op: RecordOp, data: Record<string, unknown>): string | null {
  const rowId = typeof op.row_id === "string" ? op.row_id : null;
  const dataId = typeof data.id === "string" ? data.id : null;
  if (rowId && dataId && rowId !== dataId) return null; // identity collision with mismatched id
  return rowId ?? dataId;
}

/**
 * True when `itemId` is an item the caller is completing as part of a recurring series it
 * has write access to — i.e. the spawn is owned by the series owner (not the caller), so the
 * caller replicating their own grant onto it is the legitimate completion path, not an
 * onward grant. Mirrors `sanitizeOps`' `seriesOwnersBeingCompleted` rationale.
 */
function itemOwnedBySeriesCaller(db: Db, itemId: string, uid: string): boolean {
  const item = getItem(db, itemId);
  return !!item && !!item.owner_id && item.owner_id !== uid;
}

// Re-export the item-op sanitizer seam so sync-guard and any other surface share the same
// destination + identity rules for pushed *item* ops.
export function checkItemOpDestination(
  db: Db,
  cred: Credential,
  op: Op,
  justCreated?: ReadonlySet<string>,
): DestinationReason {
  const fields: ItemPatch = { ...(op.fields ?? {}) };
  const parentId =
    typeof fields.parent_id === "string" ? fields.parent_id : null;
  if (parentId === null) return "ok";
  const existing = getItem(db, op.item_id);
  const type: ItemType =
    (typeof fields.type === "string" ? (fields.type as ItemType) : null) ??
    existing?.type ??
    "task";
  return checkDestination(db, cred, {
    itemId: op.item_id,
    type,
    parentId,
    justCreated,
  });
}
