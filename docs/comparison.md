# App comparison

Competitor details reflect early 2026.

## Platform, hosting & data ownership

| Specific                             | Carbon                                                                                                                  | Todoist                                        | OmniFocus                                              | MS To Do                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| Hosting model                        | **Self-hosted**, fully local, or Cloud Sync                                                                             | Cloud SaaS only                                | Omni Sync / WebDAV (no self-host)                      | Microsoft cloud only        |
| Offline capability                   | **Offline-first**; full DB in browser                                                                                   | Offline cache, online-centric                  | Local-first, syncs                                     | Online-centric with cache   |
| Sync mechanism                       | **Op-log CRDT** (sync server)                                                                                           | Proprietary Sync API                           | Encrypted database sync                                | Microsoft Graph sync        |
| **End-to-end / zero-knowledge sync** | ✗ (TLS in transit; trusted sync server model; deliberate trade-off for server-side integrations and sharing)            | ✗                                              | ✓ **zero-knowledge** encrypted                         | ✗                           |
| Data export                          | **Full local export/import** of entire DB + attachment blobs; **copy any project/task subtree as a Markdown checklist** | JSON/CSV, Sync API                             | Backups, TaskPaper, archive                            | Limited / none              |
| Account required                     | None (local-only) or account on a sync server                                                                           | Todoist account                                | Omni account for sync                                  | Microsoft account mandatory |
| Clients                              | Web/PWA **installable**, Win, **Linux**, Android (macOS / iOS planned)                                              | Web, Win, Mac, iOS, Android, watch, extensions | Mac, iPad, iPhone, Watch, web — **no Android/Windows** | Win, Mac, web, iOS, Android |

## Task structure & hierarchy

| Specific                            | Carbon                                                 | Todoist          | OmniFocus                             | MS To Do                |
| ----------------------------------- | ------------------------------------------------------ | ---------------- | ------------------------------------- | ----------------------- |
| Projects                            | ✓ **plus any item is a container**                     | ✓ + sub-projects | ✓                                     | "Lists" only            |
| Sequential / parallel project types | ✓                                                      | ✗                | ✓                                     | ✗                       |
| "Next action" / availability model  | ✓                                                      | ✗                | ✓                                     | ✗                       |
| Sub-task nesting depth              | **Unlimited**                                          | Multiple levels  | **Unlimited**                         | **One level** ("Steps") |
| Sections within a project           | Via nesting                                            | ✓ explicit       | Via action groups                     | ✗                       |
| Drag to re-order                    | ✓                                                      | ✓                | ✓                                     | ✓                       |
| Drag to re-nest (change parent)     | ✓                                                      | ✓                | ✓                                     | ✗                       |
| Inbox / unfiled capture             | ✓                                                      | ✓                | ✓                                     | "Tasks" list            |
| Task status states                  | active / done / **dropped**, plus **on-hold via tags** | done / not       | active / done / **dropped / on-hold** | done / not              |
| Focus / scope to one container      | ✓                                                      | ✗                | ✓ (Pro)                               | ✗                       |

## Scheduling: dates, defer, recurrence, reminders

| Specific                                                        | Carbon | Todoist      | OmniFocus               | MS To Do |
| --------------------------------------------------------------- | ------ | ------------ | ----------------------- | -------- |
| Due date                                                        | ✓      | ✓            | ✓                       | ✓        |
| Defer / start date (hide until)                                 | ✓      | ✗            | ✓                       | ✗        |
| Separate **reminder time** (≠ due)                              | ✓      | ✓            | Due/defer notifications | ✓        |
| Recurrence                                                      | ✓      | ✓            | ✓                       | ✓        |
| **Ordinal / complex patterns** (e.g. "2nd Tue", "last weekday") | ✓      | ✓            | ✓                       | Partial  |
| **Completion-relative recurrence**                              | ✓      | ✓ ("every!") | ✓                       | Partial  |
| Time-of-day on due                                              | ✓      | ✓            | ✓                       | ✓        |

## Organization: tags, priority, flags, filtering

