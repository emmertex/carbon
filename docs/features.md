# Carbon — complete feature list

The full inventory of what Carbon does today, grouped by area. This is the "what's in the
box" reference; for how to drive it see [usage & shortcuts](usage-and-shortcuts.md), and for
how it stacks up against other apps see the [comparison](comparison.md).

Items marked **(sync server)** need a Carbon server (self-hosted or hosted); everything else
works fully offline, local-only, with no account.

## Platform & hosting

- Self-hosted, fully local, or hosted cloud sync — your choice.
- Offline-first: the entire database lives in the browser (WASM SQLite) and every change is
  applied locally first.
- One codebase shipped as a **PWA** (installable) and wrapped natively for **Linux, Windows**
  (Tauri) and **Android** (Capacitor); macOS and iOS planned (help wanted).
- Install prompt appears only in a browser (hidden in native apps and installed PWAs), with
  links to the app stores, website and GitHub.
- Fully open source — no lock-in, no paywalled features.

## Data, sync & durability

- Field-level **last-writer-wins CRDT** over an append-only op log, with a causal clock for
  skew-safe merges.
- Debounced local persistence (250 ms) plus an immediate flush on tab hide/close, so a reload
  or app-kill never drops the last edit.
- **Full export/import** of the entire database plus attachment blobs.
- **Purge completed tasks** — bulk-delete (soft-delete/tombstone, syncs like any other change)
  your own completed items older than 7 days. A proactive Inbox notice **(sync server)** nudges
  you once your purgeable count crosses a threshold.
- **Copy any task/project subtree as a Markdown checklist** for pasting into chats or notes.
- Multi-device task sync **(sync server)**, with monotonic cursors and authorization-scoped
  backfill.
- **Sync recovery** — live sync errors in Settings → Sync; **Reset local data** (wipe this
  device and re-download); **Merge** or **Replace** when signing in over existing local data;
  keep or **erase** local data on sign-out.
- **Sync epoch mismatch (sync server)** — if an operator rebuilds the server's op log
  (history compaction), clients are notified: download a local backup, clear cache and
  re-download, or log out and keep working offline on the old local copy.
- **Settings & view sync (sync server)** — UI preferences, per-view filters and saved
  perspectives follow you across devices (LWW, scoped to your account); on by default, pulled
  on first sign-in, and toggleable per device.

## Task structure & hierarchy

- Projects, tasks, folders and **notes** — and **any item can act as a container**
  (unlimited nesting).
- Sequential / parallel / single-action container types with a **"next action" availability**
  model.
- Drag to reorder and drag to re-nest (change parent).
- Inbox capture for unfiled top-level tasks.
- Task states: **active / done / dropped**, plus tag-driven **on-hold**.
- **Focus mode** — drill into any task as its own container with a breadcrumb, from any view.
- Task dependencies (predecessor → successor) gate sequential availability.

## Scheduling

- Due date and time, separate **defer/start date** (hide until), and a separate **reminder
  time**.
- Recurrence including ordinal/complex patterns (weekly by weekday, monthly by day, etc.) and
  **completion-relative** repeats.

## Organization & filtering

- Tags: multiple per item, **colored**, **nestable**, synced family-wide, with descendant-
  inclusive matching.
- **On-hold tags** that defer every task carrying them.
- Four priority levels and a flag.
- **Basic filters** — completed, flagged, hide-deferred, hide-blocked, hide-on-hold, tags
  (any/all/none), priority, project, no-tags/no-project, due before/after.
- **Advanced filters** — a visual builder for **nested AND/OR/NOT** expressions across
  flagged, completed, priority (=/≥/≤), due-within/after-N-days, overdue, no-due-date,
  deferred, blocked, on-hold, has-tag, in-project, and title/note contains. Persisted per view.
- **Natural-language → filter (sync server)** — describe a filter in plain English and an LLM
  agent builds the expression for you to review.
- Sort by manual order, due date, priority, title or newest.
- Hierarchy can be preserved while filtering.

## Views & perspectives

- **Today**, **Inbox**, **Flagged**, **All**.
- **Forecast** — agenda ribbon + month-grid date picker.
- **Plan** — daily planner with a time **budget** (startup minutes + per-task estimates) vs
  the day.
