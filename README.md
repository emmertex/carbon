# Carbon

**1.0** — a self-hosted task manager that's **simple on the surface** (like Todoist /
Microsoft To-Do) and **powerful underneath** (projects, tags/contexts, defer & due dates,
review, recurrence, flags — the OmniFocus toolbox). It runs **fully offline** in the
browser and syncs to your own server whenever it's reachable. No SaaS, no accounts you
don't control. See [CHANGELOG.md](CHANGELOG.md) for what's in this release.

## Architecture

```
packages/core   Pure TypeScript: data model, SQL schema + migrations, the op-log CRDT
                (per-field last-write-wins), and the repository/query API. Shared by web + server.
apps/web        Vite + React PWA. SQLite (sql.js/WASM) in the browser, persisted to IndexedDB.
                Installable, works offline. Also wrapped as Tauri desktop + Capacitor Android.
apps/server     Hono + better-sqlite3. Sync endpoint, REST + agent APIs, CalDAV, push, bots.
                Serves the web build.
```

Both sides speak the same op-log: every change is an op carrying only the fields it touched
(an explicit `null` means "clear this field"). Sync is a rowid-cursor pull, so it's immune to
client clock skew, and merges are deterministic per field.

## Develop

```bash
npm install
npm run dev          # web on :3042, server on :3069 (via turbo)
```

Open http://localhost:3042. The app works with no server configured (local-only). To sync,
open **Settings** and point it at your server URL.

## Self-host (Docker)

```bash
# Optional: require login. Generate a user line and put it in .env as AUTH_USERS=...
npm run add-user -w @carbon/server -- alice 'your-password'

docker compose up -d --build
```

The container serves the web app and the API on port `3069`. Data lives in `./data`.
Leave `AUTH_USERS` empty for an open, single-user LAN instance.

The server runs as the unprivileged `node` user (uid 1000) with a read-only root
filesystem, no capabilities and `no-new-privileges`; `./data` is the only writable path.
That means **`./data` must be owned by uid 1000** — the default for a first user on most
Linux hosts, so a fresh install just works. Two cases need a one-off fix:

```bash
# Upgrading from an older image that ran as root, or a host user whose uid isn't 1000
sudo chown -R 1000:1000 ./data
```

If your host uid genuinely can't be 1000, override the container user instead — add
`user: "<uid>:<gid>"` to the `carbon` service in `docker-compose.yml`.

Passwords set via the API/admin UI use salted scrypt; `AUTH_USERS` (`user:sha256hex`) still
works for bootstrap. Sync accounts require **2FA** (email and/or authenticator); new devices
must verify once and then stay trusted until reset. What makes a device trusted is a secret
the server issues to it and rotates on every login — never its device id, which the owner
can read in Settings. Devices trusted before this existed re-verify once, then hold a secret
like any other. If an admin is locked out:

```bash
npm run mfa-admin -w @carbon/server -- issue-session default alice
npm run mfa-admin -w @carbon/server -- issue-recovery default alice
npm run mfa-admin -w @carbon/server -- reset-mfa default alice
```

Optional env knobs: `BLOB_MAX_MB` (attachment size cap, default 25),
`SIGNUP_GLOBAL_HOUR` (multi-tenant signup ceiling), and `ALLOW_PRIVATE_AGENT_ENDPOINTS=1`
(allow LAN/private agent endpoints when running multi-tenant — on by default for
single-tenant self-host). SMTP (`SMTP_*`) is used for email 2FA codes.

Request bodies are capped so no caller can exhaust host memory: `JSON_BODY_LIMIT_KB`
(ordinary API calls, default 1024), `SYNC_BODY_LIMIT_MB` (a sync push carries an
offline backlog, so it gets its own ceiling — default 16), `MAX_SYNC_BATCH` (ops per
push, default 10000), and `BLOB_MAX_MB` for uploads. Raise them only if a real
workspace hits one.

