# Telegram bot

The bot uses the workspace’s configured AI agent and acts with the linked user’s
permissions. One bot serves all workspaces on a server.

## 1. Create a bot with BotFather

1. In Telegram, message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a name and a username (must end in `bot`).
3. BotFather gives you a **token** like `123456:ABC-DEF…`. Keep it secret — this is
   `TELEGRAM_BOT_TOKEN`.

## 2. Configure the server

Set these variables in the [server environment](../apps/server/.env.example).
The webhook must be reachable over HTTPS at `/telegram/webhook`.

```bash
# BotFather token
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Public server URL
TELEGRAM_WEBHOOK_URL=https://carbon.example.com

# Generate a webhook secret:
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
TELEGRAM_WEBHOOK_SECRET=<random hex string>

# Optional; detected automatically if unset.
TELEGRAM_BOT_USERNAME=my_carbon_bot
```

Restart the server to register the webhook. Forward `/telegram/webhook` through
your reverse proxy.

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
| `tag everything in groceries with groceries` | Bulk-tags the whole list. |
| `mark off bread and milk` | Completes both; reports anything it couldn't find. |
| `write down that the spare key is under the pot` | Creates a note (not a task). |
| `what did I write about the rental car?` | Searches inside note bodies and summarises the hit. |
| `what's in my recipes notebook?` | Lists the notes in a notebook (a list that holds notes). |
| `add to the sourdough recipe: rest for 45 min` | Appends a line, keeping the rest of the recipe. |

### Notes and recipes

Notes are items with a body and no checkbox; a **notebook** is a list that holds them. The bot
reads and writes both: adding to a notebook makes a note automatically, "save this recipe …"
creates one in recipe mode (so it opens in Carbon's recipe editor), and "add to X" appends to a
note rather than replacing it. Long note bodies are summarised rather than pasted back in full.

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

Send `/reset` or `/clear` to clear context. Linking or unlinking also clears it.
`TELEGRAM_HISTORY_MESSAGES` sets the history window (default: 6 messages).

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
  [External webhook / agent integration](carbon-agent-api.md).
- **"That code has expired / wasn't recognised."** Codes last 10 minutes and are single-use —
  generate a fresh one in Settings → Telegram.
- **Token usage.** Bot traffic is metered separately under *telegram* in Settings → AI agents
  token usage.
