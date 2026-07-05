# Carbon vs Todoist vs OmniFocus vs Microsoft To Do

In-depth, feature-specific comparison. The **Carbon** column reflects what's actually
in this codebase. Competitor details are accurate to early **2026** — these are
fast-moving cloud apps, so verify any single dealbreaker against current docs.

> **Project context (important).** Carbon was originally built to support real internal
> workflows for Emmertex and its employees' families: GTD-capable task management with true
> task-level time tracking for timesheets and invoicing. It is now being documented for broader
> evaluation, but its shape still reflects that practical, operations-first origin.

> **Read this first — honest framing.** Carbon is a self-hosted, offline-first task
> manager. The apps it's measured against are mature, commercially-supported products with
> years of polish, large user bases, and full native client suites. **OmniFocus in
> particular is the GTD reference implementation**, and the standard the GTD community
> measures everything else by. This table exists to map Carbon's strengths _and_ its
> gaps honestly, not to declare a winner. Where a cell reads `✓` for Carbon next to `✓`
> for a competitor, the capability exists but may be **narrower, broader or newer** than the
> incumbent's. If one feature is key to you, check out their own solutions for yourself.
> Read [Where Carbon falls short](#where-carbon-falls-short) and
> [Where Carbon holds its own](#where-carbon-holds-its-own) before the feature tables.

> This document is living — we update it as Carbon's features evolve. Cross-check any
> must-have item against the current release notes and docs when making a decision.

## 1. Platform, hosting & data ownership

| Specific                             | Carbon                                                                                                                  | Todoist                                        | OmniFocus                                              | MS To Do                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| Hosting model                        | **Self-hosted**, fully local, or Cloud Sync                                                                             | Cloud SaaS only                                | Omni Sync / WebDAV (no self-host)                      | Microsoft cloud only        |
| Offline capability                   | **Offline-first**; full DB in browser                                                                                   | Offline cache, online-centric                  | Local-first, syncs                                     | Online-centric with cache   |
| Sync mechanism                       | **Op-log CRDT** (sync server)                                                                                           | Proprietary Sync API                           | Encrypted database sync                                | Microsoft Graph sync        |
| **End-to-end / zero-knowledge sync** | ✗ (TLS in transit; trusted sync server model; deliberate trade-off for server-side integrations and sharing)            | ✗                                              | ✓ **zero-knowledge** encrypted                         | ✗                           |
| Data export                          | **Full local export/import** of entire DB + attachment blobs; **copy any project/task subtree as a Markdown checklist** | JSON/CSV, Sync API                             | Backups, TaskPaper, archive                            | Limited / none              |
| Account required                     | None (local-only) or account on a sync server                                                                           | Todoist account                                | Omni account for sync                                  | Microsoft account mandatory |
| Clients                              | Web/PWA **installable**, Win, **Linux**, Android (macOS and iOS planned)                                                | Web, Win, Mac, iOS, Android, watch, extensions | Mac, iPad, iPhone, Watch, web — **no Android/Windows** | Win, Mac, web, iOS, Android |

## 2. Task structure & hierarchy

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

## 3. Scheduling: dates, defer, recurrence, reminders

| Specific                                                        | Carbon | Todoist      | OmniFocus               | MS To Do |
| --------------------------------------------------------------- | ------ | ------------ | ----------------------- | -------- |
| Due date                                                        | ✓      | ✓            | ✓                       | ✓        |
| Defer / start date (hide until)                                 | ✓      | ✗            | ✓                       | ✗        |
| Separate **reminder time** (≠ due)                              | ✓      | ✓            | Due/defer notifications | ✓        |
| Recurrence                                                      | ✓      | ✓            | ✓                       | ✓        |
| **Ordinal / complex patterns** (e.g. "2nd Tue", "last weekday") | ✓      | ✓            | ✓                       | Partial  |
| **Completion-relative recurrence**                              | ✓      | ✓ ("every!") | ✓                       | Partial  |
| Time-of-day on due                                              | ✓      | ✓            | ✓                       | ✓        |

## 4. Organization: tags, priority, flags, filtering

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

## 5. Collaboration & multi-user

| Specific                          | Carbon                                    | Todoist           | OmniFocus         | MS To Do           |
| --------------------------------- | ----------------------------------------- | ----------------- | ----------------- | ------------------ |
| Multi-user                        | ✓ self-hosted or hosted sync workspaces   | ✓                 | **✗ single-user** | ✓                  |
| Share a project                   | ✓ (sync server)                           | ✓                 | ✗                 | ✓                  |
| Share an **individual task**      | ✓ (+ inheritance to subtree, sync server) | ✗ (project-level) | ✗                 | ✗                  |
| Assignees                         | ✓ **multiple** (sync server)              | ✓ **one**         | ✗                 | ✓ (in shared list) |
| Per-user permissions (read/write) | ✓ (sync server)                           | Limited           | ✗                 | Basic              |
| Auto-share on assign              | ✓ (sync server)                           | n/a               | n/a               | n/a                |
| "Shared with me"                  | ✓ (sync server)                           | ✓                 | ✗                 | ✓                  |

## 6. Notes, comments, attachments

| Specific                | Carbon                                  | Todoist          | OmniFocus   | MS To Do               |
| ----------------------- | --------------------------------------- | ---------------- | ----------- | ---------------------- |
| Task notes              | ✓ **Markdown**                          | ✓ **Markdown**   | ✓ rich text | ✓ plain                |
| Comments thread         | ✓ Markdown + `@mentions`                | ✓ (Pro for more) | ✗           | ✗                      |
| Attachments on tasks    | ✓ Unlimited local (<25MB per file sync) | ✓ (Pro larger)   | ✓           | ✓ via OneDrive (≤25MB) |
| Attachments on comments | ✓ (incl. inline images)                 | ✓                | ✗           | ✗                      |
| Markdown rendering      | ✓ (GFM)                                 | Partial          | ✗           | ✗                      |

## 7. Reminders & location

| Specific                       | Carbon                                                                            | Todoist         | OmniFocus    | MS To Do |
| ------------------------------ | --------------------------------------------------------------------------------- | --------------- | ------------ | -------- |
| Push reminders                 | ✓ (sync server)                                                                   | ✓ (Pro)         | ✓            | ✓        |
| **Local reminders, no server** | ✓ (Foreground as PWA, Background as App)                                          | ✗               | ✓            | ✗        |
| Location reminders             | ✓ + external location sources (sync server)                                       | ✓ (Pro)         | ✓ (iOS)      | ✗        |
| Multi-device location store    | ✓ each device reports GPS to server; **Nearby view** shows tasks at your location | ✗               | ✗            | ✗        |
| Background geofence            | ✓ app or via sync server                                                          | ✓ native mobile | ✓ native iOS | ✗        |

## 8. Time tracking & review

| Specific                               | Carbon                                                                                                                                      | Todoist | OmniFocus          | MS To Do |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------ | -------- |
| Built-in **time tracking** (timers)    | ✓ **project sessions + task segments + pauses**, per-user, with a Time-Tracked view (list/timeline), retroactive editing, and CSV reporting | ✗       | ✗ (estimates only) | ✗        |
| **Estimated duration**                 | ✓                                                                                                                                           | ✗       | ✓                  | ✗        |
| **Review mode** (per-project interval) | ✓                                                                                                                                           | ✗       | ✓                  | ✗        |
| Productivity stats / karma             | ✗ (not in current build)                                                                                                                    | ✓ Karma | ✗                  | ✗        |

## 9. Capture & input

| Specific                      | Carbon                                                                 | Todoist                         | OmniFocus     | MS To Do          |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------- | ------------- | ----------------- |
| Quick-add inline tokens       | ✓ `#tag` `@user` `!priority` w/ autocomplete; full NLP via sync server | ✓ **full NLP**                  | ✓ (dates)     | Basic             |
| Natural-language **commands** | ✓ LLM-backed command flow (sync server)                                | ✓ "AI Assistant" (Pro, limited) | ✗             | ✗                 |
| Natural-language **dates**    | ✓ via LLM command flow (sync server)                                   | ✓                               | ✓             | ✓ partial         |
| Email-to-task                 | ✗ (not in current build)                                               | ✓                               | ✓ (Mail drop) | ✓ (flagged email) |

## 10. Views

| Specific                                    | Carbon                                                 | Todoist              | OmniFocus                  | MS To Do  |
| ------------------------------------------- | ------------------------------------------------------ | -------------------- | -------------------------- | --------- |
| List view                                   | ✓                                                      | ✓                    | ✓                          | ✓         |
| Tree / outline                              | ✓                                                      | Partial              | ✓                          | ✗         |
| Kanban board                                | ✗ (not in current build)                               | ✓                    | ✗                          | ✗         |
| Calendar / Forecast                         | ✓ **Forecast**                                         | ✓                    | ✓ **Forecast**             | "Planned" |
| Forecast shows **external calendar events** | ✗ (CalDAV sync exists, but no in-app calendar overlay) | ✓ Partial (cal sync) | ✓ system calendar overlaid | ✗         |
| **Nearby** (location-based task view)       | ✓                                                      | ✗                    | ✗                          | ✗         |
| Smart lists                                 | ✓                                                      | ✓                    | ✓                          | ✓         |
| Daily planner ("My Day")                    | ✓                                                      | Partial              | ✗                          | ✓         |

## 11. Automation, API & integrations

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

## 12. AI / agents

| Specific                           | Carbon                                                                       | Todoist                       | OmniFocus | MS To Do             |
| ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | --------- | -------------------- |
| Bot/agent accounts                 | ✓ (sync server)                                                              | ✗                             | ✗         | ✗                    |
| Direct LLM integration             | ✓ **OpenAI/Anthropic/webhook agents** (sync server)                          | "AI Assistant" (Pro, limited) | ✗         | Copilot (peripheral) |
| **In-app NL commands**             | ✓ **keyword-triggered Add box → LLM tool loop** (sync server)                | ✗                             | ✗         | ✗                    |
| **Telegram bot**                   | ✓ **per-server bot, per-user linking, conversational replies** (sync server) | Via integrations              | ✗         | ✗                    |
| **Agentic-framework webhook**      | ✓ **Hermes/OpenClaw-compatible webhook path** (sync server)                  | ✗                             | ✗         | ✗                    |
| Trigger agent by `@mention`/assign | ✓ (sync server)                                                              | ✗                             | ✗         | ✗                    |
| Configurable agent prompt          | ✓ (sync server)                                                              | ✗                             | ✗         | ✗                    |

## 13. Native platform integration, capture & maturity

| Specific                                  | Carbon                                                     | Todoist                       | OmniFocus                           | MS To Do                 |
| ----------------------------------------- | ---------------------------------------------------------- | ----------------------------- | ----------------------------------- | ------------------------ |
| Track record / maturity                   | Newer, actively developed, **Fully OSS**                   | Established, large team       | **Mature, GTD Gold Standard**       | Microsoft-backed         |
| Native apps                               | Web, PWA, **Linux**, Win, Android (macOS and iOS planned)  | ✓ Web, Win, Mac, Android, iOS | ✓ **native** Mac, iOS + limited web | ✓ Win, Mac, Android, iOS |
| Apple Watch / wearable                    | ✗ (not in current build)                                   | ✓                             | ✓                                   | ✓                        |
| Home-screen **widgets**                   | ✗ (not in current build)                                   | ✓                             | ✓                                   | ✓                        |
| **Gemini / Siri / Shortcuts / voice**     | ✗ (not in current build)                                   | ✓                             | ✓ deep                              | ✓ (Cortana/Copilot)      |
| OS **share sheet** capture                | ✗ (not in current build)                                   | ✓                             | ✓                                   | ✓                        |
| System-wide **quick capture** hotkey      | ✓ **desktop** `Ctrl+Shift+A`                               | ✓                             | ✓ (Quick Entry)                     | Partial                  |
| Background reminders **without a server** | ✓ (foreground in web/PWA; background in native apps)       | ✓                             | ✓                                   | ✓                        |
| Notification reliability                  | Web Push (sync server) / foreground scan / OS-level in app | ✓ OS-level                    | ✓ OS-level                          | ✓ OS-level               |
| Scripting options                         | ✓ REST + agents (sync server)                              | Integrations                  | ✓ Omni Automation                   | Power Automate           |

## 14. Customization, onboarding & editing

| Specific                                                                                              | Carbon                                                                | Todoist              | OmniFocus         | MS To Do |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------- | ----------------- | -------- |
| **UI complexity presets** (Simple / Standard / Advanced)                                              | ✓ chosen on first run, changeable anytime                             | ✗                    | ✗                 | ✗        |
| **Show/hide individual features** (filter bar, Nearby, Forecast, Review, time tracking, assistant, …) | ✓ per-feature toggles                                                 | Limited              | Some layout prefs | ✗        |
| **Separate desktop vs mobile** feature visibility                                                     | ✓                                                                     | ✗                    | ✗                 | ✗        |
| First-run setup picker                                                                                | ✓                                                                     | ✓ onboarding         | ✓                 | ✓        |
| **Undo / redo**                                                                                       | ✓ multi-level session stack (`Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z`) + buttons | ✓ recent-action undo | ✓ full undo/redo  | Partial  |
| **Sync UI settings & saved views across devices**                                                     | ✓ optional, on by default; pulled on first sign-in (sync server)      | ✓                    | ✓                 | ✓        |

## 15. Pricing & availability

| Specific           | Carbon                                | Todoist                            | OmniFocus                  | MS To Do  |
| ------------------ | ------------------------------------- | ---------------------------------- | -------------------------- | --------- |
| Cost               | **Free / self-hosted / paid-hosting** | Free + Pro + Business              | Paid (one-time/sub)        | **Free**  |
| Paywalled features | **None**                              | Reminders/filters/comments/uploads | Custom perspectives, Focus | **None**  |
| Vendor lock-in     | **None**, Fully OSS, Markdown Export  | Cloud                              | Omni ecosystem             | Microsoft |

---

## Where Carbon falls short

The honest list of what you give up by choosing Carbon today.

**Against mature native incumbents (especially OmniFocus):**

- **Native depth is still behind.** Carbon has desktop + Android shells and a strong web app, but
  no iOS release yet, no Watch app, no mobile widgets, and no Siri/Shortcuts-grade integration.
- **Forecast is task-centric.** Carbon syncs calendars via CalDAV, but does not currently overlay
  external calendar events directly inside Forecast.
- **Saved views are powerful but not fully "Omni-grade".** Carbon has advanced nested filters,
  but not arbitrary custom grouping/sorting rules per perspective.
- **Reliability history is younger.** Carbon is actively developed, but it has not yet had the
  same multi-year enterprise-scale proof as older commercial products.

**Against Todoist and Microsoft To Do specifically:**

- **Ecosystem breadth.** Carbon offers API + agent-driven integrations, but does not have a large
  one-click marketplace footprint like incumbent SaaS products.
- **Discoverability is still limited.** External distribution is catching up to mature
  incumbents (Google Play rollout underway), so Carbon is simply harder to find than the
  big-brand apps.
- **Polished platform extras.** Mobile widgets, share-sheet capture, and voice-assistant flows are
  still weaker than mainstream consumer task apps.
- **Brand/support expectations.** Carbon is open-source and self-host friendly, but some teams will
  still prefer a large vendor's support model and market longevity.

## Where Carbon holds its own

Carbon's strongest differentiators, based on what is implemented in this repository today:

- **Ownership-first architecture:** offline-first local database, self-hostable sync, full export/import, open source.
- **GTD-heavy model without lock-in:** deep hierarchy, defer + due + reminders, recurrence, review workflows, dependencies.
- **Built-in execution tooling:** time tracking, estimates, daily planning budget, and review surfaces in one product.
- **Unusually strong time-accountability story:** true task-level tracking designed for practical
  timesheet and invoicing workflows, not just personal pomodoro-style timers.
- **Automation-first integration posture:** scoped REST API, `/api/agent/*`, Telegram bot path, Home Assistant, CalDAV.
- **Configurable complexity:** Simple/Standard/Advanced presets plus per-feature/per-device visibility.
- **Security stance is explicit, not accidental:** Carbon favors a trusted self-host/server model
  for features like CalDAV, LLM tooling, and sharing/federation; if you require distrust-by-default
  cryptography, this is the wrong architecture by design.

This section intentionally stays implementation-first: it describes what ships now, not roadmap promises.
