# Carbon REST API guide

Carbon exposes a small REST API for integrations (Home Assistant, scripts, agents). It is
the **same surface** that the AI-agent webhook flow calls back into — for the agent-specific
trigger contract see [`carbon-agent-api.md`](carbon-agent-api.md); for Home Assistant
recipes see [`home-assistant.md`](home-assistant.md).

> Everything you write through the API becomes ordinary ops and **syncs to every client**
> like any other edit.

## Base URL & multi-tenancy

- **Single-tenant / self-host:** the base is your server origin, e.g.
  `https://carbon.etx.sx`. All routes below are under `/api`.
- **Multi-tenant hosting:** each workspace is a subdomain — `https://<tenant>.carbon.etx.sx`.
  Use the tenant subdomain as the base; the API is identical per tenant.

## Authentication

| Method             | Header                                     | Who                | Scopes             |
| ------------------ | ------------------------------------------ | ------------------ | ------------------ |
| **Session Bearer** | `Authorization: Bearer carbons_xxx`        | signed-in humans   | all scopes         |
| **API token**      | `Authorization: Bearer carbon_xxx`         | integrations, bots | the token's scopes |
| **Basic auth**     | `Authorization: Basic base64(user:pass)`   | **`POST /api/login` only** | starts MFA / session |

Human API access uses a **session token** minted after password + 2FA (or a trusted
device). Basic auth is **not** accepted on sync/admin/task routes — that would bypass
2FA. Create integration tokens in **Settings → API tokens** (admin only). A token
**acts as its owning user** and is limited to its scopes.

**Open mode** (zero users → synthetic `local` admin, no credentials) is **off by
default**. Set `ALLOW_OPEN_MODE=1` only for a private LAN / first-run box — never on
anything internet-facing. It is ignored when `BASE_DOMAIN` is set.

### Sign-in + 2FA

1. `POST /api/login` with Basic + JSON `{ device_id, device_name?, device_token? }`.
2. Response is one of:
   - `{ token, user, device_token }` — device trusted (or open mode `{ open: true }` when enabled)
   - `{ status: "needs_enrollment", challenge }` — set up email and/or authenticator
   - `{ status: "needs_2fa", challenge, factors }` — verify with TOTP, email OTC, or recovery code
     (`factors` are booleans only; the profile is omitted until MFA completes)
3. Challenge endpoints under `/api/mfa/*` use `Authorization: Bearer mfac_…`.
4. Successful enroll/verify returns a `carbons_…` session and trusts `device_id` forever
   until the user, a tenant admin, or `npm run mfa-admin` resets trust.

**`device_token` (`carbond_…`) is what skips 2FA — not `device_id`.** The id is a public
label (the owner sees it in Settings, and it rides along in location reports); the token is
a server-issued secret, stored hashed, and **rotated on every login**: each response that
trusts the device carries the replacement, which the client must persist in place of the
old one. A client that omits it, or sends a stale one, just gets `needs_2fa` — the previous
token stays usable for a few minutes so a login whose response was lost can retry. After a
handful of bad tokens the shortcut closes for that account for 15 minutes (`DEVICE_TRUST_FAIL_MAX`,
default 5); 2FA still works throughout. Trusts created before device tokens existed no
longer skip 2FA — the device re-verifies once and is issued a token.

### Scopes

- `tasks:read` — read tasks.
- `tasks:write` — edit / complete tasks, comment, attach.
- `inbox:write` — create new tasks (drop into inbox). The narrowest useful scope for a
  one-way "capture" integration like an HA automation.

Admin-only routes (`/api/admin/*`) reject API tokens — they require a human **session**
from a tenant `admin` (`requireAdmin`). `/host/tenants/*` is separate: it's the host
operator's control plane, gated by its own `host_admins` basic-auth table, not a tenant
admin account. `/host/signup/*` and `/host/delete/*` are public (rate-limited, email +
one-time code).

## Task endpoints