- **Review** — per-project review intervals (GTD-style).
- **Time** — logged time as List / Timeline / Chart, grouped by project or day.
- **Tags** — browse by tag/context.
- **Nearby** — location-based task view **(sync server)**.
- **Saved perspectives** — saved view + sort + filter (basic or advanced) combinations in the
  sidebar.

## Customization & onboarding

- First-run **welcome picker**: Simple / Standard / Advanced UI complexity.
- **Settings → Features & UI complexity** — switch preset or go Custom and toggle individual
  feature surfaces (filter & sort bar, Show bar, GTD Tools, Nearby, Forecast, Review, time
  tracking, saved views, tags, the assistant).
- **GTD Tools** bundles advanced filters, defer dates and task dependencies.
- **Separate desktop vs mobile** visibility per feature.
- The **task detail pane adapts** to your choices — sections default expanded/collapsed to
  match (Location with Nearby, Dependencies + defer-until with GTD Tools, Time tracking when
  enabled), with **Record time** always at the top. Presentation only; nothing is disabled.
- Appearance: light/dark mode, themes (**Light** / **Dark**, **ePaper**, **Gruvbox**, **Ayu**,
  **Nord**, **Catppuccin** — each with light and dark variants where applicable), and accent colors.
- Gestures & mobile: swipe-left action, pane gestures, right-edge action, count scope,
  per-row icon visibility.

## Editing

- **Undo / redo** — multi-level session stack (`Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z`, plus sidebar
  buttons) covering complete/reopen, flag, priority, add-to-Plan and delete. Undos apply as
  normal edits, so they sync.
- Delete with an inline **Undo** snackbar (shares the same stack).
- **Recently Deleted** — a sidebar view (shown whenever it has something in it) listing the
  last 30 days of deletes, newest first, so a delete is recoverable long after the snackbar
  and across reloads. One entry per delete: restoring a project or a task with sub-tasks
  brings the whole subtree back where it was. Restores are ordinary edits, so they sync — and
  they're undoable too.
- Inline title editing with rapid-entry (Enter creates the next sibling).

## Collaboration & multi-user (sync server)

- Multi-user workspaces (self-hosted or hosted).
- Share a whole project **or an individual task** (with inheritance to its subtree).
- **Multiple assignees** per task; auto-share on assign.
- Per-user read/write permissions.
- "Shared with me" surface.
- **Federation** (off by default) — share a project subtree with another workspace on the
  same host (L2) or a different Carbon server (L3). See [federation](federation.md).

## Notes, comments & attachments

- **First-class notes** (`type: note`) — dedicated items nestable like tasks, designed for
  writing rather than doing. They skip auto-complete when a parent task is completed, stay
  out of Today/CalDAV action surfaces, and convert either way (**task ↔ note**) without
  losing data.
- **Notes projects** — flip a project to **Notes** and it becomes a notebook: new items
  in it default to notes, and its editor keeps only Colour and Sharing. Reversible; no
  data is cleared either way.
- **Note rows** are ~2.5× a task row and read as cards — the note's first image, its
  title, and the first two lines of the body. Rows render a small generated
  **thumbnail**, never the full-size image. An empty note (no image, no text) stays a
  plain task-height row.
- Rich note editor (TipTap) with Markdown, inline images, autosave and conflict handling;
  **zip export** of all notes (Markdown + images) from Data backup.
- **Recipe notes** — flip a note to **Recipe** mode for a scaled read view (servings
  pills, ingredients beside procedure). Settings → Recipes picks the cup/spoon
  convention. **Optimise** rewrites messy Markdown into a parseable recipe via the
  LLM agent **(sync server)**; a copy-able browser-assistant prompt imports a recipe
  from a web page into Markdown that pastes straight in. Ingredient groups, method
  stages and a trailing Notes section are preserved and scale as prose.
- **Markdown** notes on tasks too (GFM).
- Comment threads with `@mentions` and inline images.
- Attachments on tasks and comments (local unlimited; ≤25 MB per file across sync).
- **Blob cache policy** **(sync server)** — per device, choose what syncs ahead of
  time: *On Load* (nothing), *Thumbnails* (default — lists render offline for
  kilobytes), or *All* (full offline copy). Anything not prefetched arrives on first
  display. The first two prune to an MB budget, least-recently-opened first; a manual
  **Clear cached files** never drops blobs the server hasn't received yet.
