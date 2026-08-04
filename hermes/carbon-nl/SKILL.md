---
name: carbon-nl
description: Use when the user wants to manage their Carbon to-do/shopping lists, notes or recipes in plain language — add tasks ("add milk and eggs to my shopping list"), check things off ("mark off bread and milk"), ask what they need somewhere ("what do I need at Coles?"), set reminders/due dates/repeats ("remind me to take my son to swimming every Tuesday at 5pm, an hour before"), write or search notes ("write down that the spare key is under the pot", "what did I write about the rental car?"), save and add to recipes ("save this recipe", "add to the sourdough recipe: rest 45 min"), share or assign a task to someone, or start/stop a time-tracking timer. Drives the Carbon natural-language API via the carbon-cli.py helper. NOT for webhook/mention triggers — that's the carbon-agent skill.
version: 1.2.0
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
| `CARBON_URL` | Base URL, e.g. `https://carbon.example.com` |
| `CARBON_TOKEN` | API token that **acts as the user** (so it can complete their tasks) |

Set them in the shell, or put them in `.credentials` next to the script
(`~/.hermes/skills/productivity/carbon-nl/.credentials`):

```
CARBON_URL=https://carbon.example.com
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
| Add with schedule | `add <title> [--due <ISO>] [--defer <ISO>] [--remind <ISO>] [--repeat <spec>]` |
| Check off | `done <title> [<title> …] [--list "<list>"]`  (alias: `complete`, `check-off`) |
| Re-open | `done <title> --undo`  (finds the completed task) |
| What's at a place | `nearby --tag <tag>`  (or `--zone <name>`, or `--lat <n> --lng <n>`) |
| Show lists | `lists`  (📓 = a notebook: holds notes, not tasks) |
| Show tags | `tags` |
| Show a list's contents | `items --list "<list>" [--all] [--notes] [--detail]` |
| Write a note | `note add "<title>" --body "<text>" [--list "<notebook>"]` |
| Save a recipe | `note add "<title>" --recipe --body-file recipe.md [--list recipes]` |
| Add to a note/recipe | `note append "<title>" "<the new line>"` |
| Read one note in full | `note show "<title>"` |
| Search note contents | `note search "<text>"` |
| Check a name | `resolve list\|tag\|task\|note "<name>"` |
| Give a tag a location | `tag-geo <tag> --lat <n> --lng <n> [--radius <m>] [--label "<text>"]` |
| Locate nearest place | `tag-geo <tag> --near-name "<place>" --lat <n> --lng <n>` |
| List people | `users` |
| Share a task | `share "<task>" --to <name> [--to <name>] [--read] [--remove]` |
| Assign a task | `assign "<task>" --to <name> [--remove]` |
| Time tracking | `timer start "<task>"`  /  `timer stop` |

Add `--json` to any command to get the raw response instead of the friendly line.

**Scheduling.** `--due`/`--defer`/`--remind` take an ISO datetime (e.g. `2026-07-07T17:00`). For
"remind me an hour before", set `--due` to the event time and `--remind` an hour earlier.
`--repeat` is `daily|weekly|monthly|yearly`, optionally `weekly:tue` (or `mon,tue`) / `monthly:15`.

**People.** `share`/`assign` resolve names fuzzily and only work on tasks you own or can write to
(others are reported as skipped). Bots can't be shared/assigned to — run `users` to see who's valid.

**Notes and recipes.** A note is a title plus a body, with no due date or checkbox; a **notebook**
is a list that holds notes (shown with 📓 by `lists`). `items --list "<notebook>"` shows its notes
without any extra flag — elsewhere `items` shows tasks, and `--notes` / `--everything` switch that.
A **recipe** is a note kept in recipe mode so it opens in Carbon's recipe editor: create it with
`note add --recipe`, and pass the body with `--body-file` (or `--body-file -` to pipe it in) so the
Markdown survives intact.

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

- **"Remind me to take my son to swimming every Tuesday at 5pm, an hour before, and share it with Rachel."**
  (resolve the next Tuesday yourself from today's date)
  `python3 carbon-cli.py add "Take son to swimming" --due 2026-07-07T17:00 --remind 2026-07-07T16:00 --repeat weekly:tue`
  then `python3 carbon-cli.py share "Take son to swimming" --to rachel`.

- **"Assign the campsite booking to Rachel."**
  `python3 carbon-cli.py assign "campsite booking" --to rachel` → relay *Assigned … to rachel* (or
  *Skipped*/​*No such user* if it couldn't).

- **"Start a timer on the report"** / **"stop the timer."**
  `python3 carbon-cli.py timer start "report"` / `python3 carbon-cli.py timer stop`.

- **"Write down that the spare key is under the pot."**
  `python3 carbon-cli.py note add "Spare key" --body "Under the pot by the back door."`
  → *Note saved: Spare key*. Only write a note when the user actually asks for one ("note down",
  "write down", "remember that") — a bare item is a task.

- **"What did I write about the rental car?"**
  `python3 carbon-cli.py note search "rental car"` → summarise the snippet in a sentence and name
  the note; don't paste a long body back at them.

- **"What's in my recipes notebook?"** / **"what recipes do I have?"**
  `python3 carbon-cli.py items --list recipes` (a notebook lists its notes by default).

- **"Save this recipe: …"**
  `python3 carbon-cli.py note add "Sourdough" --recipe --list recipes --body-file -` and pipe the
  Markdown in. Keep every ingredient and step exactly as given — never invent, drop or reorder any.

- **"Add to the sourdough recipe: rest for 45 min."**
  `python3 carbon-cli.py note append "Sourdough" "Rest for 45 min"` → the server keeps the rest of
  the recipe. **Never** read a note and write it back to add to it; you would drop everything you
  didn't read.

## Rules

1. One add request → **one** `add` command with all the titles. One check-off request → **one**
   `done` command with all the names. Don't loop one item at a time.
2. Don't invent or complete tasks the user didn't mention. Do exactly what was asked.
3. If a name is genuinely ambiguous, run `resolve` first; if it says *unsure*, ask the user
   which they meant rather than guessing. `resolve task` matches notes too and prints `[note]` or
   `[task]` — only a task can be checked off.
4. To add to a note, use `note append`. Never `note show` then re-save the body.
5. Keep replies short and conversational. The tool output already is — lean on it.
6. If a command errors (e.g. *could not reach Carbon*), tell the user plainly; check
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
python3 carbon-cli.py note add "test note" --body "hello from the skill"
python3 carbon-cli.py note append "test note" "second line"
python3 carbon-cli.py note show "test note"
```
Expect: *Acting as: <you> (user)*, *Added …*, the list with the item, *Marked off: test milk*, then
the note with **both** lines (if the first line is gone, you're on a Carbon older than the
`note_append` patch key — upgrade the server).

## Install

Copy this folder to `~/.hermes/skills/productivity/carbon-nl/`, create `.credentials`
(above), and make the script runnable: `chmod +x carbon-cli.py`. No webhook listener is
needed for this skill — it calls Carbon directly when you ask it to.