| Specific                                                               | Carbon                                                                                                            | Todoist                 | OmniFocus                                          | MS To Do         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------- | ---------------- |
| Tags / labels                                                          | ✓ multi, **colored**, **nestable**, synced family-wide                                                            | ✓ labels, colored       | ✓ multiple, **nestable**                           | `#hashtags` only |
| Tag "on hold" (defer all tasks w/ tag)                                 | ✓                                                                                                                 | ✗                       | ✓                                                  | ✗                |
| Priority levels                                                        | **4**                                                                                                             | **4**                   | ✗                                                  | ✗                |
| Flag                                                                   | ✓                                                                                                                 | ✗ (can use P1)          | ✓                                                  | ✓ "Important"    |
| Saved views / Perspectives                                             | ✓ (basic **or** advanced filters persist per view)                                                                | ✓ saved filters (query) | ✓ (Pro)                                            | Smart lists only |
| Perspective rule power                                                 | Sort + basic filters, **plus advanced nested AND/OR/NOT** across due/defer/priority/flag/tags/project/status/text | Query language          | **Arbitrary rule trees** + custom grouping/sorting | ✗                |
| **Advanced boolean filters** (nested AND/OR/NOT groups)                | ✓ visual builder, any attribute                                                                                   | Via query language      | ✓ rule trees                                       | ✗                |
| **Natural-language → filter** (describe it, LLM builds the expression) | ✓ (sync server)                                                                                                   | ✗                       | ✗                                                  | ✗                |
| Filter by tag (multi)                                                  | ✓                                                                                                                 | ✓                       | ✓                                                  | ✗                |
| Filter by priority (multi)                                             | ✓                                                                                                                 | ✓                       | ✓                                                  | ✗                |
| Filter by project (multi)                                              | ✓                                                                                                                 | ✓                       | ✓                                                  | ✗                |
| **No tags / No project**                                               | ✓                                                                                                                 | Via query               | ✓                                                  | ✗                |
| Due before/after a date                                                | ✓                                                                                                                 | ✓                       | ✓                                                  | ✗                |
| Hide deferred (future start)                                           | ✓                                                                                                                 | ✗                       | ✓                                                  | ✗                |
| Sort options                                                           | Manual/Due/Priority/Title/Newest                                                                                  | Multiple                | Rule-based                                         | Limited          |
| Hierarchy preserved while filtering                                    | ✓ (Optional)                                                                                                      | Partial                 | ✓                                                  | n/a              |

## Collaboration & multi-user

| Specific                          | Carbon                                    | Todoist           | OmniFocus         | MS To Do           |
| --------------------------------- | ----------------------------------------- | ----------------- | ----------------- | ------------------ |
| Multi-user                        | ✓ self-hosted or hosted sync workspaces   | ✓                 | **✗ single-user** | ✓                  |
| Share a project                   | ✓ (sync server)                           | ✓                 | ✗                 | ✓                  |
| Share an **individual task**      | ✓ (+ inheritance to subtree, sync server) | ✗ (project-level) | ✗                 | ✗                  |
| Assignees                         | ✓ **multiple** (sync server)              | ✓ **one**         | ✗                 | ✓ (in shared list) |
| Per-user permissions (read/write) | ✓ (sync server)                           | Limited           | ✗                 | Basic              |
| Auto-share on assign              | ✓ (sync server)                           | n/a               | n/a               | n/a                |
| "Shared with me"                  | ✓ (sync server)                           | ✓                 | ✗                 | ✓                  |

## Notes, comments, attachments

| Specific                | Carbon                                                                  | Todoist          | OmniFocus   | MS To Do               |
| ----------------------- | ----------------------------------------------------------------------- | ---------------- | ----------- | ---------------------- |
| Task notes              | ✓ **Markdown**                                                          | ✓ **Markdown**   | ✓ rich text | ✓ plain                |
| **First-class notes**   | ✓ dedicated `note` items, TipTap editor, **notes projects**, card rows + thumbnails, **convert task ↔ note**, zip export | ✗ (tasks only) | ✗           | ✗                      |
| **Recipe notes**        | ✓ scaled servings view, Optimise rewrite (sync server), import prompt, ingredient groups / method stages / Notes | ✗                | ✗           | ✗                      |
| Comments thread         | ✓ Markdown + `@mentions`                                                | ✓ (Pro for more) | ✗           | ✗                      |
| Attachments on tasks    | ✓ Unlimited local (<25MB per file sync)                                 | ✓ (Pro larger)   | ✓           | ✓ via OneDrive (≤25MB) |
| Attachments on comments | ✓ (incl. inline images)                                                 | ✓                | ✗           | ✗                      |
| Markdown rendering      | ✓ (GFM)                                                                 | Partial          | ✗           | ✗                      |

## Reminders & location

| Specific                       | Carbon                                                                            | Todoist         | OmniFocus    | MS To Do |
| ------------------------------ | --------------------------------------------------------------------------------- | --------------- | ------------ | -------- |
| Push reminders                 | ✓ (sync server)                                                                   | ✓ (Pro)         | ✓            | ✓        |
| **Local reminders, no server** | ✓ (Foreground as PWA, Background as App)                                          | ✗               | ✓            | ✗        |
| Location reminders             | ✓ + external location sources (sync server)                                       | ✓ (Pro)         | ✓ (iOS)      | ✗        |
| Multi-device location store    | ✓ each device reports GPS to server; **Nearby view** shows tasks at your location | ✗               | ✗            | ✗        |
| Background geofence            | ✓ app or via sync server                                                          | ✓ native mobile | ✓ native iOS | ✗        |