- Optional per-item **`metadata`** JSON (API + sync; readable in the side panel when set).

## Reminders & location

- Push reminders **(sync server)** via Web Push / FCM.
- **Local reminders with no server** (foreground scan as PWA, background as native app).
- **Location-aware reminders** **(sync server)** — every signed-in device reports its GPS as
  a toggleable source, plus Home Assistant zones; "nearest place" reminders geofence to the
  closest match without coordinates.
- Background geofencing (native app, or via the sync server).

## Time tracking & review

- Built-in time tracking: per-user project sessions + task segments + pauses, CSV reporting
  via the **Time** view (List / Timeline / Chart).
- **Retroactive editing** — merge accidental restart gaps, merge with a previous block,
  trim or split untracked gaps, edit segment start/length (numeric fields or drag handles),
  remove segments, and add a task into any gap.
- **Time notes** — pin a timestamped note from the timer bar (or agent API) into the active
  block; deleting offers *from block only* or *delete note*.
- Opt-in **GPS tracks** while a timer runs (Settings → Reminders & location): denoised point
  stream attached as a JSON blob on a time note. **Android** continues in the background via
  a foreground-service notification; web/desktop record while the app is open.
- Estimated duration per task, feeding the Plan budget.
- Per-project review intervals.

## Capture & input

- Quick-add bar with inline tokens: `#tag`, `@user`, `!priority`, with autocomplete.
- **Natural-language commands (sync server)** — keyword-triggered in the add box, run as a
  server-side LLM tool loop (add/complete/delete/rename/tag/schedule/share/assign/timers/
  geofence/nearby, whole-list and whole-tag ops, due/overdue queries), with per-command
  token tracking.
- **Desktop quick-add** — global hotkey (`Ctrl/⌘+Shift+A`) + system-tray spotlight on Linux
  and Windows.

## AI & agents (sync server)

- Bot/agent accounts backed by **OpenAI / Anthropic** direct integration or an
  **agentic-framework webhook** (Hermes / OpenClaw).
- Server-side tool loop so API keys and prompts never reach the client.
- In-app NL commands, NL → filter, `@mention`/assign agent triggers, and configurable agent
  prompts.
- **Telegram bot** — one per server, per-user linking, conversational replies via your own
  agent.
- **LLM included on hosted plans** — natural-language capture, NL → filter and the Telegram
  bot work out of the box on a **basic model** (currently GPT-OSS-20B, may change) under
  **fair-use limits**, with no API key. Self-hosters (and anyone wanting higher limits or a
  stronger model) bring their own OpenAI / Anthropic / webhook key.

## Integrations & API (sync server)

- Full **REST API** with scoped tokens.
- **Agent API** (`/api/agent/*`) for external bots.
- Outbound **webhooks** (agent webhooks).
- **CalDAV sync** (VTODO + VEVENT) per project.
- First-class **Home Assistant** integration (capture, geofencing, per-device locations,
  "nearest place" reminders, two-way flows).

## Keyboard & gestures

- App-wide shortcuts: `g`-leader navigation, focus quick-add (`c` / `/`), undo/redo, scroll.
- Full outline/list keyboard navigation (move, reorder, indent/outdent, complete, open
  detail, inline edit).
- Touch gestures: swipe-right to complete, configurable swipe-left, pane gestures, right-edge
  jump, row quick-menu.

## Security & data ownership

- Local-only mode keeps everything on the device — nothing leaves until you configure a sync
  server.
- TLS in transit; workspace isolation and session-token auth on the server.
- **Mandatory sync 2FA (sync server)** — enroll email one-time codes and/or an authenticator
  app; either factor unlocks a new device. Trusted devices skip 2FA until reset. Humans use
  session tokens after password + 2FA; integrations keep scoped `carbon_*` API tokens.
- Soft-delete and admin password reset revoke sessions (and API tokens on delete).
- No account required for local use; full data export at any time. See
  [data security](data-security.md).