```bash
# Read tasks. ?perspective=inbox|today|flagged  | ?project=<id> | ?status=active
curl -H "Authorization: Bearer carbon_xxx" \
  "$BASE/api/tasks?perspective=today"

# Create a task (inbox:write). Accepts: title (required), note, project_id, due_date, flagged, priority.
curl -X POST "$BASE/api/tasks" \
  -H "Authorization: Bearer carbon_xxx" -H "Content-Type: application/json" \
  -d '{"title":"Front door battery low","due_date":"2026-06-25T20:00:00Z","priority":3}'

# Read one task
curl -H "Authorization: Bearer carbon_xxx" "$BASE/api/tasks/<id>"

# Update fields (tasks:write)
curl -X PATCH "$BASE/api/tasks/<id>" \
  -H "Authorization: Bearer carbon_xxx" -H "Content-Type: application/json" \
  -d '{"flagged":true,"note":"call first"}'

# Complete (tasks:write) — honours recurrence (spawns the next occurrence)
curl -X POST "$BASE/api/tasks/<id>/complete" -H "Authorization: Bearer carbon_xxx"

# Comment (tasks:write) — body + optional @mentions trigger bot agents
curl -X POST "$BASE/api/tasks/<id>/comments" \
  -H "Authorization: Bearer carbon_xxx" -H "Content-Type: application/json" \
  -d '{"body":"done — see photo"}'

# Attach a file (tasks:write) — two-step content-addressed upload
HASH="$(sha256sum photo.jpg | awk '{print $1}')"

# 1) Upload bytes by hash (idempotent)
curl -X POST "$BASE/api/blobs/$HASH" \
  -H "Authorization: Bearer carbon_xxx" \
  --data-binary "@photo.jpg"

# 2) Attach metadata to the task
curl -X POST "$BASE/api/tasks/<id>/attachments" \
  -H "Authorization: Bearer carbon_xxx" -H "Content-Type: application/json" \
  -d "{\"filename\":\"photo.jpg\",\"mimeType\":\"image/jpeg\",\"size\":12345,\"hash\":\"$HASH\"}"
```

`POST /api/tasks` currently accepts `title` (required), plus `note`, `project_id`, `due_date`,
`flagged`, `priority`, and `metadata` (arbitrary JSON object or string). `PATCH /api/tasks/:id`
accepts `title`, `note`, `status`, `due_date`, `defer_date`, `flagged`, `priority`, `parent_id`,
`geo`, `color`, `recurrence`, `review_interval`, and `metadata`.

## Natural-language agent endpoints (`/api/agent/*`)

A granular, context-small surface for a **small LLM** (driven via Hermes) to do
natural-language task management — the server fuzzy-matches names and batches writes so the
model just passes plain names. Same scopes as above. Full contract + worked call sequences:
[`carbon-agent-api.md` §6](carbon-agent-api.md).

| Method    | Path                        | Scope         | Purpose                                                                                  |
| --------- | --------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| GET       | `/api/agent/lists`          | `tasks:read`  | Projects as `{id,name}` (`?detail=1` adds counts)                                        |
| GET       | `/api/agent/tags`           | `tasks:read`  | Tags as `{id,name,hasGeo}`                                                               |
| GET       | `/api/agent/items`          | `tasks:read`  | Minimal `{id,title,tags,done}`; filter `?list=&tag=&q=&status=`                          |
| GET       | `/api/agent/items/:id`      | `tasks:read`  | One item + tags + list                                                                   |
| POST      | `/api/agent/resolve`        | `tasks:read`  | Fuzzy-resolve a `list`/`tag`/`task` name → ranked candidates                             |
| POST      | `/api/agent/tasks/batch`    | `inbox:write` | Create many tasks; resolve/create list + tags by name                                    |
| POST      | `/api/agent/tasks/complete` | `tasks:write` | Complete by id/fuzzy query → `{matched,unmatched}`                                       |
| POST      | `/api/agent/tasks/update`   | `tasks:write` | Batch patch by id/query (note, flag, priority, due/defer/reminder, `recurrence`, status) |
| POST      | `/api/agent/tasks/tag`      | `tasks:write` | Bulk add/remove tags on a list/tag/queries                                               |
| POST      | `/api/agent/tags/geo`       | `tasks:write` | Set/clear a tag's geofence (explicit or geocoded)                                        |
| GET       | `/api/agent/nearby`         | `tasks:read`  | Tasks by `tag`/`zone`/`lat`+`lng`                                                        |
| GET       | `/api/agent/users`          | `tasks:read`  | People a task can be shared with / assigned to (non-bot)                                 |
| POST      | `/api/agent/tasks/share`    | `tasks:write` | Share task(s) with users by name (`remove` to unshare)                                   |
| POST      | `/api/agent/tasks/assign`   | `tasks:write` | Assign task(s) to users by name (`remove` to unassign)                                   |
| GET       | `/api/agent/timer`          | `tasks:read`  | Active session context (`session`, `task`, `paused`, `suspended`)                |
| GET       | `/api/agent/timer/sessions` | `tasks:read`  | Session blocks in a date range (`?from=`/`?to=`, default last 7 days)            |
| POST      | `/api/agent/timer/start`    | `tasks:write` | Start a v2 task/project session (`id`/`query`, optional `project:true`)          |
| POST      | `/api/agent/timer/stop`     | `tasks:write` | Stop the active session                                                          |
| POST      | `/api/agent/timer/pause`    | `tasks:write` | Pause now (`minutes`) or retroactively (`before:true`)                           |
| POST      | `/api/agent/timer/resume`   | `tasks:write` | Resume break pause, or a parked session via `session_id`                         |
| POST      | `/api/agent/timer/note`     | `tasks:write` | Add a time note (`title`, optional `body`/`metadata`) to the active session      |
| DELETE    | `/api/agent/timer/notes/:id`| `tasks:write` | Remove a time-note marker (`?mode=reference\|note`)                              |
| GET       | `/api/agent/config`         | `tasks:read`  | `{enabled, keywords}` — drives the in-app Add box                                        |
| POST      | `/api/agent/command`        | `inbox:write` | Run an in-app NL command (LLM tool-loop, acts as the user) → `{reply, executed, usage}`  |
| POST      | `/api/agent/filter`         | `tasks:read`  | NL → advanced-filter expression builder (`{expr}`)                                       |
| POST      | `/api/agent/geocode`        | `tasks:read`  | Place lookup helper for location inputs (`{candidates}`)                                 |
| GET/PATCH | `/api/admin/nl-settings`    | admin         | Pick the NL agent, keyword list, enable flag                                             |
| GET       | `/api/admin/nl-usage`       | admin         | Aggregate token usage by request kind                                                    |

