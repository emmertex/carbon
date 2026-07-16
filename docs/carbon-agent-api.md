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
permissioned. **Save it**, and configure your skill with:

- `CARBON_URL` — base URL with workspace subdomain (e.g. `https://my.carbon.etx.sx`), or `https://carbon.etx.sx` for self-hosted without subdomains
- `CARBON_TOKEN` — the issued agent token

> You _can_ instead use a human's token (e.g. your Home Assistant token). It works,
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

- **Read**: a bot may read _all_ tasks.
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
  "event": "mention", // "mention" | "assigned" | "test"
  "agent": "Hermes", // the agent's display name
  "instructions": "…", // the agent's configured instructions, if any (optional)
  "task": {
    "id": "f3a1…", // task id — use this in the REST calls below
    "title": "Book campsite",
    "note": "Prefer riverside, need a vehicle pass.",
    "status": "active", // active | done | dropped
    "due_date": "2026-07-10T00:00:00Z", // ISO-8601 or null
  },
  "comments": [
    // full thread, oldest first
    {
      "author": "andrew",
      "body": "We are going the second week of July.",
      "created_at": "…",
    },
    {
      "author": "andrew",
      "body": "@hermes what should we do here?",
      "created_at": "…",
    },
  ],
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

### Reply with a comment ★ the main one

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

## 6. Natural-language agent API (`/api/agent/*`)

A second, **granular** surface designed for a _small_ LLM (e.g. Qwen 2.5 1.5B) to drive
natural-language task management — "add milk and eggs to my shopping list", "mark off
bread and milk", "what do I need at Coles?". The model can't reliably fuzzy-match names
or hold big contexts, so the **server does the matching and batching** and responses are
**minimal by default**.

