---
name: carbon-agent
description: Use when receiving a webhook trigger from Carbon (self-hosted task manager) or when the user asks to interact with Carbon tasks. Handles mention/assigned events, reads tasks, posts comments, completes tasks, creates follow-ups, and attaches files via the Carbon REST API. Also covers webhook listener setup.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [carbon, tasks, todo, webhook, rest-api, productivity]
    related_skills: [concise-response, home-assistant-troubleshooting, cbus-gateway]
---

# Carbon Agent — Hermes / Carbon integration

## Overview

Carbon is a self-hosted task manager at `https://carbon.etx.sx`. Users trigger
the Hermes agent by @mentioning the bot or assigning it a task. Carbon sends a
webhook POST; the agent works asynchronously and calls back via the REST API to
post comments, complete tasks, and create follow-ups.

## Configuration

Required environment variables (set in the skill directory or shell profile):

| Variable | Description |
|----------|-------------|
| `CARBON_URL` | Base URL, e.g. `https://carbon.etx.sx` |
| `CARBON_TOKEN` | Agent API token (Bearer auth) |
| `CARBON_SECRET` | Shared secret for webhook verification (optional but recommended) |

The token for this agent is stored in the skill credentials file:
`~/.hermes/skills/productivity/carbon-agent/.credentials`

## When to Use

- A webhook trigger arrives from Carbon (mention or assigned event)
- The user asks to read, comment on, or complete Carbon tasks
- The user asks to create or update tasks in Carbon
- The user asks to set up or troubleshoot the Carbon webhook listener

## Webhook Flow

```
User @mentions bot on a task
        │
        ▼
Carbon  ──POST webhook URL──►  carbon-webhook-listener.py  (port 9192)
                                     │
                                     │  writes to queue file
                                     ▼
                            ~/.hermes/carbon-queue.jsonl
                                     │
                                     │  Hermes agent / cron picks up
                                     ▼
                            Agent processes task via REST API
                                     │
                                     ▼
                            POST comment / complete / create follow-up
```

### Webhook listener

The listener is at `/home/ku7/carbon-webhook-listener.py`. It:
1. Verifies `x-carbon-secret` header (if `CARBON_SECRET` is set)
2. Responds `200` immediately
3. Appends the trigger payload to `~/.hermes/carbon-queue.jsonl`

Start it:
```bash
CARBON_TOKEN="<token>" \
CARBON_SECRET="<secret>" \
python3 /home/ku7/carbon-webhook-listener.py
```

Or run as a systemd unit (recommended for production). A systemd unit template is at `/home/ku7/carbon-agent.service.template`.

### Queue processor

Process queued items:
```bash
python3 /home/ku7/carbon-process-queue.py          # pop and format next item
python3 /home/ku7/carbon-process-queue.py --list   # list all pending
python3 /home/ku7/carbon-process-queue.py --clear  # clear queue
```

## REST API Reference

Base: `GET/POST/PATCH https://carbon.etx.sx/api`
Auth: `Authorization: Bearer <token>`

### Read task
```
GET /api/tasks/{id}
→ { id, title, note, status, priority, due_date, defer_date, parent_id, ... }
```

### List tasks
```
GET /api/tasks?perspective=today    # inbox | today | flagged
GET /api/tasks?project={id}
GET /api/tasks?status=active        # active | done | dropped
→ { "tasks": [...] }
```

### Post a comment (the main action)
```
POST /api/tasks/{id}/comments
{ "body": "Markdown allowed — **bold**, links, images." }
→ 201 { id, item_id, author_id, body, created_at, ... }
```

### Complete / re-open
```
POST /api/tasks/{id}/complete          # done
POST /api/tasks/{id}/complete?done=false  # re-open
→ 200 { ...task, status: "done" }
```

### Create a task
```
POST /api/tasks
{ "title": "...", "note": "...", "project_id": "...",
  "due_date": "2026-07-01T00:00:00Z", "flagged": false, "priority": 2 }
→ 201 { ...Item }
```

### Update a task
```
PATCH /api/tasks/{id}
{ "title": "...", "status": "active", "due_date": "...", "flagged": true, ... }
→ 200 { ...Item }
```

### Attach a file
```
# 1) Upload by content hash (idempotent)
POST /api/blobs/{sha256hex}    body: raw file bytes
→ 200 { "ok": true }

# 2) Attach metadata to task
POST /api/tasks/{id}/attachments
{ "filename": "report.pdf", "mimeType": "application/pdf",
  "size": 18234, "hash": "{sha256hex}" }
→ 201 { ...attachment }
```

### Identity / health
```
GET /api/me        → { id, username, role, is_bot, ... }
GET /api/health    → { status: "ok", version }   (no auth)
```

## Processing a Trigger

When a webhook trigger arrives (via queue file or direct call):

1. **Parse the payload** — extract `event`, `task`, `comments`, `instructions`
2. **Handle `event: "test"`** — just acknowledge, no action needed
3. **Handle `event: "mention"`** — the last comment in `comments` is the one
   that tagged the bot. Read the task context, do the work, post a comment.
4. **Handle `event: "assigned"`** — the bot has been put on the task. Do the
   work, post a comment, and when done call `/complete`.
5. **Post results** — use `POST /api/tasks/{id}/comments` with the agent's
   response. Markdown is supported.
6. **Complete if assigned** — if `event == "assigned"` and the task is done,
   call `POST /api/tasks/{id}/complete`.

The webhook payload already contains the full task and comment thread — you
usually don't need extra `GET /api/tasks` calls unless you need broader context.

## Bot Permissions (server-side)

- **Read**: all tasks
- **Comment / attach**: only tasks where bot is assigned or @mentioned
- **Complete**: only tasks assigned to the bot

## Error Handling

- `401` — bad/expired token → alert the user, do not retry
- `403` — bot not assigned/mentioned on that task (stale trigger) → skip silently
- `4xx/5xx` on comment → log the error, do not retry automatically

## Common Pitfalls

1. **Not responding 200 fast enough** — The webhook listener must return 200
   immediately. All real work happens asynchronously via the REST API.
2. **Using a human token** — Replies will be authored by that user, not the
   bot. Always use the agent token.
3. **Forgetting to complete** — For `assigned` events, remember to call
   `/complete` when the work is done.
4. **Stale triggers** — A 403 on comment means the bot was unassigned before
   the agent processed it. Skip gracefully.
5. **Markdown in comments** — Carbon renders markdown. Use it for formatting,
   links, and inline images.
6. **Port conflict** — The listener defaults to port 9192. Your Uptime Kuma
   webhook listener already uses 9191. Don't collide.
7. **Systemd unit** — A template is at `/home/ku7/carbon-agent.service.template`.
   Edit the CARBON_TOKEN line, then `sudo cp ... /etc/systemd/system/ && sudo systemctl enable --now carbon-agent`.

## Verification Checklist

- [ ] Webhook listener running and accessible from Carbon's server
- [ ] `CARBON_TOKEN` set and valid (`GET /api/me` returns bot identity)
- [ ] `CARBON_SECRET` matches what's configured in Carbon settings
- [ ] Queue file directory exists and is writable
- [ ] Test trigger from Carbon's UI delivers a payload to the queue
- [ ] Agent can post a comment and complete a task via the REST API

## Related Skills

- **smart-home skills** (home-assistant-troubleshooting, cbus-gateway) — when a Carbon task involves Home Assistant or C-Bus automation, load the relevant skill
- **productivity skills** (google-workspace, maps, obsidian) — when a Carbon task involves calendar, maps, or notes integration
