# Carbon vs Todoist vs OmniFocus vs Microsoft To Do

In-depth, feature-specific comparison. The **Carbon** column reflects what's actually
in this codebase. Competitor details are accurate to early **2026** — these are
fast-moving cloud apps, so verify any single dealbreaker against current docs.

> **Read this first - honest framing.** Carbon is a self-hosted, offline-first task
> manager. The apps it's measured against are mature, commercially-supported products with
> years of polish, large user bases, and full native client suites. **OmniFocus in
> particular is the GTD reference implementation**, and the standard the GTD community
> measures everything else by. This table exists to map Carbon's strengths *and* its
> gaps honestly, not to declare a winner. Where a cell reads `✓` for Carbon next to `✓`
> for a competitor, the capability exists but may be **narrower, broader or newer** than the
> incumbent's. If one feature is key to you, check out their own solutions for yourself.
> [Where Carbon falls short](#where-carbon-falls-short) and
> [Where Carbon holds its own](#where-carbon-holds-its-own) before the feature tables.

> This document is living - we update it as Carbon's features evolve.
> But we might forget, so it might be a little dated at times.  Carbon will always match or exceed this document.

## 1. Platform, hosting & data ownership

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Hosting model | **Self-hosted**, fully local, or Cloud Sync | Cloud SaaS only | Omni Sync / WebDAV (no self-host) | Microsoft cloud only |
| Offline capability | **Offline-first**; full DB in browser | Offline cache, online-centric | Local-first, syncs | Online-centric with cache |
| Sync mechanism | **Op-log CRDT** <ss> | Proprietary Sync API | Encrypted database sync | Microsoft Graph sync |
| **End-to-end / zero-knowledge sync** | ✗ (TLS in transit) <ss> | ✗ | ✓ **zero-knowledge** encrypted | ✗ |
| Data export | **Full local export/import** of entire DB + attachment blobs; **copy any project/task subtree as a Markdown checklist** | JSON/CSV, Sync API | Backups, TaskPaper, archive | Limited / none |
| Account required | None (local) or Sync (<ss>) | Todoist account | Omni account for sync | Microsoft account mandatory |
| Clients | Web/PWA **installable**, Win, **Linux**, Android (Mac and iOS planned) | Web, Win, Mac, iOS, Android, watch, extensions | Mac, iPad, iPhone, Watch, web — **no Android/Windows** | Win, Mac, web, iOS, Android |

## 2. Task structure & hierarchy

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Projects | ✓ **plus any item is a container** | ✓ + sub-projects | ✓ | "Lists" only |
| Sequential / parallel project types |  ✓  | ✗ | ✓ | ✗ |
| "Next action" / availability model |  ✓  | ✗ | ✓ | ✗ |
| Sub-task nesting depth | **Unlimited** | Multiple levels | **Unlimited** | **One level** ("Steps") |
| Sections within a project | Via nesting | ✓ explicit | Via action groups | ✗ |
| Drag to re-order | ✓ | ✓ | ✓ | ✓ |
| Drag to re-nest (change parent) | ✓ | ✓ | ✓ | ✗ |
| Inbox / unfiled capture | ✓ | ✓ | ✓ | "Tasks" list |
| Task status states | active / done / **dropped / on-hold** | done / not | active / done / **dropped / on-hold** | done / not |
| Focus / scope to one container | ✓ | ✗ | ✓ (Pro) | ✗ |

## 3. Scheduling: dates, defer, recurrence, reminders

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Due date | ✓ | ✓ | ✓ | ✓ |
| Defer / start date (hide until) | ✓ | ✗ | ✓ | ✗ |
| Separate **reminder time** (≠ due) | ✓ (own field, pushes at that time) | ✓ | Due/defer notifications | ✓ |
| Recurrence | Daily/Weekly/Monthly/Yearly × interval (+ multi-weekday) | **Natural-language**, most powerful | **Most flexible** | Daily/Weekly/Monthly/Yearly + custom |
| **Ordinal / complex patterns** (e.g. "2nd Tue", "last weekday") | ✗ (planned) | ✓ | ✓ | Partial |
| **Completion-relative recurrence** | ✓ "Repeat from completion date" | ✓ ("every!") | ✓ | Partial |
| Time-of-day on due | ✓ | ✓ | ✓ | ✓ |

## 4. Organization: tags, priority, flags, filtering

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Tags / labels | ✓ multi, **colored**, **nestable**, synced family-wide | ✓ labels, colored | ✓ multiple, **nestable** | `#hashtags` only |
| Tag "on hold" (defer all tasks w/ tag) | ✓ | ✗ | ✓ | ✗ |
| Priority levels | **4** | **4** | ✗ | ✗ |
| Flag | ✓ | ✗ (can use P1) | ✓ | ✓ "Important" |
| Saved views / Perspectives | ✓ | ✓ saved filters (query) | ✓ (Pro) | Smart lists only |
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
| Multi-user | ✓ self-hosted or hosted options <ss> | ✓ | **✗ single-user** | ✓ |
| Share a project | ✓ <ss> | ✓ | ✗ | ✓ |
| Share an **individual task** | ✓ (+ inheritance to subtree) <ss> | ✗ (project-level) | ✗ | ✗ |
| Assignees | ✓ **multiple** <ss> | ✓ **one** | ✗ | ✓ (in shared list) |
| Per-user permissions (read/write) | ✓ <ss> | Limited | ✗ | Basic |
| Auto-share on assign | ✓ <ss> | n/a | n/a | n/a |
| "Shared with me" | ✓ <ss> | ✓ | ✗ | ✓ |

## 6. Notes, comments, attachments

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Task notes | ✓ **Markdown** | ✓ **Markdown** | ✓ rich text | ✓ plain |
| Comments thread | ✓ Markdown + `@mentions` | ✓ (Pro for more) | ✗ | ✗ |
| Attachments on tasks | ✓ Unlimited local (<25MB per file sync) | ✓ (Pro larger) | ✓ | ✓ via OneDrive (≤25MB) |
| Attachments on comments | ✓ (incl. inline images) | ✓ | ✗ | ✗ |
| Markdown rendering | ✓ (GFM) | Partial | ✗ | ✗ |

## 7. Reminders & location

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Push reminders | ✓ <ss> | ✓ (Pro) | ✓ | ✓ |
| **Local reminders, no server** | ✓ foreground scan | ✗ | ✓ | ✗ |
| Location reminders | ✓ (foreground and <ss>) | ✓ (Pro) | ✓ (iOS) | ✗ |
| Multi-device location store | ✓ each device reports GPS to server; **Nearby view** shows tasks at your location | ✗ | ✗ | ✗ |
| Background geofence | Via Sync Server <ss> | ✓ native mobile | ✓ native iOS | ✗ |

## 8. Time tracking & review

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Built-in **time tracking** (timers) | ✓ **project sessions + task segments + pauses**, per-user, with a Time-Tracked view (list/timeline), retroactive editing, and CSV reporting | ✗ | ✗ (estimates only) | ✗ |
| **Estimated duration** | ✓ | ✗ | ✓ | ✗ |
| **Review mode** (per-project interval) | ✓ | ✗ | ✓ | ✗ |
| Productivity stats / karma | ✗ (planned stats) | ✓ Karma | ✗ | ✗ |

## 9. Capture & input

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Quick-add inline tokens | ✓ `#tag` `@user` `!priority` w/ autocomplete; **NL commands** via configured keyword <ss> | ✓ **full NLP** | ✓ (dates) | Basic |
| Natural-language **commands** (LLM) | ✓ **True LLM AI** <ss> | ✓ "AI Assistant" (Pro, limited) | ✗ | ✗ |
| Natural-language **dates** (NLP parsing) | ✗ (planned <ss>) | ✓ | ✓ | ✓ partial |
| Email-to-task | ✗ (not planned, use API <ss>) | ✓ | ✓ (Mail drop) | ✓ (flagged email) |

## 10. Views

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| List view | ✓ | ✓ | ✓ | ✓ |
| Tree / outline | ✓ | Partial | ✓ | ✗ |
| Kanban board | ✗ (not planned) | ✓ | ✗ | ✗ |
| Calendar / Forecast | ✓ **Forecast** | ✓ | ✓ **Forecast** | "Planned" |
| Forecast shows **external calendar events** | ✓ Partial (cal sync <ss>) | ✓ Partial (cal sync) | ✓ system calendar overlaid | ✗ |
| **Nearby** (location-based task view) | ✓ | ✗ | ✗ | ✗ |
| Smart lists | ✓ | ✓ | ✓ | ✓ |
| Daily planner ("My Day") | ✓ | Partial | ✗ | ✓ |

## 11. Automation, API & integrations

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Public REST API | ✓ (Everything) <ss> | ✓ REST + Sync | URL schemes / Omni Automation | ✓ Graph |
| **NL agent API** (`/api/agent/*`) | ✓ add/complete/tag/schedule (due/reminder/repeat)/share/assign/timers/geofence/nearby via text commands + tool loop <ss> | ✗ | ✗ | ✗ |
| Scoped API tokens | ✓ <ss> | ✓ (one) | n/a | OAuth |
| Webhooks (outbound) | ✓ (agent webhooks) <ss> | ✓ | ✗ | Graph subscriptions |
| **CalDAV sync** (VTODO + VEVENT) | ✓ **per project** <ss> | ✓ | ✓ | ✓ |
| Scripting/automation | REST + agents + NL commands <ss> | Integrations | ✓ Omni Automation | Power Automate |
| Smart-home integration | ✓ via API + **Home Assistant** <ss> | Via IFTTT/Zapier | ✗ | Via Power Automate |
| Integration marketplace | Powerful API <ss> | ✓ | Limited | MS ecosystem |

## 12. AI / agents

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Bot/agent accounts | ✓ <ss> | ✗ | ✗ | ✗ |
| Direct LLM integration | ✓ **OpenAI/Anthropic/Agents (server-side tool loop)** <ss> | "AI Assistant" (Pro, limited) | ✗ | Copilot (peripheral) |
| **In-app NL commands** | ✓ **keyword-triggered in Add box → LLM tool loop (add/complete/tag/geofence)** <ss> | ✗ | ✗ | ✗ |
| **Telegram bot** | ✓ **per-server bot, per-user linking, conversational replies via your AI agent** <ss> | Via integrations | ✗ | ✗ |
| **Agentic-framework webhook** | ✓ **Hermes/OpenClaw Skills Included** <ss> | ✗ | ✗ | ✗ |
| Trigger agent by `@mention`/assign | ✓ <ss> | ✗ | ✗ | ✗ |
| Configurable agent prompt | ✓ <ss> | ✗ | ✗ | ✗ |

## 13. Native platform integration, capture & maturity

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Track record / maturity | Newer, actively developed, **Fully OSS** | Established, large team | **Mature, GTD Gold Standard** | Microsoft-backed |
| Native apps | Web, **Linux**, Win, Android (Max and iOS planned) | ✓ Web, Win, Max, Android, iOS | ✓ **native** Mac, iOS + limited web | ✓ Win, Mac, Android, iOS |
| Apple Watch / wearable | ✗ (submit PR!) | ✓ | ✓ | ✓ |
| Home-screen **widgets** | ✗ (submit PR!) | ✓ | ✓ | ✓ |
| **Gemini / Siri / Shortcuts / voice** | ✗ (submit PR!) | ✓ | ✓ deep | ✓ (Cortana/Copilot) |
| OS **share sheet** capture | ✗ (submit PR!) | ✓ | ✓ | ✓ |
| System-wide **quick capture** hotkey | ✓ **desktop** `Ctrl+Shift+A` | ✓ | ✓ (Quick Entry) | Partial |
| Background reminders **without a server** | ✗ (planned, submit PR!) | ✓ native | ✓ native | ✓ native |
| Notification reliability | Web Push <ss> / foreground scan | ✓ OS-level | ✓ OS-level | ✓ OS-level |
| Scripting options | ✓ REST + agents <ss> | Integrations | ✓ Omni Automation | Power Automate |

## 14. Pricing & availability

| Specific | Carbon | Todoist | OmniFocus | MS To Do |
|---|---|---|---|---|
| Cost | **Free / self-hosted / paid-hosting** | Free + Pro + Business | Paid (one-time/sub) | **Free** |
| Paywalled features | **None** | Reminders/filters/comments/uploads | Custom perspectives, Focus | **None** |
| Vendor lock-in | **None**, Fully OSS, Markdown Export | Cloud | Omni ecosystem | Microsoft |

---

## Where Carbon falls short

The honest list of what you give up by choosing Carbon today. None of these are spin — they
are the reasons a careful GTD user might *not* switch.

**vs OmniFocus (the gold standard):**
- **Perspectives are far weaker.** OmniFocus builds arbitrary rule trees (nested AND/OR/NOT
  across any attribute) with custom grouping and sorting. Carbon offers flat filters with
  boolean logic on *tags only*. (Not Planned)
- **Recurrence is basic.** No ordinal patterns ("2nd Tuesday", "last weekday of month"). (Considering this feature)
- **Forecast is task-only** No system-calendar overlay. (Will not do)
- **Native maturity.** OmniFocus has years of polish, rock-solid OS notifications, Apple
  Watch, widgets, Siri/Shortcuts, share-sheet and Quick Entry capture. Carbon is a PWA with
  thin native shells and no widgets/Watch/Siri; iOS PWA push is unreliable, and
  server-independent background reminders don't exist (Server API is the workaround).
- **Track record.** OmniFocus is a supported commercial product trusted with thousands of
  tasks over many years; Carbon is newer and still building that long-term reliability story.

**vs Todoist:**
- Kanban (If you want them, and can make them work, by all means, submit a PR!).
- Huge integration marketplace.  (Not planned, when linked to an agent like Hermes, we feel Carbon is superior)
- Widgets on Mobile Platforms.  (Not planned, submit a PR if you want it)
- App maturity / Market Penetration.

**vs Microsoft To Do:**
- Home Screen Widgets.
- True Native Apps with true OS integration.
- Reliable background notifications.
- Supported by Microsoft.

## Where Carbon holds its own

Carbon's reason to exist isn't beating competition, it's a different *intersection*, it exists because it does what nothing else does:

- **Unique to Carbon**
  - **Time Tracking** - Designed to track your day, not just time spend on tasks.  This is designed to be your own personal time sheets.
  - **Infinite Nesting** and **Task Focus** - Literally any task can be treated as a project!
  - **Many Location Sources** - Local device only, sure, but use the Sync Server.  Locations are pushed by every device, via API, and HA Zones.  You have never experienced something this useful in a task app, we assure you that!
  - **Agentic Links** - API's are nice, but using them can be tricky, so provided in the project are listeners for agents, skills, and tutorials for using **Hermes**, **OpenClaw** and alike right out of the box.  And you don't need your own Sync Server, all API's are available on our hosting solution.  
  - **True Agent** - You can @comment to your Agent, or add it projects or tasks, it will see everything you do, and action as you wish!
  - **True LLM** - Not some crappy natural language with rules, Natural Language uses an LLM of your choice.  We reccomend using at least a 8B model, We use a 20B one personally.  But if you want to use Opus or GPT5.5, that is your choice!  With an extremely complete API, it can do more than you think!  
  - **New and FOSS** - At Emmertex we have used the predecessor of Carbon for nearly 10 years, but it wasn't a todo app.  It was a sync machine between all sorts of applications to make our workflow functional.  Carbon is a natural evolution, bringing all those pieces together into one.  Carbon is not human coded, it is the output of a decade of wish lists and hacky solutions due to nothing out there doing what we want.  But we aren't into AI Slop.  This is heavily guided, planned and reviewed.
- **vs OmniFocus**
  - Carbon covers much of the GTD core (defer + due dates, review, tags incl.
  nesting + on-hold, flags, deferred-hiding, completion-relative recurrence, estimates) - but OmniFocus is GTD First, Carbon is just using bits of GTD we actually find useful.  If you read David Allen's book, and want the ultimate GTD App, OmniFocus is your only option.  We think we are a close second, but have no intention of adding more GTD features.
  - **Multi-user collaboration** - OmniFocus is a personal GTD App, Carbon is designed for Families and small work teams in mind.
  - **Cross-platform** - Why Omni Group.  You have had the best GTD App for decades.  Yet almost no one can use it.
  - **self-hosting** - No vendor lock in, but we only use TLS.  OmniFocus is true zero knowledge encrypted, potentially the only app that is.
- **vs Todoist**
  - Todoist is just a todo list, Carbon is your GTD, Project Manager, Time Tracker, and Life Tool. 
- **vs Microsoft To Do**
  - If Todoist is a huge gap, well wait till you look at this gap.  Sorry Wunderlist, Microsoft let you down.
- **Carbon's unique intersection**: 
  - Application and Server, 100% OSS
  - self-hosted or paid hosting
  - offline-first CRDT
  - most of GTD
  - At industry leading level of collaboration
  - per-task sharing
  - built-in time tracking
  - first-class agent/LLM
  - Natural Language commands
  - CalDAV sync (per project!)
  - First Class Home Assistant integration

  No single competitor sits where Carbon is.  OmniFocus holds it's own, but we feel we have something special!

---

Decisions based on feature gaps:

| Gap | Decision | Notes |
|---|---|---|
| **Rule-based perspectives** | 🔜 As Needed | Currently everything we want works.  If there is ever an edge case, we will add it.  We are not adding features for the sake of a bigger feature list |
| **Ordinal recurrence patterns** | 🔜 Planned | "2nd Tuesday", "last weekday of month".  We know people want it, but we don't use it.  So it is low priority.  When we need it, it will be added.  If someone submits a PR, might happen sooner |
| **Forecast calendar overlay** | ⬇️ Deprioritized | We push and pull to CALDav and that is sufficient for us.  We don't currently use or want this, and don't want to make it, and have it imperfect.  When we need or want it, it will happen.  If someone really wants it, and uses it, submit a PR. |
| **End-to-end encrypted sync** | ❌ Not Planned | Yes, we see the benefit.  No app we know of apart from OmniFocus supports this.  If you want data security, self host your own sync server. |
| **Natural-language dates** (NLP in quick-add) | 🔜 In Testing | We have this internally, but it makes mistakes.  Once it is solid, it will be released.  (extends existing `#`/`@`/`!`). |
| **Productivity stats** | 🔜 Planned | Must integrate with **time tracking** (timers + estimates vs actuals); design holistically before building. We did have this from the start, but it added no value, and was removied.  It will come back once it is useful. |
| **Kanban board** | ❌ Not planned | We like the idea, but see little to no value in it personally.  We are not adding features for the sake of it.  If we won't use it ourselves, we can't assure the quality we expect.  This needs to come in as a PR from someone who truly needs and uses it. |
| **Third-party integration marketplace** | ❌ Not planned | Instead, invest in making the **REST API excellent** (the integration surface).  Use the Agentic tools like Hermes or OpenClaw.  We feel the idea of manual integrations are a high maintenance legacy solution no longer needed |
| **Native platform integration** | ⬇️ Deprioritized | Real, acknowledged gaps: iOS background push/geofencing, home-screen widgets, share-sheet, and OS-level notification reliability.  The issue is, internally, we don't use or care about them.  This again causes the whole, no feature for the sake of it, so we can't guarentee quality.  This needs to come in as a PR from someone who truly needs and uses it. |
