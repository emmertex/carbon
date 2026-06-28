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

- `CARBON_URL` — base URL, e.g. `https://carbon.etx.sx` (or the tenant subdomain).
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

## Testing & operations

- **Test** button in Settings → AI agents does a live connectivity check (webhook POST with
  `{event:'test'}`, or a one-shot model call) and shows status + a response snippet.
- **Edit** (pencil) changes config; **Enable/Disable** and **Delete** manage the bot user.
- LLM/webhook errors are surfaced with URL + status + body.

## Security notes

- **SSRF guard:** in multi-tenant mode (`BASE_DOMAIN` set) agent endpoints can't point at
  private/loopback/metadata addresses. **Single-tenant self-host allows private hosts** so
  your LAN LLM (e.g. a local LM Studio instance) works; set `ALLOW_PRIVATE_AGENT_ENDPOINTS=1`
  to allow them under a base domain too.
- **Error messages** from a failed agent run are logged server-side; the public task comment
  is generic (no endpoint URL/body leak).
