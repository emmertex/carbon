---
name: carbon-nl
description: Use when the user wants to manage their Carbon to-do/shopping lists in plain language — add tasks ("add milk and eggs to my shopping list"), check things off ("mark off bread and milk"), or ask what they need somewhere ("what do I need at Coles?"). Drives the Carbon natural-language API via the carbon-cli.py helper. NOT for webhook/mention triggers — that's the carbon-agent skill.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [carbon, tasks, todo, shopping, natural-language, productivity]
    related_skills: [carbon-agent, concise-response]
---

# Carbon NL — talk to your task lists

Carbon is a self-hosted task manager. This skill lets the user control it in plain
language. **You do not call the HTTP API directly** — you run `carbon-cli.py`, which talks
to Carbon's `/api/agent/*` endpoints. The server does all the fuzzy name-matching and
batching, so **pass plain names** (a list, a tag, a task title) — never ids, never JSON.

Every command prints one short, friendly line. **Relay that line to the user almost
verbatim** — especially the "Couldn't find: …" part. Don't claim you did something the tool
didn't report.

## Configuration

| Variable | Description |
|----------|-------------|
| `CARBON_URL` | Base URL, e.g. `https://carbon.etx.sx` |
| `CARBON_TOKEN` | API token that **acts as the user** (so it can complete their tasks) |

Set them in the shell, or put them in `.credentials` next to the script
(`~/.hermes/skills/productivity/carbon-nl/.credentials`):

```
CARBON_URL=https://carbon.etx.sx
CARBON_TOKEN=carbon_xxxxxxxx
```

> Use a token whose owning user is the person (or open mode on a private box). A pure *bot*
> token can read everything but can only complete tasks assigned to it — wrong for "mark off
> milk". Create a token in Carbon → Settings → API tokens with scopes
> `tasks:read, tasks:write, inbox:write`.

## The command (run with `python3 carbon-cli.py …`)

| Intent | Command |
|--------|---------|
| Who am I acting as | `whoami` |
| Add tasks | `add <title> [<title> …] --list "<list>" [--tag <tag> …]` |
| Check off | `done <title> [<title> …] [--list "<list>"]`  (alias: `complete`, `check-off`) |
| Re-open | `done <title> --undo` |
| What's at a place | `nearby --tag <tag>`  (or `--zone <name>`, or `--lat <n> --lng <n>`) |
| Show lists | `lists` |
| Show tags | `tags` |
| Show a list's tasks | `items --list "<list>" [--all]` |
| Check a name | `resolve list\|tag\|task "<name>"` |
| Give a tag a location | `tag-geo <tag> --lat <n> --lng <n> [--radius <m>] [--label "<text>"]` |
| Locate nearest place | `tag-geo <tag> --near-name "<place>" --lat <n> --lng <n>` |

Add `--json` to any command to get the raw response instead of the friendly line.

## Map intents → commands

- **"Add milk and eggs to my shopping list."**
  `python3 carbon-cli.py add milk eggs --list "shopping list"`
  → *Added to "shopping list": milk, eggs* (the list is created if it doesn't exist).

- **"Remind me to get bread next time I'm at Coles."**
  `python3 carbon-cli.py add bread --list "shopping list" --tag coles`
  → the `coles` tag carries the location. If the user gives coordinates, also run
  `python3 carbon-cli.py tag-geo coles --lat <n> --lng <n> --label Coles` once.

- **"Mark off bread and milk."**
  `python3 carbon-cli.py done bread milk`
  → relay both lines, e.g. *Marked off: milk* / *Couldn't find: bread*.

- **"What do I need at Coles?"**
  `python3 carbon-cli.py nearby --tag coles`
  → if it says *Nothing marked for coles*, tell the user, then optionally show the list:
  `python3 carbon-cli.py items --list shopping`.

## Rules

1. One add request → **one** `add` command with all the titles. One check-off request → **one**
   `done` command with all the names. Don't loop one item at a time.
2. Don't invent or complete tasks the user didn't mention. Do exactly what was asked.
3. If a name is genuinely ambiguous, run `resolve` first; if it says *unsure*, ask the user
   which they meant rather than guessing.
4. Keep replies short and conversational. The tool output already is — lean on it.
5. If a command errors (e.g. *could not reach Carbon*), tell the user plainly; check
   `CARBON_URL`/`CARBON_TOKEN`.

## Troubleshooting: "the agent says it added them but I don't see them on the web"

This is almost always a **token ownership** problem. Tasks are owned by the user the token
acts as, and a user only sees their own (or shared) tasks. If you used the **carbon-agent
bot token**, the tasks are owned by the *bot* — the bot (and this skill, since bots read
everything) sees them, but your human web account doesn't.

Diagnose: `python3 carbon-cli.py whoami`
- *"… (BOT) ⚠ …"* → that's the cause. Create a token that acts as **you** in
  Carbon → Settings → API tokens (scopes `tasks:read, tasks:write, inbox:write`) and put it
  in `.credentials`. New tasks will then be owned by you and show on the web.
- *"… (user)"* → ownership is fine; if you still don't see them, your web client just needs
  a sync (reload), and check you're viewing the right list (`items --list "<name>"`).
- *"… (open mode)"* → no accounts exist; everything is visible to everyone.

(Tasks added earlier under the wrong token stay owned by that bot. Re-add them with the
correct token, or share/reassign them in Carbon.)

## Quick self-test

```
python3 carbon-cli.py whoami                                   # should say "(user)", not "(BOT)"
python3 carbon-cli.py add "test milk" --list "shopping list"
python3 carbon-cli.py items --list shopping
python3 carbon-cli.py done "test milk" --list shopping
```
Expect: *Acting as: <you> (user)*, *Added …*, the list with the item, then *Marked off: test milk*.

## Install

Copy this folder to `~/.hermes/skills/productivity/carbon-nl/`, create `.credentials`
(above), and make the script runnable: `chmod +x carbon-cli.py`. No webhook listener is
needed for this skill — it calls Carbon directly when you ask it to.
