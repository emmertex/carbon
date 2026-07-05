# Telegram bot

Carbon can run a **Telegram bot** so you (and everyone on your server) can control tasks from
a chat in plain language:

- *"add milk and eggs to my shopping list"*
- *"what's due tomorrow in the work project?"*
- *"untick my weekly shopping items"* (items tagged `weekly`)
- *"mark off bread and milk"* — it tells you exactly what it found and what it couldn't

The bot drives the **same AI agent** as Carbon's in-app natural-language commands (Settings →
AI agents / Natural-language commands). Unlike the in-app Add box — which replies tersely — the
bot answers conversationally, so it's good for questions and summaries as well as actions.

## How it works

- **One bot per server, not per workspace.** A single bot serves every workspace on the host.
- **Users link their own account.** Adding the bot isn't enough — each person links the bot to
  their individual Carbon **user** in a chosen workspace, using a one-time code generated in
  Carbon's Settings. After that, everything the bot does runs **as that user**: it sees and
  changes only what the user can, and created tasks are owned by them.
- **It reuses your configured AI agent.** No extra model setup — if natural-language commands
  work in the app, the bot works. If a workspace hasn't set up an AI agent, the bot tells the
  user to ask an admin to configure one.

```
Telegram ──webhook──► Carbon ──(chat → workspace+user)──► your AI agent ──► reply
```

> **Hosted service.** On the hosted Carbon offering the model is provided for you — the bot and
> in-app natural-language commands run on a **basic model** (currently GPT-OSS-20B, may change)
> under **fair-use limits**, with no API key to configure. Want higher limits or a stronger
> model? Point your workspace's AI agent at your own OpenAI / Anthropic / webhook key. The rest
> of this page covers **self-hosted** setup, where you supply the bot token and the model.

## 1. Create a bot with BotFather

1. In Telegram, message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a name and a username (must end in `bot`).
3. BotFather gives you a **token** like `123456:ABC-DEF…`. Keep it secret — this is
   `TELEGRAM_BOT_TOKEN`.

## 2. Configure the server

The bot needs a **public HTTPS URL** because it uses a Telegram **webhook** (Telegram POSTs
updates to your server). If you already serve Carbon over HTTPS (e.g. behind nginx with a
`BASE_DOMAIN`), point the webhook at that origin. Set these in the server's environment (see
[`.env.example`](../apps/server/.env.example)):

```bash
# Token from @BotFather. Setting it enables the bot.
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Public base URL of this server (HTTPS). The webhook is registered at
# <TELEGRAM_WEBHOOK_URL>/telegram/webhook on startup.
TELEGRAM_WEBHOOK_URL=https://carbon.example.com

# A random secret you choose. Telegram echoes it back in a header so Carbon can verify
# that incoming webhook calls are genuinely from Telegram. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
TELEGRAM_WEBHOOK_SECRET=<random hex string>

# Optional: the bot's @username, shown in Settings → Telegram. Auto-detected otherwise.
TELEGRAM_BOT_USERNAME=my_carbon_bot
```

Restart the server. On startup you should see:

```
[carbon] telegram webhook registered -> https://carbon.example.com/telegram/webhook
[carbon] telegram bot @my_carbon_bot ready
```

> **nginx note.** The webhook is a plain `POST /telegram/webhook` on the same host that serves
> the app/API. If nginx already forwards `/` (or `/api`) to Carbon, no extra config is needed —
> just make sure `/telegram/` is forwarded too. TLS is required: Telegram only delivers webhooks
> over HTTPS on ports 443/88/80/8443.

If you don't set `TELEGRAM_WEBHOOK_URL`, Carbon won't auto-register the webhook; you can set it
yourself once with:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://carbon.example.com/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## 3. Link your account

1. In Carbon, open **Settings → Telegram** and tap **Connect Telegram**. You get a one-time code
   (valid 10 minutes).
2. In Telegram, open a chat with your bot and send `/start`.
   - On a **multi-tenant** host the bot asks which workspace you're on first — reply with your
     workspace name (the subdomain).
   - On a **single-workspace self-host** it skips straight to asking for the code.
3. Send the code (or `/link <code>`). The bot replies **"✅ Linked as &lt;you&gt;"** and you're ready.

Settings → Telegram then shows your connection; tap **Disconnect** (or send `/unlink`) to remove
it. Generating a code proves you're signed in as that user, which is what authorises the link.

## 4. Use it

Just talk to the bot:

| You say | What happens |
|---|---|
| `add milk and eggs to my shopping list` | Creates two tasks in *shopping list* (made if missing). |
| `what's due tomorrow in the work project?` | Reads the *work* project and answers with what's due. |
| `untick my weekly shopping items` | Re-opens every task tagged `weekly`. |
| `tag everything in groceries with woolworths` | Bulk-tags the whole list. |
| `mark off bread and milk` | Completes both; reports anything it couldn't find. |

### Conversational context

The bot remembers the **last few messages** in your chat, so you can refer back without
repeating yourself:

```
You:  what's on my shopping list?
Bot:  Bread and milk.
You:  add eggs to it
Bot:  Added eggs to your shopping list.
You:  mark off bread
Bot:  Marked off bread.
```

It focuses on your latest message and only leans on the earlier conversation when the message is
unclear on its own or refers back ("it", "that", "what about the work project?"). Send `/reset`
(or `/clear`) to forget the context and start fresh; linking, unlinking, or relinking also clears
it. The window is the last 6 messages by default — tune it with `TELEGRAM_HISTORY_MESSAGES`.

Bot commands: `/start` (link), `/whoami` (show your link), `/reset` (forget context), `/unlink`,
`/help`.

## Troubleshooting

- **Bot doesn't respond at all.** Check the startup log for `telegram webhook registered`. Visit
  `https://api.telegram.org/bot<token>/getWebhookInfo` — `last_error_message` shows TLS/reachability
  problems. The webhook URL must be public HTTPS and reach `/telegram/webhook`.
- **403 in the logs on webhook calls.** The `X-Telegram-Bot-Api-Secret-Token` didn't match —
  re-run `setWebhook` with the same `TELEGRAM_WEBHOOK_SECRET` the server has.
- **"This workspace doesn't have an AI assistant set up yet."** An admin must add a direct-LLM
  agent in **Settings → AI agents** and enable **Natural-language commands**. See
  [Hermes / agent integration](hermes.md).
- **"That code has expired / wasn't recognised."** Codes last 10 minutes and are single-use —
  generate a fresh one in Settings → Telegram.
- **Token usage.** Bot traffic is metered separately under *telegram* in Settings → AI agents
  token usage.

## Privacy & security notes

- The bot only acts after a user links their account with a code from Carbon's Settings — a
  random Telegram user can't reach anyone's tasks.
- Every action runs as the linked Carbon user, with that user's normal visibility and
  write-access. The bot has no special powers.
- Outbound calls go only to `api.telegram.org`. Your LLM endpoint is whatever the workspace's AI
  agent is configured to use.
