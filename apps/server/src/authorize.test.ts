import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  migrate,
  createItem,
  createUser,
  shareItem,
  addComment,
  type Db,
  type Op,
} from "@carbon/core";
import { openDb } from "./sqlite";
import {
  type Credential,
  sessionCredentialFor,
  isKnownAuthMethod,
  isDenied,
  effectiveScopes,
  hasScope,
  canPushWrites,
  effectiveAccess,
  canReadItem,
  canWriteItem,
  isItemOwner,
  validateRecordOp,
  checkItemOpDestination,
} from "./authorize";

const DEV = "d";
const NOW = 1_750_000_000_000;

function db(): Db {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

const mkOp = (over: Partial<Op> & { item_id: string }): Op => ({
  id: "op",
  ts: NOW,
  device_id: "dev",
  fields: {},
  ...over,
});

// A share row id is `s:<itemId>:<userId>`; a comment id is a uuid from addComment.
const shareRowId = (itemId: string, userId: string) => `s:${itemId}:${userId}`;

// ─── credential level (deny unknown, bind token scopes) ────────────────────────

describe("credential level", () => {
  const token = (userId: string, scopes: string[]): Credential => ({
    authMethod: "token",
    userId,
    role: "member",
    scopes,
  });
  const session = (userId: string): Credential => sessionCredentialFor(userId);

  test("a read-only token carries only its own scopes; no write scope", () => {
    const cred = token("mallory", ["tasks:read"]);
    assert.deepEqual(effectiveScopes(cred), ["tasks:read"]);
    assert.equal(hasScope(cred, "tasks:write"), false);
    assert.equal(hasScope(cred, "tasks:read"), true);
  });

  test("a human session (full user) carries every scope", () => {
    const cred = session("alice");
    assert.ok(effectiveScopes(cred).includes("tasks:write"));
    assert.ok(effectiveScopes(cred).includes("tasks:read"));
    assert.ok(effectiveScopes(cred).includes("inbox:write"));
  });

  test("an unknown credential type is denied by default (no scopes, no access)", () => {
    const cred: Credential = {
      authMethod: "forged",
      userId: "alice",
      role: "admin",
      scopes: ["tasks:write"],
    };
    assert.equal(isKnownAuthMethod("forged"), false);
    assert.equal(isDenied(cred), true);
    assert.deepEqual(effectiveScopes(cred), []);
    assert.equal(canPushWrites(cred), false);
    const d = db();
    assert.equal(effectiveAccess(d, cred, "anything"), "none");
    assert.equal(canReadItem(d, cred, "anything"), false);
  });

  test("an mfa_challenge carries no scopes", () => {
    const cred: Credential = {
      authMethod: "mfa_challenge",
      userId: "alice",
      role: "member",
      scopes: [],
    };
    assert.deepEqual(effectiveScopes(cred), []);
    assert.equal(canPushWrites(cred), false);
  });

  test("canPushWrites: a read-only token cannot push writes; an inbox:write token cannot; a session can", () => {
    assert.equal(
      canPushWrites(token("m", ["tasks:read"])),
      false,
      "tasks:read only",
    );
    assert.equal(canPushWrites(token("m", ["tasks:write"])), true);
    assert.equal(canPushWrites(token("m", ["inbox:write"])), false);
    assert.equal(canPushWrites(session("m")), true);
    assert.equal(
      canPushWrites({
        authMethod: "bogus",
        userId: "m",
        role: "member",
        scopes: ["tasks:write"],
      }),
      false,
    );
  });
});

// ─── target level (data access) ────────────────────────────────────────────────

describe("target level", () => {
  test("owner / write-sharee / read-sharee / stranger map to own / write / read / none", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const carol = createUser(d, { username: "carol" });
    const it = createItem(d, DEV, { title: "t", ownerId: alice.id });
    shareItem(d, DEV, it.id, bob.id, "write");
    shareItem(d, DEV, it.id, carol.id, "read");

    assert.equal(
      effectiveAccess(d, sessionCredentialFor(alice.id), it.id),
      "own",
    );
    assert.equal(
      effectiveAccess(d, sessionCredentialFor(bob.id), it.id),
      "write",
    );
    assert.equal(
      effectiveAccess(d, sessionCredentialFor(carol.id), it.id),
      "read",
    );
    const dave = createUser(d, { username: "dave" });
    assert.equal(
      effectiveAccess(d, sessionCredentialFor(dave.id), it.id),
      "none",
    );

    assert.equal(isItemOwner(d, sessionCredentialFor(alice.id), it.id), true);
    assert.equal(canWriteItem(d, sessionCredentialFor(bob.id), it.id), true);
    assert.equal(canWriteItem(d, sessionCredentialFor(carol.id), it.id), false);
    assert.equal(canReadItem(d, sessionCredentialFor(carol.id), it.id), true);
    assert.equal(canReadItem(d, sessionCredentialFor(dave.id), it.id), false);
  });
});

