# Carbon ↔ Hermes integration

**Hermes is an agentic framework, not an LLM.** Carbon models it as a **bot user** of kind
`webhook`: Carbon POSTs a trigger to Hermes's webhook, and Hermes acts back through the
Carbon REST API using a token issued when the agent was created. (For a plain
OpenAI/Anthropic endpoint, Carbon runs a simpler comment-reply loop itself — see *Direct
LLM* below.)

> This page is the **operator's setup guide**. The full wire contract a Hermes skill author
> needs (exact webhook payload, every callback endpoint) is in
> [`carbon-agent-api.md`](carbon-agent-api.md). The general REST surface is [`api.md`](api.md).

## The flow

```
A user @mentions or assigns the bot on a task
        │
        ▼
Carbon ──POST {webhook URL, x-carbon-secret}──►  Hermes      (the trigger; respond 200 fast)
                                                    │  reasons, uses HA / KB / tools
                                                    ▼
Hermes ──REST (Bearer agent-token)──► Carbon       (comment / attach / complete)
```

## 1. Create the bot in Carbon

**Settings → AI agents** (admin), kind **Agentic webhook (Hermes / OpenClaw)**:

- **Username** — e.g. `hermes`. Users trigger it with `@hermes` or by assigning it a task.
- **Webhook URL** — the endpoint Carbon POSTs triggers to.
- **Shared secret** (optional) — sent as `x-carbon-secret`; verify it on Hermes's side.

On creation Carbon issues a **one-time API token** (shown once). It belongs to the bot user,
so anything Hermes posts is authored by the bot and correctly permissioned. Save it.

## 2. Configure Hermes

Point a Hermes profile/skill at:
- `CARBON_URL` — base URL with workspace subdomain, e.g. `https://my.carbon.etx.sx`. For self-hosted deployments without subdomains, use `https://carbon.etx.sx`.
- `CARBON_TOKEN` — the issued agent token.

Have Hermes's webhook handler verify `x-carbon-secret`, do its work, then call back:
`POST /api/tasks/:id/comments` to reply and `POST /api/tasks/:id/complete` to finish an
assigned task. Full payload/field reference: [`carbon-agent-api.md`](carbon-agent-api.md).

## 3. Permission model (enforced by Carbon)

A bot user:

- **reads all tasks** (so it has context),
- **comments only** where it is assigned or `@mentioned`,
- **completes only** tasks assigned to it,
- **ignores its own comments** (no reply loops; the trigger queue is sequential and
  loop-safe).

Because Hermes acts via the bot token, these rules apply uniformly — there is no special-
case path. (If you instead hand Hermes a *human's* token, replies are authored by that human
and bot scoping does **not** apply — prefer the agent token.)

## Triggers

- **Assignment** — assign a task/project to the bot.
- **@mention** — `@hermes` in a comment body.

Both are detected server-side on sync ingest of the relevant record-op
(`apps/server/src/agents.ts` `triggerAgents`) and queue a run.

## Direct LLM alternative (no Hermes)

Same Settings page, kind **`openai`** (OpenAI / OpenRouter / LM Studio / any
OpenAI-compatible endpoint) or **`anthropic`**. Carbon calls the model itself and posts the
reply; the model can end with `COMPLETE` to close an assigned task. The **Endpoint** is the
*base URL* exposing `/chat/completions` (usually ending in `/v1`, e.g.
`http://192.168.0.50:1234/v1` for a local LLM server). This is less autonomous than Hermes —
no tool use — but needs no external framework.

## Natural-language flows

Beyond the comment-reply trigger above, Carbon exposes a **granular agent API**
(`/api/agent/*`, see [`carbon-agent-api.md` §6](carbon-agent-api.md)) so a *small* model
(e.g. Qwen 2.5 1.5B) can do natural-language task management: "add milk and eggs to my
shopping list", "mark off bread and milk", "what do I need at Coles?". The server does the
fuzzy matching and batching, so the model passes plain names and composes a few small calls.

The Python helper module (`hermes/carbon-webhook-listener.py`) ships matching wrappers:
`agent_add()`, `agent_complete()`, `agent_resolve()`, `agent_lists()`, `agent_tags()`,
`agent_items()`, `agent_nearby()`, `agent_set_tag_geo()`, `agent_update()`, `agent_users()`,
`agent_share()`, `agent_assign()`, `agent_start_timer()`, `agent_stop_timer()`.

**Skill rules (the short version a 1.5B model should follow):**
1. Resolve before you write; if a name is uncertain (`/resolve` → `best.confident` false), ask.
2. "Add X and Y to LIST" → one `agent_add(list, titles=[X,Y])`.
3. "Remind me to get X at PLACE" → `agent_add(list="shopping", tags=[PLACE], titles=[X])`; the tag carries the location (geofence it once with `agent_set_tag_geo`).
4. "Mark/tick off X and Y" → `agent_complete(queries=[X,Y])`, then report `matched` vs `unmatched` **verbatim** — never claim you completed an unmatched item.
5. "What do I need at PLACE?" → `agent_nearby(tag=PLACE)`; if empty, say so and offer `agent_items(list="shopping")`.
6. Scheduling: a time → `due_date`; "remind me N before" → `reminder_at` (= due − N); a repeat ("every Tuesday") → `recurrence` (e.g. `{type:"weekly",interval:1,daysOfWeek:[2]}`). Pass them via `agent_add(tasks=[{title, due_date, reminder_at, recurrence}])`, or change later with `agent_update`.
7. "Share/assign X with/to NAME" → `agent_share(query="X", users=["NAME"])` / `agent_assign(...)`; call `agent_users()` if unsure who exists (bots can't be assigned). "Start/stop a timer on X" → `agent_start_timer(query="X")` / `agent_stop_timer()`.
8. To reach a **completed** task (reopen/re-tag/report), pass `done=false` (complete) or `status="all"`/`include_done=True`.

The exact, example-driven system prompt lives in `apps/server/src/agent-command.ts`
(`SYSTEM_PROMPT` / `CONVERSATIONAL_SYSTEM_PROMPT`) — use it (or a close paraphrase)
as the model's system message. Point a local LLM at it through your Hermes profile; geocoding for "nearest PLACE" is
controlled by the `CARBON_GEOCODE_*` env vars (OpenStreetMap by default).

## Testing & operations

- **Test** button in Settings → AI agents does a live connectivity check (webhook POST with
  `{event:'test'}`, or a one-shot model call) and shows status + a response snippet.
- **Edit** (pencil) changes config; **Enable/Disable** and **Delete** manage the bot user.
- LLM/webhook errors are logged server-side with URL + status + body; the task comment gets a
  generic, actionable message only (see *Security notes*).

## Security notes

- **SSRF guard:** in multi-tenant mode (`BASE_DOMAIN` set) agent endpoints can't point at
  private/loopback/metadata addresses. **Single-tenant self-host allows private hosts** so
  your LAN LLM (e.g. a local LM Studio instance) works; set `ALLOW_PRIVATE_AGENT_ENDPOINTS=1`
  to allow them under a base domain too.
- **Error messages** from a failed agent run are logged server-side; the public task comment
  is generic (no endpoint URL/body leak).