> The in-app **Add box** and the built-in **[Telegram bot](telegram-bot.md)** both drive this
> same tool layer server-side (you don't call these endpoints yourself for those) — the bot just
> runs it in a conversational mode. This section documents the HTTP surface for _your own_ skill.

Same auth/scopes as the rest of the API (`tasks:read` for reads, `inbox:write` to create,
`tasks:write` to complete/update). This is a **personal-assistant surface**: use a token
that _acts as the user_ (a human's token, a per-user token, or open mode). Writes are gated
per item by the normal rule — a user can act on their own tasks; a pure bot token is still
limited to tasks assigned to it. Batch ops never fail the whole request for one bad item;
the failure is reported under `unmatched`.

> **Names, not ids.** Every `list`/`tag`/`task` field accepts a plain name and is resolved
> by fuzzy match (typos, word order, path leaf). Pass `{ "id": "…" }` for a list only when
> you already have one.

### Read (small payloads)

```
GET /api/agent/lists                 → { lists: [{ id, name }] }            (?detail=1 adds open_count)
GET /api/agent/tags                  → { tags: [{ id, name, hasGeo }] }     (?detail=1 adds color/status/geo)
GET /api/agent/items?list=&tag=&q=&status=active&limit=50
                                     → { items: [{ id, title, tags:[names], done }] }   (?detail=1 expands)
GET /api/agent/items/{id}            → full item + { tags, list }
POST /api/agent/resolve  { kind:"list"|"tag"|"task", q, list? }
                                     → { candidates:[{id,name,score,reason}], best:{id,confident} }
POST /api/agent/filter   { text:"due tomorrow and flagged" }
                                     → { expr: FilterExpr }   // NL → advanced filter expression
POST /api/agent/geocode  { q:"coles", near:{lat,lng} }
                                     → { candidates:[{lat,lng,radius,label}] }
```

`status` is `active` (default), `done`, or `all`. `resolve` is the workhorse: call it when a
name is uncertain — if `best.confident` is false, ask the user rather than guess.

### Write (batch)

```
POST /api/agent/tasks/batch
{ "list":"shopping list", "titles":["milk","eggs"],
  "tags":["coles"],                       // optional, applied to all created tasks
  "create_list_if_missing":true,          // default true
  "create_tags_if_missing":true }         // default true
→ 201 { list:{id,name,created}, tags:[{id,name,created}], created:[{id,title}] }
```

Resolves (or creates) the list and tags once, then creates the tasks under the list. Use
`tasks:[{title,note,due_date,defer_date,reminder_at,recurrence,estimate_minutes,flagged,priority,tags}]`
instead of `titles` for per-task fields (`due_date`/`defer_date`/`reminder_at` are ISO datetimes;
`recurrence` is the rule object below). A task's **location comes from its tag** (precedence
task > tag > project), so "remind me at Coles" = add the task with `tags:["coles"]` and give the
`coles` tag a geo.

**Scheduling fields.** A specific event time → `due_date`. "Remind me N before" → `reminder_at`
(= due − N; it fires on its own, a due date isn't required). Repeats → `recurrence`, a rule object:
`{ "type":"daily"|"weekly"|"monthly"|"yearly", "interval":1, "daysOfWeek":[0-6 Sun-Sat]?, "dayOfMonth":1-31? }`
— e.g. weekly on Tuesday is `{ "type":"weekly", "interval":1, "daysOfWeek":[2] }`. On completion the
next occurrence carries the same defer/due/reminder offsets forward automatically.

```
POST /api/agent/tasks/complete
{ "queries":["bread","milk"], "list":"shopping list", "done":true }   // and/or "ids":[...]
→ { matched:[{query,id,title}], unmatched:[{query, reason:"no_match"|"ambiguous"|"forbidden"}] }
```

Tick off by fuzzy query and/or id. **Report the envelope back to the user verbatim** —
"marked off milk, couldn't find bread". Unmatched queries do nothing. Re-opening (`done:false`)
searches completed tasks automatically; pass `include_done:true` to reach a finished task in any
other call.

```
POST /api/agent/tasks/tag
{ "list":"shopping list", "add":["woolworths"], "remove":[] }   // tag EVERY task in the list
   # or target specific tasks:  { "queries":["milk","bread"], "add":["woolworths"] }
   # or tasks already carrying a tag:  { "tag":"coles", "add":["sale"] }
→ { updated:[{id,title}], tags_added:[names], tags_removed:[names], unmatched:[...] }
```

Bulk add/remove tags on existing tasks. The server enumerates the targets, so a caller (or
LLM) never has to list the items first — "add the woolworths tag to everything in the shopping
list" is one call. Missing add-tags are created (unless `create_tags_if_missing:false`).

```
POST /api/agent/tasks/update
{ "updates":[ { "query":"milk", "list":"shopping", "patch":{ "flagged":true, "due_date":"2026-07-01" } } ],
  "include_done":false }
→ { matched:[...], unmatched:[...] }
```

Patch fields: `title, note, due_date, defer_date, reminder_at` (ISO), `recurrence` (rule object, or
`null` to clear), `estimate_minutes, flagged, priority, status` ("active"|"done"|"dropped"). Set
`include_done:true` to match an already-completed task.

```
POST /api/agent/tags/geo
{ "tag":"coles", "geo":{ "lat":-37.81, "lng":145.01, "radius":200, "label":"Coles Camberwell" } }
   # or:  { "tag":"coles", "near_name":"coles", "near":{ "lat":-37.8, "lng":145.0 } }   (geocoded)
   # or:  { "tag":"coles", "geo":null }                                                 (clear)
→ { tag:{id,name}, geo:GeoReminder|null, source:"explicit"|"geocoded" }
```

Stamps a geofence on a tag so location reminders fire. `near_name` resolves the nearest
matching place to `near` via the geocoder (see env below); if geocoding is disabled or finds
nothing it returns `400` and you should pass explicit coords.

### Geo query

```
GET /api/agent/nearby?tag=coles               → { items:[{id,title,tags}] }
GET /api/agent/nearby?lat=&lng=[&near_name=]   → tasks whose location (task/tag/project) matches the point
GET /api/agent/nearby?zone=Home               → tasks whose location label matches an HA zone
```

### People, sharing & assigning

```
GET  /api/agent/users                → { users:[{ id, name, username }] }
```

The people a task can be shared with or assigned to. Call it when you're unsure a name exists.
**Bots are not listed** — you can't share or assign to a bot through this API.

```
POST /api/agent/tasks/share
{ "query":"plan trip", "users":["Rachel"], "permission":"write" }   // permission default "write"
   # target instead with "queries":[...] / "ids":[...] / a whole "list" or "tag"
   # "remove":true unshares
→ { updated:[{id,title}], users:[{id,name}], unknown_users:[names], permission, removed, unmatched:[...] }

POST /api/agent/tasks/assign
{ "query":"book flights", "users":["Rachel"] }                      // "remove":true unassigns
→ { updated:[{id,title}], users:[{id,name}], unknown_users:[names], removed, unmatched:[...] }
```

Share grants a user access; assign makes them responsible — and also grants access (a write
share) if the assignee doesn't already have any. Both resolve people by name (fuzzy) and
are **write-gated** — you can only share/assign a task you own or have write access to; anything you
can't is reported under `unmatched` with `reason:"forbidden"`.

### Time tracking (v2 sessions)

```
GET  /api/agent/timer                                              → { session, task, paused, pause_ends_at, suspended }
GET  /api/agent/timer/sessions?from=&to=                           → { from, to, sessions:[{session,segments,pauses,completions,notes,…}] }
POST /api/agent/timer/start  { "query":"write report" }            → { started, stopped, context }
POST /api/agent/timer/start  { "query":"Work", "project":true }    → project session (no task segment)
POST /api/agent/timer/stop   { }                                   → { stopped, context }
POST /api/agent/timer/pause  { "minutes":10 }                      → pause now (omit minutes = indefinite)
POST /api/agent/timer/pause  { "minutes":5, "before":true }        → retroactive pause of last N minutes
POST /api/agent/timer/resume { }                                   → resume from break pause
POST /api/agent/timer/resume { "session_id":"…" }                  → resume a parked session
POST /api/agent/timer/note   { "title":"Traffic", "metadata":{…} } → { note, log, context }
DELETE /api/agent/timer/notes/:logId?mode=reference|note           → unlink only, or also delete the note item
```

Starting a task parks any other open project session (reported under `stopped` when a prior
task/project was active). Time notes are real `type:'note'` items nested under the tracked
task (or the project root when only a session is running), plus a zero-duration marker in
the block. `metadata` is arbitrary JSON stored on the note item.

### Worked sequences (canonical utterances)

- **"Add milk and eggs to my shopping list."** → `POST /tasks/batch {list:"shopping list", titles:["milk","eggs"]}`.
- **"Remind me to get bread next time I'm at Coles."** → `POST /tasks/batch {list:"shopping", tags:["coles"], titles:["bread"]}` (+ once: `POST /tags/geo {tag:"coles", near_name:"coles", near:{lat,lng}}` to locate it).
- **"Mark off bread and milk."** → `POST /tasks/complete {queries:["bread","milk"]}` → tell the user matched vs unmatched.
- **"What did I need at Coles?"** → `GET /nearby?tag=coles`; if empty, say so and show `GET /items?list=shopping`.
- **"Remind me to take my son to swimming every Tuesday at 5pm, an hour before, and share it with Rachel."** →
  `POST /tasks/batch {tasks:[{title:"Take son to swimming", due_date:"2026-07-07T17:00:00Z", reminder_at:"2026-07-07T16:00:00Z", recurrence:{type:"weekly",interval:1,daysOfWeek:[2]}}]}`
  then `POST /tasks/share {query:"Take son to swimming", users:["Rachel"]}`.
- **"Start a timer on the report."** → `POST /timer/start {query:"report"}`; **"add a note: traffic"** → `POST /timer/note {title:"traffic"}`; later **"stop the timer"** → `POST /timer/stop {}`.

### Geocoding env (place lookup for "nearest Coles")

Pluggable, OpenStreetMap by default, all outbound calls go through the SSRF guard.

- `CARBON_GEOCODE_ENABLED` — `1`/`0`. Default **on** for single-tenant self-host, **off** under a base domain.
- `CARBON_NOMINATIM_URL` (default `https://nominatim.openstreetmap.org`), `CARBON_OVERPASS_URL`
  (default `https://overpass-api.de/api/interpreter`) — point at a self-hosted instance to avoid public rate limits.
- `CARBON_GEOCODE_UA` — the `User-Agent` sent (Nominatim's usage policy requires one).
- `CARBON_GEOCODE_RADIUS_M` — brand-search radius (default 5000 m).

A refined system prompt tuned for a 1.5B model lives in
[`hermes.md`](hermes.md#natural-language-flows) (`SYSTEM_PROMPT` in `agent-command.ts`).

## 7. Quick check (curl)

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