// ─── record identity (gap 3) ───────────────────────────────────────────────────

describe("record identity", () => {
  test("a forged share (colliding row_id, mismatched item_id) is dropped", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const J = createItem(d, DEV, { title: "j", ownerId: alice.id });
    const I = createItem(d, DEV, { title: "i", ownerId: bob.id });
    shareItem(d, DEV, J.id, bob.id, "read"); // bob has a READ grant on J

    // bob tries to upgrade J's grant to write by pushing a share whose row_id is the
    // existing J grant but whose item_id points at a different item.
    const op = {
      id: "r1",
      entity: "share",
      row_id: shareRowId(J.id, bob.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(J.id, bob.id),
        item_id: I.id,
        user_id: bob.id,
        permission: "write",
      },
    };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor(bob.id), op),
      null,
      "item_id mismatch dropped",
    );
  });

  test("a non-owner cannot upgrade their own read grant to write (owner-only)", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const J = createItem(d, DEV, { title: "j", ownerId: alice.id });
    shareItem(d, DEV, J.id, bob.id, "read");

    // Identity matches (item_id/user_id agree) but bob is not the owner and is not
    // merely removing the grant — the permission upgrade is denied.
    const op = {
      id: "r2",
      entity: "share",
      row_id: shareRowId(J.id, bob.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(J.id, bob.id),
        item_id: J.id,
        user_id: bob.id,
        permission: "write",
      },
    };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor(bob.id), op),
      null,
      "non-owner permission upgrade dropped",
    );

    // ...but the OWNER may upgrade it.
    const byOwner = {
      ...op,
      data: {
        id: shareRowId(J.id, bob.id),
        item_id: J.id,
        user_id: bob.id,
        permission: "write",
      },
    };
    assert.ok(
      validateRecordOp(d, sessionCredentialFor(alice.id), byOwner),
      "owner may modify the grant",
    );
  });

  test("a mismatched comment (colliding row_id) cannot overwrite another user’s comment", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const J = createItem(d, DEV, { title: "j", ownerId: alice.id });
    shareItem(d, DEV, J.id, bob.id, "read"); // bob can read J (so the read bar passes)
    const aliceComment = addComment(d, DEV, {
      itemId: J.id,
      authorId: alice.id,
      body: "mine",
    });

    // bob pushes a comment whose row_id is alice's existing comment but re-authored as bob.
    const op = {
      id: "c1",
      entity: "comment",
      row_id: aliceComment.id,
      ts: NOW,
      device_id: "dev",
      data: {
        id: aliceComment.id,
        item_id: J.id,
        author_id: bob.id,
        body: "hijack",
      },
    };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor(bob.id), op),
      null,
      "author mismatch dropped",
    );

    // A comment bob genuinely authored (on an item he can read) he may still manage.
    const bobComment = addComment(d, DEV, {
      itemId: J.id,
      authorId: bob.id,
      body: "mine too",
    });
    const own = {
      id: "c2",
      entity: "comment",
      row_id: bobComment.id,
      ts: NOW,
      device_id: "dev",
      data: {
        id: bobComment.id,
        item_id: J.id,
        author_id: bob.id,
        body: "edited",
      },
    };
    assert.ok(
      validateRecordOp(d, sessionCredentialFor(bob.id), own),
      "author may manage own comment",
    );
  });

  test("the item owner may manage a comment someone else authored", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const J = createItem(d, DEV, { title: "j", ownerId: alice.id });
    shareItem(d, DEV, J.id, bob.id, "write");
    const bobComment = addComment(d, DEV, {
      itemId: J.id,
      authorId: bob.id,
      body: "hi",
    });

    const byOwner = {
      id: "c3",
      entity: "comment",
      row_id: bobComment.id,
      ts: NOW,
      device_id: "dev",
      data: {
        id: bobComment.id,
        item_id: J.id,
        author_id: bob.id,
        deleted: true,
      },
    };
    assert.ok(
      validateRecordOp(d, sessionCredentialFor(alice.id), byOwner),
      "item owner may delete a sharee’s comment",
    );
  });
});