**In-app NL commands (Stage 2):** when the Add box's first word matches a configured keyword
(default `can, add, check off, mark off, mark as`), the entry posts to `/api/agent/command`
instead of creating a literal task. The server runs the chosen direct-LLM agent in a tool loop
(executing the `/api/agent/*` operations in-process), builds the reply from the results, tracks
token usage, and the new/changed items sync back. Configure it in **Settings → Natural-language
commands**.

Geocoding for "nearest Coles" is pluggable (OpenStreetMap by default) and configured with
`CARBON_GEOCODE_ENABLED` (on for single-tenant self-host, off under a base domain),
`CARBON_NOMINATIM_URL`, `CARBON_OVERPASS_URL`, `CARBON_GEOCODE_UA`, `CARBON_GEOCODE_RADIUS_M`.

## Location / geofence endpoints

```bash
# HA zone enter/leave → fire location reminders (tasks:write)
curl -X POST "$BASE/api/geo/event" \
  -H "Authorization: Bearer carbon_xxx" -H "Content-Type: application/json" \
  -d '{"person":"person.you","zone":"Home","event":"enter"}'

# Raw GPS fix → match location-tagged tasks (tasks:write)
curl -X POST "$BASE/api/gps" \
  -H "Authorization: Bearer carbon_xxx" -H "Content-Type: application/json" \
  -d '{"person":"person.you","lat":-37.81,"lng":144.96}'
```

`person` resolves to a Carbon user via their linked `ha_person` (Settings → HA person);
if omitted, the token's owning user is used. See [`home-assistant.md`](home-assistant.md).

## Push & identity (used by the web client; rarely called directly)

- `GET /api/me` / `PATCH /api/me` — current user; PATCH sets `display_name`,
  planning prefs, `ha_person`.
- `GET /api/users` — public roster projection (no password hashes).
- `GET /api/push/vapid`, `POST /api/push/subscribe|unsubscribe`, `POST /api/push/fcm` —
  Web Push / FCM registration.
- `GET|HEAD|POST /api/blobs/:hash` — content-addressed attachment blobs (sha256 hash).

## Health & host role

`GET /api/health` returns `{ status, version, role, locked, ... }` where `role` ∈
`single | apex | app | tenant | unknown` (drives multi-tenant client routing). No auth.
`expiresAt` is included **only when `locked` is true** (SPA RenewGate); unlocked workspaces
do not disclose subscription end dates.

## Admin & host-control (basic auth, admin only)

- `/api/admin/users` (CRUD), `/api/admin/tokens` (CRUD), `/api/admin/agents` (CRUD + `/test`).
- `/api/billing` (GET status + plans) and `/api/billing/subscribe` (POST `{planId, cardToken,
  email}`) — tenant-admin subscription/renew. Reachable even when the workspace is locked, so an
  admin can self-serve a renewal from the gate.
- `/host/signup/start` + `/host/signup/verify` (public, rate-limited; email + one-time code) and
  `/host/tenants/*` (host-admin, separate `host_admins` basic-auth table) — multi-tenant control
  plane. `PATCH /host/tenants/:id` accepts `{status, plan, expiresAt, locked, blobQuotaMb,
  maxUsers, allowPrivateEndpoints, hostLmAvailable}` (Lock/Unlock + Set-Expiry, plus quota/seat
  caps).

## Security notes

- All API traffic should be served over **HTTPS** — tokens travel in the `Authorization`
  header and must not cross the network in the clear.
- Within a tenant the trust model is "shared workspace": any authenticated member can
  read/write items shared with them per the CRDT. Keep `tasks:write` tokens off untrusted
  automations, and prefer the narrowest scope an integration needs (`inbox:write` for
  capture-only).
- **CORS** defaults to `*` (local/dev). On a hosted `BASE_DOMAIN` deploy set `CORS_ORIGINS`
  to your apex and native-shell origins. Behind a reverse proxy set `TRUST_PROXY=1` so
  per-IP rate limits use the address the proxy appends, not a client-spoofable XFF chain.
- For how tenant data is isolated, encrypted in transit, and kept on-device in local-only
  mode, see [`data-security.md`](data-security.md).
