# Carbon Roadmap

Phasing agreed 2026-06-22. Order is **interleaved**: ship the high-value single-user
UX first, then the multi-user foundation, then circle back for the remaining UX. The
**full data model is designed up front** (below) so later phases are additive and the
sync protocol never needs a retrofit.

All phases below have shipped; see [`docs/features.md`](docs/features.md) for the full,
up-to-date feature inventory. Notable additions after the original Phase A–F plan include
first-class **Notes** (including notes projects, card rows and thumbnails), **recipe**
notes with servings scale, deep **time-tracking** editing (merge/split/segments, time
notes), opt-in **GPS tracks** on sessions, **Recently Deleted** recovery, sync recovery
(reset local / merge-replace / erase on sign-out), mandatory sync **2FA**, and
**federation** L2/L3 (off by default).

## Phases

- **Phase A — Offline core** ✅ done. Capture, projects, Today/Inbox/Flagged/Review,
  tags, due/defer/flag/priority, recurrence, drag-reorder, light/dark, sync.

- **Phase B — Power & structure** ✅ done.
  - **B1 Nested tasks** — drag to reorder; drag a task *onto* another to nest it.
  - **B2 Focus mode** — eye toggle beside the flag drills into a task as a container
    (only it + descendants), with a breadcrumb bar + exit. Works from any view.
  - **B3 Time-logging UI** — the **Time** view (List/Timeline/Chart) surfaces `time_logs`.
  - **B4 Perspectives / filters / sorting** — saved perspectives, basic + advanced
    filters, sort + filter bar.

- **Phase C — Multi-user foundation** ✅ done (the spine).
  - DB-backed user accounts; server **admin page** (onboarding: add/remove users,
    reset passwords, roles, mark bot users). `AUTH_USERS` env still bootstraps the
    first admin.
  - Client identity/login; server **stamps** the authenticated user on incoming ops.
  - **Authorization-scoped sync** — a peer receives only the rows for items it owns or
    is shared on.
  - **Sharing + assignment** — share a project/task with users from the full server
    roster (read/write); assign tasks to users.

- **Phase D — Rich content & collaboration** ✅ done.
  - **Attachments** subsystem (built once, used by tasks *and* comments): content-hash
    blob store, offline cache, ≤25 MB per file across sync.
  - **Comments** — per-task timeline authored by any shared user, carrying text +
    attachments/images. `@mention` plumbing (incl. the `@Hermes` hook for Phase F).

- **Phase E — Sensors, alerts & Home Assistant** ✅ done.
  - Web Push (VAPID) + service worker; per-user/device push subscriptions; server-side
    reminder scheduler for due/defer + explicit alerts.
  - **Integration REST API + scoped tokens** — HA (and others) POST a task into a
    user's inbox (e.g. low-battery → inbox task).
  - **Geolocation reminders** — link a Carbon user to an HA `person` entity; HA zone
    enter/leave → webhook → Carbon fires reminders for location-tagged tasks. Sensing
    lives in HA; Carbon stores triggers + consumes webhooks.
  - **Beyond the original plan:** per-device location sources (each signed-in device
    reports its own GPS as a toggleable source, with device naming/management) and
    **"nearest place" geocoding** (OSM Overpass/Nominatim) so a reminder can pin itself
    to the closest matching shop without coordinates. See [`docs/home-assistant.md`](docs/home-assistant.md).

- **Phase F — Hermes / LLM agents** ✅ done.
  - A **bot user** (Hermes, or any OpenAI/Anthropic-compatible endpoint) configured on
    the admin page: system prompt + provider/endpoint/key/model.
  - **Triggers**: assigned a task/project, or `@Hermes` in a comment → a server-side job.
  - **Permissions**: reads *all* tasks; comments/acts *only* where assigned or @'d; may
    attach links/images/files; may mark an assigned task complete.
  - Hermes-side tools (HA, Obsidian KB, general AI) are Hermes's concern — Carbon hands
    it task context and accepts its actions through the API, enforcing permissions.
  - **Beyond the original plan:** a granular **natural-language agent API** (`/api/agent/*`)
    plus an **in-app NL command box** (keyword-triggered, server-side tool-loop, per-command
    token tracking) and a `carbon-nl` Hermes skill + webhook listener, so plain-language
    task control works in-app and from any bot (Telegram, Hermes, scripts). See
    [`docs/carbon-agent-api.md`](docs/carbon-agent-api.md) and [`docs/hermes.md`](docs/hermes.md).
  - A **built-in, per-server Telegram bot**: users link their individual account with a
    one-time code (Settings → Telegram), then drive the same AI agent over chat with
    conversational replies. See [`docs/telegram-bot.md`](docs/telegram-bot.md).