// ─── destination access (gap 2) ───────────────────────────────────────────────

describe("destination access", () => {
  const cred = (id: string) => sessionCredentialFor(id);

  test("creating inside a foreign, inaccessible project is denied (no-access)", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const proj = createItem(d, DEV, {
      type: "project",
      title: "private",
      ownerId: alice.id,
    });
    const op = mkOp({
      item_id: "new-task",
      fields: { type: "task", title: "infiltrate", parent_id: proj.id },
    });
    assert.equal(checkItemOpDestination(d, cred(bob.id), op), "no-access");
  });

  test("a write-sharee may create inside a shared project (legit)", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const proj = createItem(d, DEV, {
      type: "project",
      title: "shared",
      ownerId: alice.id,
    });
    shareItem(d, DEV, proj.id, bob.id, "write");
    const op = mkOp({
      item_id: "new-task",
      fields: { type: "task", title: "legit", parent_id: proj.id },
    });
    assert.equal(checkItemOpDestination(d, cred(bob.id), op), "ok");
  });

  test("a move that would create a hierarchy cycle is denied", () => {
    const d = db();
    const bob = createUser(d, { username: "bob" });
    const A = createItem(d, DEV, { type: "task", title: "A", ownerId: bob.id });
    const B = createItem(d, DEV, {
      type: "task",
      title: "B",
      ownerId: bob.id,
      parentId: A.id,
    });
    // Move A under its own descendant B.
    const op = mkOp({ item_id: A.id, fields: { parent_id: B.id } });
    assert.equal(checkItemOpDestination(d, cred(bob.id), op), "cycle");
  });

  test("a project nested under a task is an invalid parent type", () => {
    const d = db();
    const bob = createUser(d, { username: "bob" });
    const task = createItem(d, DEV, {
      type: "task",
      title: "t",
      ownerId: bob.id,
    });
    const op = mkOp({
      item_id: "proj",
      fields: { type: "project", title: "nested", parent_id: task.id },
    });
    assert.equal(
      checkItemOpDestination(d, cred(bob.id), op),
      "bad-parent-type",
    );
  });

  test("a task nested under a folder is an invalid parent type", () => {
    const d = db();
    const bob = createUser(d, { username: "bob" });
    const folder = createItem(d, DEV, {
      type: "folder",
      title: "f",
      ownerId: bob.id,
    });
    const op = mkOp({
      item_id: "task",
      fields: { type: "task", title: "t", parent_id: folder.id },
    });
    assert.equal(
      checkItemOpDestination(d, cred(bob.id), op),
      "bad-parent-type",
    );
  });

  test("a claimed same-push parent must be materialized before destination authorization", () => {
    const d = db();
    const bob = createUser(d, { username: "bob" });
    // Project created earlier in the same push (not yet in the db); a task under it.
    const op = mkOp({
      item_id: "task",
      fields: { type: "task", title: "t", parent_id: "proj-created-in-push" },
    });
    assert.equal(
      checkItemOpDestination(
        d,
        cred(bob.id),
        op,
        new Set(["proj-created-in-push"]),
      ),
      "missing-parent",
    );
  });
});

// ─── owner-only onward sharing ────────────────────────────────────────────────