## Time tracking & review

| Specific                               | Carbon                                                                                                                                                                                              | Todoist | OmniFocus          | MS To Do |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------ | -------- |
| Built-in **time tracking** (timers)    | ✓ **project sessions + task segments + pauses**, per-user; Time view (list/timeline/chart); **merge/split/segment edit**; **time notes**; CSV reporting                                              | ✗       | ✗ (estimates only) | ✗        |
| **GPS tracks on sessions**             | ✓ opt-in; background on Android via foreground service; track blob + summary on a time note                                                                                                         | ✗       | ✗                  | ✗        |
| **Estimated duration**                 | ✓                                                                                                                                                                                                   | ✗       | ✓                  | ✗        |
| **Review mode** (per-project interval) | ✓                                                                                                                                                                                                   | ✗       | ✓                  | ✗        |
| Productivity stats / karma             | ✗                                                                                                                                                                            | ✓ Karma | ✗                  | ✗        |

## Capture & input

| Specific                      | Carbon                                                                 | Todoist                         | OmniFocus     | MS To Do          |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------- | ------------- | ----------------- |
| Quick-add inline tokens       | ✓ `#tag` `@user` `!priority` w/ autocomplete; full NLP via sync server | ✓ **full NLP**                  | ✓ (dates)     | Basic             |
| Natural-language **commands** | ✓ LLM-backed: add/complete/delete/rename/tag/schedule/share, list & due queries (sync server) | ✓ "AI Assistant" (Pro, limited) | ✗             | ✗                 |
| Natural-language **dates**    | ✓ via LLM command flow (sync server)                                   | ✓                               | ✓             | ✓ partial         |
| Email-to-task                 | ✗                                               | ✓                               | ✓ (Mail drop) | ✓ (flagged email) |

## Views

| Specific                                    | Carbon                                                 | Todoist              | OmniFocus                  | MS To Do  |
| ------------------------------------------- | ------------------------------------------------------ | -------------------- | -------------------------- | --------- |
| List view                                   | ✓                                                      | ✓                    | ✓                          | ✓         |
| Tree / outline                              | ✓                                                      | Partial              | ✓                          | ✗         |
| Kanban board                                | ✗                               | ✓                    | ✗                          | ✗         |
| Calendar / Forecast                         | ✓ **Forecast**                                         | ✓                    | ✓ **Forecast**             | "Planned" |
| Forecast shows **external calendar events** | ✗ (CalDAV sync exists, but no in-app calendar overlay) | ✓ Partial (cal sync) | ✓ system calendar overlaid | ✗         |
| **Nearby** (location-based task view)       | ✓                                                      | ✗                    | ✗                          | ✗         |
| **Recently Deleted**                        | ✓ restore tombstones for 30 days (`g` `d`)             | Partial              | ✓                          | Partial   |
| Smart lists                                 | ✓                                                      | ✓                    | ✓                          | ✓         |
| Daily planner ("My Day")                    | ✓                                                      | Partial              | ✗                          | ✓         |

## Automation, API & integrations

| Specific                          | Carbon                                                                                       | Todoist          | OmniFocus                     | MS To Do            |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ---------------- | ----------------------------- | ------------------- |
| Public REST API                   | ✓ (sync server)                                                                              | ✓ REST + Sync    | URL schemes / Omni Automation | ✓ Graph             |
| **NL agent API** (`/api/agent/*`) | ✓ add/complete/tag/schedule/share/assign/timers/geofence/nearby/filter/geocode (sync server) | ✗                | ✗                             | ✗                   |
| Scoped API tokens                 | ✓ (sync server)                                                                              | ✓ (one)          | n/a                           | OAuth               |
| Webhooks (outbound)               | ✓ (agent webhooks, sync server)                                                              | ✓                | ✗                             | Graph subscriptions |
| **CalDAV sync** (VTODO + VEVENT)  | ✓ **per project** (sync server)                                                              | ✓                | ✓                             | ✓                   |
| Scripting/automation              | REST + agents + NL commands (sync server)                                                    | Integrations     | ✓ Omni Automation             | Power Automate      |
| Smart-home integration            | ✓ via API + **Home Assistant** (sync server)                                                 | Via IFTTT/Zapier | ✗                             | Via Power Automate  |
| Integration marketplace           | REST + agent tooling (sync server)                                                           | ✓                | Limited                       | MS ecosystem        |