Run the test suite with `npm test` (no extra deps — uses Node's built-in test runner).

## Integration API (Home Assistant, scripts)

Create an API token in **Settings → API tokens** (admin only). Send it as a bearer
token. The token acts as its owning user and is limited to its scopes
(`tasks:read`, `tasks:write`, `inbox:write`).

```bash
# Drop a task into the inbox (e.g. an HA automation on low battery)
curl -X POST https://carbon.example.com/api/tasks \
  -H "Authorization: Bearer carbon_xxx" -H "Content-Type: application/json" \
  -d '{"title":"Front door sensor battery low","due_date":"2026-06-22T20:00:00Z"}'

# Read tasks (perspective = inbox | today | flagged; or ?project=<id>, ?status=active)
curl -H "Authorization: Bearer carbon_xxx" "https://carbon.example.com/api/tasks?perspective=today"

# Update / complete
curl -X PATCH https://carbon.example.com/api/tasks/<id> \
  -H "Authorization: Bearer carbon_xxx" -H "Content-Type: application/json" -d '{"flagged":true}'
curl -X POST https://carbon.example.com/api/tasks/<id>/complete -H "Authorization: Bearer carbon_xxx"
```

Changes made via the API sync to all clients like any other edit.

## Reminders & location

- **Push reminders** (due/defer): open **Settings → Reminders** and "Enable push
  reminders" (needs a configured server; on real devices the server must be HTTPS).
  The server scans every minute and pushes a notification to the task's owner +
  assignees. VAPID keys auto-generate on first run (override via `VAPID_PUBLIC_KEY`/
  `VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`).
- **Per-task location:** in a task's **Scheduling** section set a place name (matches
  an HA zone) and/or lat/lng + radius ("Use my location" fills coordinates).
- **Foreground geofencing** (this device): toggle in Settings → Reminders. Fires while
  the app is open. (Browsers can't geofence in the background.)
- **Background geofencing via Home Assistant:** link your HA person in Settings, then
  have an HA automation POST on zone enter:

  ```yaml
  # HA automation action — fires a Carbon location reminder when you arrive
  - service: rest_command.carbon_geo   # or a notify/rest call
    # POST https://carbon.example.com/api/geo/event
    #   Authorization: Bearer <token with tasks:write>
    #   {"person":"person.you","zone":"Home","event":"enter"}
  ```

  Carbon matches the user's active tasks whose location label equals the zone (or
  whose coordinates contain the reported lat/lng) and pushes a reminder.

## AI agents

In **Settings → AI agents** (admin) you add a bot user that appears in the roster.
**Assign** a task to it or **@mention** it in a comment to trigger it. Bots can
**read all tasks** but may **comment** only where assigned/@mentioned and
**complete** only tasks assigned to them (and they ignore their own comments — no
loops). Use **Test** to check connectivity and **Edit** (pencil) to change config.
Two kinds:

- **Direct LLM** — `openai` (OpenAI / OpenRouter / LM Studio / any OpenAI-compatible
  endpoint) or `anthropic`. Carbon calls the model and posts the reply. The
  **Endpoint** is the *base URL* that exposes `/chat/completions` — usually ending
  in `/v1` (e.g. `http://10.2.x.x:1234/v1`). Set model, API key, system prompt.

- **Agentic webhook** (Hermes / OpenClaw) — Hermes is a *framework*, not a model, so
  it's configured differently. Carbon **POSTs the trigger** (`event`, task, comment
  thread, your instructions) to the agent's **Webhook URL** (with an optional
  `x-carbon-secret` header), and the framework **acts back via the Carbon REST API**
  using the **token issued once at creation**. So: point its webhook at Carbon's
  trigger, and configure Hermes with the issued token + your Carbon URL; it replies
  with `POST /api/tasks/:id/comments` and finishes with `POST /api/tasks/:id/complete`.
  Full integration reference for building a skill: [`docs/carbon-agent-api.md`](docs/carbon-agent-api.md).

## Status

Shipped: offline core (capture, projects, notes, Today/Inbox/Flagged/Review, tags,
due/defer/flag/priority, recurrence, drag-reorder, themes, sync), multi-user sync
server with optional federation, deep time tracking (merge/split/segment edit, time notes,
optional GPS tracks), the token-scoped REST + agent APIs, push reminders & location,
AI agents / NL commands, CalDAV, Home Assistant, and a Telegram bot. See
[`docs/features.md`](docs/features.md) for the full list.