describe("owner-only onward sharing", () => {
  test("a non-owner sharee cannot grant a third party access (onward share denied)", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const carol = createUser(d, { username: "carol" });
    const it = createItem(d, DEV, { title: "t", ownerId: alice.id });
    shareItem(d, DEV, it.id, bob.id, "write");

    const op = {
      id: "s1",
      entity: "share",
      row_id: shareRowId(it.id, carol.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, carol.id),
        item_id: it.id,
        user_id: carol.id,
        permission: "write",
      },
    };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor(bob.id), op),
      null,
      "non-owner onward share dropped",
    );
  });

  test("a write-sharee replicating their own grant onto a just-created recurring spawn is allowed", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const spawn = createItem(d, DEV, { title: "spawn", ownerId: alice.id }); // owned by series owner
    const op = {
      id: "s2",
      entity: "share",
      row_id: shareRowId(spawn.id, bob.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(spawn.id, bob.id),
        item_id: spawn.id,
        user_id: bob.id,
        permission: "write",
      },
    };
    const kept = validateRecordOp(
      d,
      sessionCredentialFor(bob.id),
      op,
      new Set([spawn.id]),
    );
    assert.ok(kept, "self-grant onto just-created spawn kept");
  });

  test("a non-owner may remove their own grant (but not upgrade it)", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const it = createItem(d, DEV, { title: "t", ownerId: alice.id });
    shareItem(d, DEV, it.id, bob.id, "write");

    const remove = {
      id: "s3",
      entity: "share",
      row_id: shareRowId(it.id, bob.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, bob.id),
        item_id: it.id,
        user_id: bob.id,
        deleted: true,
      },
    };
    assert.ok(
      validateRecordOp(d, sessionCredentialFor(bob.id), remove),
      "own grant removal kept",
    );
  });

  // ── Parent-confirmed condition 1: a sharee's self-revoke touches ONLY their own grant row.
  test("a sharee cannot revoke or touch ANOTHER grantee’s share row (self-revoke is own-row only)", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const carol = createUser(d, { username: "carol" });
    const it = createItem(d, DEV, { title: "t", ownerId: alice.id });
    shareItem(d, DEV, it.id, bob.id, "write");
    shareItem(d, DEV, it.id, carol.id, "write");

    // bob targeting carol's grant row (even as a removal) → denied.
    const touchCarol = {
      id: "s4",
      entity: "share",
      row_id: shareRowId(it.id, carol.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, carol.id),
        item_id: it.id,
        user_id: carol.id,
        deleted: true,
      },
    };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor(bob.id), touchCarol),
      null,
      "another grantee's row is denied",
    );
    // bob removing his OWN grant row → allowed.
    const selfRevoke = {
      id: "s5",
      entity: "share",
      row_id: shareRowId(it.id, bob.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, bob.id),
        item_id: it.id,
        user_id: bob.id,
        deleted: true,
      },
    };
    assert.ok(
      validateRecordOp(d, sessionCredentialFor(bob.id), selfRevoke),
      "own-row self-revoke kept",
    );
  });

  // ── Parent-confirmed condition 2: a sharee may not grant, or change a grant's level/grantee;
  //    only the item owner may.
  test("a sharee cannot change a grant’s level (permission) — only the owner can", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const carol = createUser(d, { username: "carol" });
    const it = createItem(d, DEV, { title: "t", ownerId: alice.id });
    shareItem(d, DEV, it.id, bob.id, "read");
    shareItem(d, DEV, it.id, carol.id, "read");

    // bob escalating carol's grant read->write → denied.
    const escalateOther = {
      id: "s6",
      entity: "share",
      row_id: shareRowId(it.id, carol.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, carol.id),
        item_id: it.id,
        user_id: carol.id,
        permission: "write",
      },
    };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor(bob.id), escalateOther),
      null,
      "sharee cannot change another grant’s level",
    );
    // bob upgrading his OWN grant read->write → denied (a sharee may only remove their own grant).
    const upgradeSelf = {
      id: "s7",
      entity: "share",
      row_id: shareRowId(it.id, bob.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, bob.id),
        item_id: it.id,
        user_id: bob.id,
        permission: "write",
      },
    };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor(bob.id), upgradeSelf),
      null,
      "sharee cannot upgrade their own grant",
    );
    // the OWNER may change carol's grant level.
    const ownerEscalate = {
      id: "s8",
      entity: "share",
      row_id: shareRowId(it.id, carol.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, carol.id),
        item_id: it.id,
        user_id: carol.id,
        permission: "write",
      },
    };
    assert.ok(
      validateRecordOp(d, sessionCredentialFor(alice.id), ownerEscalate),
      "owner may change a grant’s level",
    );
  });

  test("a sharee cannot reassign a grant’s grantee (immutable identity mismatch)", () => {
    const d = db();
    const alice = createUser(d, { username: "alice" });
    const bob = createUser(d, { username: "bob" });
    const carol = createUser(d, { username: "carol" });
    const it = createItem(d, DEV, { title: "t", ownerId: alice.id });
    shareItem(d, DEV, it.id, bob.id, "write");

    // bob pushes carol's grant row (row_id encodes carol) but data.user_id claims bob →
    // the immutable user_id disagrees with the existing row → denied.
    const reassign = {
      id: "s9",
      entity: "share",
      row_id: shareRowId(it.id, carol.id),
      ts: NOW,
      device_id: "dev",
      data: {
        id: shareRowId(it.id, carol.id),
        item_id: it.id,
        user_id: bob.id,
        permission: "write",
      },
    };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor(bob.id), reassign),
      null,
      "grantee identity is immutable",
    );
  });
});