## AI / agents

| Specific                           | Carbon                                                                       | Todoist                       | OmniFocus | MS To Do             |
| ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | --------- | -------------------- |
| Bot/agent accounts                 | ✓ (sync server)                                                              | ✗                             | ✗         | ✗                    |
| Direct LLM integration             | ✓ **OpenAI/Anthropic/webhook agents** (sync server)                          | "AI Assistant" (Pro, limited) | ✗         | Copilot (peripheral) |
| **In-app NL commands**             | ✓ **keyword-triggered Add box → LLM tool loop** (sync server)                | ✗                             | ✗         | ✗                    |
| **Telegram bot**                   | ✓ **per-server bot, per-user linking, conversational replies** (sync server) | Via integrations              | ✗         | ✗                    |
| **Agentic-framework webhook**      | ✓ **Generic external webhook path** (sync server)                  | ✗                             | ✗         | ✗                    |
| Trigger agent by `@mention`/assign | ✓ (sync server)                                                              | ✗                             | ✗         | ✗                    |
| Configurable agent prompt          | ✓ (sync server)                                                              | ✗                             | ✗         | ✗                    |

## Native platform integration, capture & maturity

| Specific                                  | Carbon                                                     | Todoist                       | OmniFocus                           | MS To Do                 |
| ----------------------------------------- | ---------------------------------------------------------- | ----------------------------- | ----------------------------------- | ------------------------ |
| Track record / maturity                   | Newer, actively developed, **Fully OSS**                   | Established, large team       | Established       | Microsoft-backed         |
| Native apps                               | Web, PWA, **Linux**, Win, Android (macOS / iOS planned) | ✓ Web, Win, Mac, Android, iOS | ✓ **native** Mac, iOS + limited web | ✓ Win, Mac, Android, iOS |
| Apple Watch / wearable                    | ✗                                   | ✓                             | ✓                                   | ✓                        |
| Home-screen **widgets**                   | ✗                                   | ✓                             | ✓                                   | ✓                        |
| **Gemini / Siri / Shortcuts / voice**     | ✗                                   | ✓                             | ✓ deep                              | ✓ (Cortana/Copilot)      |
| OS **share sheet** capture                | ✗                                   | ✓                             | ✓                                   | ✓                        |
| System-wide **quick capture** hotkey      | ✓ **desktop** `Ctrl+Shift+A`                               | ✓                             | ✓ (Quick Entry)                     | Partial                  |
| Background reminders **without a server** | ✓ (foreground in web/PWA; background in native apps)       | ✓                             | ✓                                   | ✓                        |
| Notification reliability                  | Web Push (sync server) / foreground scan / OS-level in app | ✓ OS-level                    | ✓ OS-level                          | ✓ OS-level               |
| Scripting options                         | ✓ REST + agents (sync server)                              | Integrations                  | ✓ Omni Automation                   | Power Automate           |

## Customization, onboarding & editing

| Specific                                                                                              | Carbon                                                                | Todoist              | OmniFocus         | MS To Do |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------- | ----------------- | -------- |
| **UI complexity presets** (Simple / Standard / Advanced)                                              | ✓ chosen on first run, changeable anytime                             | ✗                    | ✗                 | ✗        |
| **Show/hide individual features** (filter bar, Nearby, Forecast, Review, time tracking, assistant, …) | ✓ per-feature toggles                                                 | Limited              | Some layout prefs | ✗        |
| **Separate desktop vs mobile** feature visibility                                                     | ✓                                                                     | ✗                    | ✗                 | ✗        |
| First-run setup picker                                                                                | ✓                                                                     | ✓ onboarding         | ✓                 | ✓        |
| **Undo / redo**                                                                                       | ✓ multi-level session stack (`Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z`) + buttons | ✓ recent-action undo | ✓ full undo/redo  | Partial  |
| **Sync UI settings & saved views across devices**                                                     | ✓ optional, on by default; pulled on first sign-in (sync server)      | ✓                    | ✓                 | ✓        |

## Pricing & availability

| Specific           | Carbon                                | Todoist                            | OmniFocus                  | MS To Do  |
| ------------------ | ------------------------------------- | ---------------------------------- | -------------------------- | --------- |
| Cost               | Free self-hosting; optional paid hosting | Free + Pro + Business              | Paid (one-time/sub)        | **Free**  |
| Paywalled features | **None**                              | Reminders/filters/comments/uploads | Custom perspectives, Focus | **None**  |
| Vendor lock-in     | **None**, Fully OSS, Markdown Export  | Cloud                              | Omni ecosystem             | Microsoft |