## Full data model (designed now; tables materialize per phase)

Item-level fields and the collaboration tables (users/shares/assignees/comments/
attachments) are added in **migration v2** now so the schema is stable. Server-only,
non-syncing tables (tokens, push, agents) are added in their own phases — they don't
touch the sync protocol, so they carry no retrofit cost.

```
users            id, username(uniq), display_name, role(admin|member), is_bot,
                 avatar_color, password_hash(server-only), ha_person(server-only),
                 created_at, updated_at, deleted
items (+)        owner_id, geo(JSON {lat,lng,radius,label}), alerts(JSON [ISO,…])
shares           id, item_id, user_id, permission(read|write), created_at, deleted
assignees        id, item_id, user_id, created_at, deleted
comments         id, item_id, author_id, body, mentions(JSON user_ids),
                 created_at, updated_at, deleted
attachments      id, parent_type(item|comment), parent_id, filename, mime_type,
                 size, hash(content-addressed blob), created_by, created_at, deleted

— added in their phases (server-only, no sync impact) —
api_tokens       id, user_id, name, token_hash, scopes(JSON), created_at, last_used_at, revoked   (Phase E)
push_subscriptions  id, user_id, endpoint, p256dh, auth, device_label, created_at               (Phase E)
agents           id, name, kind(hermes|openai|anthropic|openai-compatible), endpoint,
                 api_key, model, system_prompt, user_id(bot), enabled, created_at               (Phase F)
```

## Sync design (locked now)

- **items** keep the **field-level op-log** (`ops`) — per-field LWW — because items have
  many independently-editable fields.
- **users / shares / assignees / comments / attachment-metadata** sync as **row-level
  records**: LWW by `(updated_at, id)` with `deleted` tombstones (these are
  create/edit/tombstone entities, not field-merge entities). This avoids forcing
  everything through the item op-log.
- Both channels move behind one `/api/sync` call with a per-channel cursor.
- **Authorization (Phase C)**: the server filters both channels to rows the
  authenticated user owns or is shared on, and stamps `owner_id`/`author_id` from the
  session — never trusting client-claimed identity. `users` sync as a **public
  projection** (no `password_hash`).
- **Attachments**: metadata syncs as records; the blob moves out-of-band by content
  hash (upload-if-absent, download-on-demand, cached locally).
- **Op-log growth (locked):** clients are full replicas (sql.js → IndexedDB); pulls are
  unpaged. Keep total `ops`+`record_ops` well under ~50 MB; past ~100 MB expect first-sync
  and client RAM issues first (sql.js + unpaged JSON), not SQLite itself.
  - **Tier 1 — safe prune** (cursors stay valid): LWW losers only, never delete
    `MAX(rowid)` (rowid-reuse guard). Notes today; superseded `setting` record_ops too.
  - **Tier 2 — sync epoch reset** (breaks incremental sync): operator rebuilds the log
    from materialized state, bumps workspace `sync_epoch`, clients must wipe and re-pull
    (or stay offline). Federation links must be revoked first; peers re-bootstrap manually.

## Hermes integration (Phase F) — intent

Hermes is modeled as a normal **bot user**, so sharing/assignment/comments/permissions
all apply uniformly. Carbon's only jobs: expose task context, accept Hermes's
actions (comment, attach, complete) via the API, and enforce that it can only write
where assigned or @'d. The agentic intelligence (HA control, Obsidian KB, web) lives in
Hermes; for plain OpenAI/Anthropic endpoints Carbon runs a simpler comment-reply loop
with less autonomy. Provider + system prompt are admin-configured server-side so usage
can be tuned per deployment.