test("record identity collisions cannot tombstone attachments or overwrite another user plan/time log", async () => {
  const { upsertAttachment, upsertTimeLog, upsertPlan } =
    await import("@carbon/core");
  const d = db();
  const foreign = createItem(d, DEV, { title: "foreign", ownerId: "alice" });
  const own = createItem(d, DEV, { title: "own", ownerId: "bob" });
  const stamp = new Date().toISOString();
  const attachment = {
    id: "attachment",
    parent_type: "item" as const,
    parent_id: foreign.id,
    item_id: foreign.id,
    hash: "a".repeat(64),
    filename: "secret",
    mime_type: null,
    size: 0,
    created_by: "alice",
    created_at: stamp,
    deleted: false,
  };
  const time = {
    id: "time",
    item_id: foreign.id,
    user_id: "alice",
    start_time: stamp,
    end_time: null,
    note: "private",
    created_at: stamp,
    updated_at: stamp,
    kind: "task" as const,
    session_id: null,
    deleted: false,
  };
  const plan = {
    id: "plan",
    item_id: foreign.id,
    user_id: "alice",
    added_at: stamp,
    deleted: false,
  };
  upsertAttachment(d, attachment);
  upsertTimeLog(d, time);
  upsertPlan(d, plan);
  for (const [entity, data] of [
    ["attachment", attachment],
    ["timelog", time],
    ["plan", plan],
  ] as const) {
    const forged = { ...data, item_id: own.id, user_id: "bob", deleted: true };
    assert.equal(
      validateRecordOp(d, sessionCredentialFor("bob"), {
        id: `op-${entity}`,
        entity,
        row_id: data.id,
        ts: NOW,
        device_id: DEV,
        data: forged,
      }),
      null,
    );
  }
  const comment = addComment(d, DEV, {
    itemId: foreign.id,
    authorId: "alice",
    body: "private",
  });
  assert.equal(
    validateRecordOp(d, sessionCredentialFor("bob"), {
      id: "mismatch",
      entity: "comment",
      row_id: "innocent",
      ts: NOW,
      device_id: DEV,
      data: { ...comment, item_id: own.id },
    }),
    null,
  );
  const { validateRecordOps } = await import("./authorize");
  const other = createItem(d, DEV, { title: "other", ownerId: "bob" });
  const first = {
    id: "first",
    entity: "comment",
    row_id: "new-comment",
    ts: NOW,
    device_id: DEV,
    data: { ...comment, id: "new-comment", item_id: own.id, author_id: "bob" },
  };
  const second = {
    ...first,
    id: "second",
    data: { ...first.data, item_id: other.id },
  };
  assert.deepEqual(
    validateRecordOps(d, sessionCredentialFor("bob"), [first, second]).map(
      (o) => o.id,
    ),
    ["first"],
  );
});
