# Carbon vs Todoist vs OmniFocus vs Microsoft To Do

In-depth, feature-specific comparison. The **Carbon** column reflects what's actually
in this codebase. Competitor details are accurate to early **2026** — these are
fast-moving cloud apps, so verify any single dealbreaker against current docs.

> **Read this first — honest framing.** Carbon is a self-hosted, offline-first task
> manager. The apps it's measured against are mature, commercially-supported products with
> years of polish, large user bases, and full native client suites. **OmniFocus in
> particular is the GTD reference implementation** — and the standard the GTD community
> measures everything else by. This table exists to map Carbon's strengths *and* its
> gaps honestly, not to declare a winner. Where a cell reads `✓` for Carbon next to `✓`
> for a competitor, the capability exists but may be **narrower or newer** than the
> incumbent's. For a balanced read, see both
> [Where Carbon falls short](#where-carbon-falls-short) and
> [Where Carbon holds its own](#where-carbon-holds-its-own) before the feature tables.

> This document is living — we update it as Carbon's features evolve.

## 1. Platform, hosting & data ownership

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Hosting model | **Self-hosted** or fully local | Cloud SaaS only | Omni Sync / WebDAV (no self-host) | Microsoft cloud only |
| Offline capability | **Offline-first**; full DB in browser (sql.js→IndexedDB) | Offline cache, online-centric | Local-first, syncs | Online-centric with cache |
| Sync mechanism | **Op-log CRDT**: per-field LWW for tasks, row-level LWW + tombstones for shares/comments/tags; cursor + backfill | Proprietary Sync API | Encrypted database sync | Microsoft Graph sync |
| **End-to-end / zero-knowledge sync** | **✗** plaintext JSON on your server (TLS in transit only) | ✗ | ✓ **zero-knowledge** encrypted | ✗ |
| Data export | **Full local export/import** of entire DB + attachment blobs (single JSON) | JSON/CSV, Sync API | Backups, TaskPaper, archive | Limited / none |
| Account required | None (local) or your own users | Todoist account | Omni account for sync | Microsoft account mandatory |
| Clients | Web/PWA (installable) | Web, Win, Mac, iOS, Android, watch, extensions | Mac, iPad, iPhone, Watch, web — **no Android/Windows** | Win, Mac, web, iOS, Android |

## 2. Task structure & hierarchy

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Projects | ✓ (any item is a container) | ✓ + sub-projects | ✓ (sequential/parallel/single-action) | "Lists" only |
| Sequential / parallel project types |  ✓  | ✗ | ✓ | ✗ |
| "Next action" / availability model |  ✓  | ✗ | ✓ | ✗ |
| Sub-task nesting depth | **Unlimited** | Multiple levels | **Unlimited** (action groups) | **One level** ("Steps") |
| Sections within a project | Via nesting | ✓ explicit | Via action groups | ✗ |
| Drag to re-order | ✓ | ✓ | ✓ | ✓ |
| Drag to re-nest (change parent) | ✓ | ✓ | ✓ | ✗ |
| Inbox / unfiled capture | ✓ | ✓ | ✓ | "Tasks" list |
| Task status states | active / done | done / not | active / done / **dropped / on-hold** | done / not |
| Focus / scope to one container | ✓ | ✗ | ✓ (Pro) | ✗ |

## 3. Scheduling: dates, defer, recurrence, reminders

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Due date | ✓ | ✓ | ✓ | ✓ |
| Defer / start date (hide until) | ✓ + "Hide deferred" filter | ✗ | ✓ | ✗ |
| Separate **reminder time** (≠ due) | ✓ (own field, pushes at that time) | ✓ | Due/defer notifications | ✓ |
| Recurrence | Daily/Weekly/Monthly/Yearly × interval (+ multi-weekday) | **Natural-language**, most powerful | **Most flexible** | Daily/Weekly/Monthly/Yearly + custom |
| **Ordinal / complex patterns** (e.g. "2nd Tue", "last weekday") | **✗** | ✓ | ✓ | Partial |
| **Completion-relative recurrence** | ✓ "Repeat from completion date" | ✓ ("every!") | ✓ | Partial |
| Time-of-day on due | ✓ optional time (all-day default; overdue honours the time) | ✓ | ✓ | ✓ |

## 4. Organization: tags, priority, flags, filtering

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Tags / labels | ✓ multi, **colored**, **nestable**, synced family-wide | ✓ labels, colored | ✓ multiple, **nestable** | `#hashtags` only |
| Tag "on hold" (defer all tasks w/ tag) | ✓ | ✗ | ✓ | ✗ |
| Priority levels | **4** (None/Low/Med/High) | **4** (P1–P4) | Flag only | "Important" star only |
| Flag | ✓ | Via P1 | ✓ | "Important" |
| Saved views / **perspectives** | ✓ perspectives + per-project prefs | ✓ saved filters (query) | ✓ **custom perspectives** (Pro) | Smart lists only |
| Perspective rule power | Sort + flat filters; AND/OR/NOT on **tags only** | Query language | **Arbitrary rule trees** + custom grouping/sorting | ✗ |
| Filter by tag (multi) | ✓ | ✓ | ✓ | ✗ |
| Filter by priority (multi) | ✓ | ✓ | ✓ | ✗ |
| Filter by project (multi) | ✓ | ✓ | ✓ | ✗ |
| **No tags / No project** | ✓ | Via query | ✓ | ✗ |
| Due before/after a date | ✓ | ✓ | ✓ | ✗ |
| Hide deferred (future start) | ✓ | ✗ | ✓ | ✗ |
| Sort options | Manual/Due/Priority/Title/Newest | Multiple | Rule-based | Limited |
| Hierarchy preserved while filtering | ✓ (Optional) | Partial | ✓ | n/a |

## 5. Collaboration & multi-user

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Multi-user | ✓ self-hosted option | ✓ | **✗ single-user** | ✓ |
| Share a project | ✓ | ✓ | ✗ | ✓ |
| Share an **individual task** | ✓ (+ inheritance to subtree) | ✗ (project-level) | ✗ | ✗ |
| Assignees | ✓ **multiple** | ✓ **one** | ✗ | ✓ (in shared list) |
| Per-user permissions (read/write) | ✓ | Limited | ✗ | Basic |
| Auto-share on assign | ✓ | n/a | n/a | n/a |
| "Shared with me" | ✓ | ✓ | ✗ | ✓ |

## 6. Notes, comments, attachments

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Task notes | ✓ **Markdown**, click-to-edit | ✓ Markdown | ✓ rich text | ✓ plain |
| Comments thread | ✓ Markdown + `@mentions` | ✓ (Pro for more) | ✗ | ✗ |
| Attachments on tasks | ✓ Unlimited local (<25MB per file sync) | ✓ (Pro larger) | ✓ | ✓ via OneDrive (≤25MB) |
| Attachments on comments | ✓ (incl. inline images) | ✓ | ✗ | ✗ |
| Markdown rendering | ✓ (GFM) | Partial | ✗ | ✗ |

## 7. Reminders & location

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Push reminders | ✓ Web Push (VAPID) to owner+assignees | ✓ (Pro) | ✓ | ✓ |
| **Local reminders, no server** | ✓ foreground scan | ✗ | ✓ | ✗ |
| Location reminders | ✓ foreground geofence | ✓ (Pro) | ✓ (iOS) | ✗ |
| Background geofence | Via **Home Assistant** webhook | ✓ native mobile | ✓ native iOS | ✗ |

## 8. Time tracking & review

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Built-in **time tracking** (timers) | ✓ **project sessions + task segments + pauses**, per-user, with a Time-Tracked view (list/timeline), retroactive editing, and CSV reporting | ✗ | ✗ (estimates only) | ✗ |
| **Estimated duration** | ✓ (estimate_minutes) | ✗ | ✓ | ✗ |
| **Review mode** (per-project interval) | ✓ | ✗ | ✓ (the original) | ✗ |
| Productivity stats / karma | ✗ (planned) | ✓ Karma | ✗ | ✗ |

## 9. Capture & input

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Quick-add inline tokens | ✓ `#tag` `@user` `!priority` w/ autocomplete | ✓ **full NLP** | ✓ (dates) | Basic |
| Natural-language dates | ✗ (planned) | ✓ best-in-class | ✓ | ✓ partial |
| Email-to-task | ✗ | ✓ | ✓ (Mail drop) | ✓ (flagged email) |

## 10. Views

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| List view | ✓ | ✓ | ✓ | ✓ |
| Tree / outline | ✓ | Partial | ✓ | ✗ |
| Kanban board | ✗ | ✓ | ✗ | ✗ |
| Calendar / Forecast | ✓ **Forecast** (day ribbon, due + deferred per day) | ✓ | ✓ **Forecast** | "Planned" |
| Forecast shows **external calendar events** | **✗** (own tasks only) | Partial (cal sync) | ✓ system calendar overlaid | ✗ |
| Smart lists | ✓ | ✓ | ✓ | ✓ |
| Daily planner ("My Day") | ✓ | Partial | ✗ | ✓ |

## 11. Automation, API & integrations

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Public REST API | ✓ (tasks/comments/attachments/complete) | ✓ REST + Sync | URL schemes / Omni Automation | ✓ Graph |
| Scoped API tokens | ✓ | ✓ (one) | n/a | OAuth |
| Webhooks (outbound) | ✓ (agent webhooks) | ✓ | ✗ | Graph subscriptions |
| Scripting/automation | REST + agents | Integrations | ✓ **Omni Automation (JS)** | Power Automate |
| Smart-home integration | ✓ **Home Assistant** | Via IFTTT/Zapier | ✗ | Via Power Automate |
| Integration marketplace | ✗ (DIY via API) | ✓ huge | Limited | MS ecosystem |

## 12. AI / agents

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Bot/agent accounts | ✓ | ✗ | ✗ | ✗ |
| Direct LLM integration | ✓ OpenAI/Anthropic (server-side) | "AI Assistant" (Pro, limited) | ✗ | Copilot (peripheral) |
| **Agentic-framework webhook** | ✓ (Hermes/OpenClaw) | ✗ | ✗ | ✗ |
| Trigger agent by `@mention`/assign | ✓ | ✗ | ✗ | ✗ |
| Configurable agent prompt | ✓ | ✗ | ✗ | ✗ |

## 13. Native platform integration, capture & maturity

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Track record / maturity | Newer, actively developed | Established, large team | **Mature, GTD standard** | Microsoft-backed |
| First-class native apps | PWA + thin Tauri/Capacitor shells | ✓ all platforms | ✓ **best-in-class Apple apps** | ✓ all platforms |
| Apple Watch / wearable | ✗ | ✓ | ✓ | ✓ |
| Home-screen **widgets** | ✗ | ✓ | ✓ | ✓ |
| **Siri / Shortcuts / voice** | ✗ | ✓ | ✓ deep | ✓ (Cortana/Copilot) |
| OS **share sheet** capture | ✗ | ✓ | ✓ | ✓ |
| System-wide **quick capture** hotkey | ✗ | ✓ | ✓ (Quick Entry) | Partial |
| Background reminders **without a server** | ✗ (planned) | ✓ native | ✓ native | ✓ native |
| Notification reliability | Web Push / foreground scan | ✓ OS-level | ✓ OS-level | ✓ OS-level |
| Scripting options | REST + agents | Integrations | ✓ **Omni Automation (JS plug-ins)** | Power Automate |

## 14. Pricing & availability

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Cost | **Free / self-hosted / paid-hosting** | Free + Pro + Business | Paid (one-time/sub) | **Free** |
| Paywalled features | None | Reminders/filters/comments/uploads | Custom perspectives, Focus | None |
| Vendor lock-in | None | Cloud | Omni ecosystem | Microsoft |

---

## Where Carbon falls short

The honest list of what you give up by choosing Carbon today. None of these are spin — they
are the reasons a careful GTD user might *not* switch.

**vs OmniFocus (the gold standard):**
- **Perspectives are far weaker.** OmniFocus builds arbitrary rule trees (nested AND/OR/NOT
  across any attribute) with custom grouping and sorting. Carbon offers flat filters with
  boolean logic on *tags only*.
- **Recurrence is basic.** No ordinal patterns ("2nd Tuesday", "last weekday of month").
- **Forecast is task-only** — no system-calendar overlay.
- **Native maturity.** OmniFocus has years of polish, rock-solid OS notifications, Apple
  Watch, widgets, Siri/Shortcuts, share-sheet and Quick Entry capture. Carbon is a PWA with
  thin native shells and no widgets/Watch/Siri; iOS PWA push is unreliable, and
  server-independent background reminders don't exist (Home Assistant is the workaround).
- **Track record.** OmniFocus is a supported commercial product trusted with thousands of
  tasks over many years; Carbon is newer and still building that long-term reliability story.

**vs Todoist:**
- Natural-language input (best-in-class), kanban boards, and a huge integration marketplace —
  all absent in Carbon. Plus the maturity, native clients, and widgets.

**vs Microsoft To Do:**
- Carbon leads on structure (unlimited nesting, projects, perspectives) and ownership, but To
  Do wins on **reach and polish that come with being free and Microsoft-backed**: first-class
  native apps on every platform, home-screen widgets, deep OS integration, and rock-solid
  background notifications. If you live in the Microsoft 365 ecosystem and want zero setup, To
  Do is the lower-friction choice.

## Where Carbon holds its own

Carbon's reason to exist isn't beating competition — it's a different *intersection* no
single incumbent occupies:

- **vs OmniFocus** — Carbon covers much of the GTD core (defer + due dates, review, tags incl.
  nesting + on-hold, flags, deferred-hiding, completion-relative recurrence, estimates) while
  adding what OF lacks entirely: **multi-user collaboration**, **per-task sharing**, true
  cross-platform (incl. Android/Linux/Windows), and **self-hosting**. It does *not* match OF's GTD
  depth, perspectives, recurrence, or native polish — see the gaps above.
- **vs Todoist** — wins on self-hosting/offline/data-ownership, per-task sharing, multiple
  assignees, **built-in time tracking**, defer dates, review, and agent/LLM hooks.
- **vs Microsoft To Do** — exceeds it on nearly every structural axis.
- **Carbon's unique intersection**: self-hosted + offline-first CRDT + most of GTD +
  Todoist-grade collaboration + per-task sharing + built-in time tracking + first-class
  agent/LLM + Home Assistant. No single competitor sits there — but each competitor beats
  Carbon decisively inside its own lane.

---

Decisions based on feature gaps:

| Gap | Decision | Notes |
|---|---|---|
| **Rule-based perspectives** | 🔜 Planned | Generalize tag AND/OR/NOT into arbitrary filter trees + grouping, to approach OF custom perspectives. |
| **Ordinal recurrence patterns** | 🔜 Planned | "2nd Tuesday", "last weekday of month" — currently unsupported. |
| **Forecast calendar overlay** | 🔜 Planned | Show external (ICS) calendar events alongside tasks, like OF Forecast. |
| **End-to-end encrypted sync** | 🤔 Under consideration | Currently plaintext-on-your-server; E2E would close the gap vs OmniFocus's zero-knowledge sync. |
| **Natural-language input** | 🔜 Planned | NLP date/tag/priority parsing in quick-add (extends existing `#`/`@`/`!`). |
| **Productivity stats** | 🔜 Planned | Must integrate with **time tracking** (timers + estimates vs actuals); design holistically before building. |
| **Natural-language input** | 🔜 Planned (LLM-driven) | NOT regex — true NL via light **STT + LLM** that infers project + splits multiple items, e.g. "add milk, eggs and bread to my shopping list" → 3 tasks in Shopping. Builds on the agent/API layer. |
| **Kanban board** | ❌ Not planned | — |
| **Third-party integration marketplace** | ❌ Not planned | Instead, invest in making the **REST API excellent** (the integration surface). |
| **Native platform integration** | ⬇️ Deprioritized | Real, acknowledged gaps: iOS background push/geofencing, home-screen widgets, Apple Watch, Siri/Shortcuts, share-sheet, system quick-capture, and OS-level notification reliability. Partly mitigated by HA geofencing + Android PWA parity — but this is where the incumbents stay clearly ahead. |
