# Carbon Agent API — building a Hermes / OpenClaw skill

This document describes everything an agentic framework (Hermes, OpenClaw, …) needs
to integrate with **Carbon**, a self-hosted task manager. It covers (1) the **trigger
webhook** Carbon sends you, and (2) the **REST API** you call back to read tasks,
reply with comments, attach files, and complete tasks.

The flow:

```
A user @mentions or assigns your bot on a task
        │
        ▼
Carbon  ──POST {webhook URL}──►  your agent     (the trigger; respond 200 fast)
                                     │
                                     │  do your work (LLM, HA, KB, …)
                                     ▼
your agent  ──REST (Bearer token)──► Carbon      (comment / complete / attach)
```

---

## 1. Setup (done in Carbon, once)

In **Settings → AI agents** create an agent of kind **Agentic webhook
(Hermes / OpenClaw)**:

- **Username** — e.g. `hermes`. Users trigger you with `@hermes`.
- **Webhook URL** — the endpoint on your side Carbon will POST triggers to.
- **Shared secret** (optional) — Carbon sends it as the `x-carbon-secret` header so
  you can verify the call is genuinely from Carbon.

On creation Carbon issues a **one-time API token** (shown once). This token belongs
to the bot user, so anything you post appears authored by the bot and is correctly
permissioned. **Save it** and configure your skill with:

- `CARBON_URL` — base URL, e.g. `https://carbon.etx.sx`
- `CARBON_TOKEN` — the issued agent token

> You *can* instead use a human's token (e.g. your Home Assistant token). It works,
> but replies will be authored by **that user**, not the bot, and bot scoping won't
> apply. Prefer the agent token.

---

## 2. Authentication

All REST calls use a bearer token:

```
Authorization: Bearer <CARBON_TOKEN>
Content-Type: application/json
```

Tokens carry scopes: `tasks:read`, `tasks:write`, `inbox:write` (the agent token has
all three). Tokens can never access admin endpoints.

**Bot permissions** (enforced server-side):
- **Read**: a bot may read *all* tasks.
- **Comment / attach**: only on tasks where the bot is **assigned** or **@mentioned**.
- **Complete**: only tasks **assigned** to the bot.

---

## 3. The trigger webhook (Carbon → your agent)

When your bot is @mentioned in a comment or assigned a task, Carbon sends:

```
POST <your webhook URL>
x-carbon-secret: <secret>        # only if you configured one
Content-Type: application/json
```

```jsonc
{
  "event": "mention",            // "mention" | "assigned" | "test"
  "agent": "Hermes",             // the agent's display name
  "instructions": "…",           // the agent's configured instructions, if any (optional)
  "task": {
    "id": "f3a1…",               // task id — use this in the REST calls below
    "title": "Book campsite",
    "note": "Prefer riverside, need a vehicle pass.",
    "status": "active",          // active | done | dropped
    "due_date": "2026-07-10T00:00:00Z"   // ISO-8601 or null
  },
  "comments": [                  // full thread, oldest first
    { "author": "andrew", "body": "We are going the second week of July.", "created_at": "…" },
    { "author": "andrew", "body": "@hermes what should we do here?", "created_at": "…" }
  ]
}
```

- For `event: "mention"`, the **last comment** in `comments` is the one that tagged
  you — reply to it.
- For `event: "assigned"`, you've been put on the task; help complete it and, when
  done, call the complete endpoint.
- `event: "test"` is sent by the **Test** button — it has no `task`/`comments`;
  just return `200`.

**Respond `200` immediately** and do your work asynchronously. Carbon only checks
that the webhook was reachable; it does not read your response body. (A non-2xx
makes Carbon post an error comment on the task.) You deliver results by calling the
REST API below.

---

## 4. REST API (your agent → Carbon)

Base path is `<CARBON_URL>/api`. All examples assume the `Authorization` and
`Content-Type` headers from §2.

### Reply with a comment  ★ the main one
```
POST /api/tasks/{id}/comments
{ "body": "I'd reserve the riverside loop for 6–13 Jul and add a vehicle pass." }
→ 201  { id, item_id, author_id, body, created_at, … }
```
Markdown is allowed in `body`, including links and images:
`![chart](https://…/chart.png)` / `[booking](https://…)`. The comment syncs to all
clients on the task.

### Complete an assigned task
```
POST /api/tasks/{id}/complete          # ?done=false to re-open
→ 200  { …task, "status": "done" }
```

### Read a task (full context)
```
GET /api/tasks/{id}
→ 200  { id, title, note, status, priority, due_date, defer_date, parent_id, … }
```

### List / search tasks
```
GET /api/tasks?perspective=today        # inbox | today | flagged   (optional)
GET /api/tasks?project={id}             # children of a project     (optional)
GET /api/tasks?status=active            # active | done | dropped   (optional)
→ 200  { "tasks": [ …Item ] }
```
(Bots see all tasks here; humans see only what they own or are shared on.)

### Create a task (e.g. follow-up)
```
POST /api/tasks
{ "title": "Confirm vehicle pass", "note": "…", "project_id": "…",
  "due_date": "2026-07-01T00:00:00Z", "flagged": false, "priority": 2 }
→ 201  { …Item }
```

### Update a task
```
PATCH /api/tasks/{id}
{ "title": "…", "note": "…", "status": "active", "due_date": "…",
  "defer_date": "…", "flagged": true, "priority": 3, "parent_id": "…" }
→ 200  { …Item }
```

### Attach a file (optional)
Two steps — upload the bytes by content hash, then attach the metadata:
```
# 1) sha256 the file, upload it (idempotent; skipped if already present)
POST /api/blobs/{sha256hex}        body: raw file bytes
→ 200  { "ok": true }

# 2) attach it to the task
POST /api/tasks/{id}/attachments
{ "filename": "quote.pdf", "mimeType": "application/pdf", "size": 18234, "hash": "{sha256hex}" }
→ 201  { …attachment }
```
Image attachments render inline in Carbon. To download a blob:
`GET /api/blobs/{sha256hex}` (returns the bytes).

### Identity / health
```
GET  /api/me        → who the token authenticates as { id, username, role, is_bot, … }
GET  /api/health    → { status: "ok", version }  (no auth)
```

---

## 5. Suggested skill behaviour

```text
on POST <webhook>:
    verify x-carbon-secret (if set); respond 200 immediately
    if event == "test": stop
    ctx = payload.task + payload.comments   # everything you need is here
    result = <run your agent: reason over ctx, use tools, etc.>
    POST /api/tasks/{task.id}/comments  { body: result.text }
    if event == "assigned" and result.finished:
        POST /api/tasks/{task.id}/complete
    # optional: attach files, create follow-up tasks
```

Notes:
- You usually don't need extra reads — the webhook payload already contains the task
  and the whole comment thread. Use `GET /api/tasks…` only for broader context.
- Keep replies focused; they appear in a shared comment thread.
- Errors: a `403` on comment/complete means the bot isn't assigned/@mentioned on
  that task (expected if a trigger was stale); `401` means a bad/expired token.

---

## 6. Quick check (curl)

```bash
CARBON_URL=https://carbon.etx.sx
TOKEN=carbon_xxx
# who am I
curl -s "$CARBON_URL/api/me" -H "Authorization: Bearer $TOKEN"
# reply on a task you were mentioned in
curl -s -X POST "$CARBON_URL/api/tasks/<id>/comments" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"On it — proposed plan below."}'
```
