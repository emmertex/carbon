# Carbon documentation

Carbon is a task manager for projects and next actions. Use it locally without an
account, connect to a hosted workspace, or run your own sync server. Locally stored
tasks are available without a connection; online integrations and uncached files
need internet access.

## Guides

### Using Carbon

- [**Complete feature list**](features.md) — the full inventory of what Carbon does, grouped by
  area, marking what works offline vs what needs a sync server.
- [**Usage & keyboard shortcuts**](usage-and-shortcuts.md) — quick capture, notes, natural-language
  commands, advanced filters, customizing the UI, undo/redo, desktop quick-add, shortcuts,
  gestures, views, offline & sync recovery.
- [**Carbon vs Todoist / OmniFocus / Microsoft To Do**](comparison.md) — honest feature-by-feature
  comparison, including where Carbon falls short.

### Security & data

- [**Data security**](data-security.md) — workspace isolation, TLS, authentication, local-only
  mode, data ownership, and the model's boundaries.
- [**Federation & cross-workspace sharing**](federation.md) — L2/L3 federation (off by
  default): share a project subtree with another workspace on the same host or a different
  Carbon server. Includes notes on sync-epoch resets and peer re-bootstrap.
- [**Sync log growth & epoch reset**](sync-epoch.md) — when the append-only op log hurts
  performance, safe compaction vs operator epoch reset, and client recovery.
- [**Privacy policy**](privacy-policy.md) — what the app stores locally vs on a sync server.

### Apps & integrations

- [**Native apps (desktop + Android)**](native-apps.md) — building and running the Tauri desktop
  and Capacitor Android apps, plus the desktop global-hotkey / tray quick-add.
- [**Calendar sync (CalDAV & iCal)**](caldav.md) — two-way CalDAV sync and read-only iCal feed
  subscriptions, per project.
- [**Home Assistant integration**](home-assistant.md) — capture, geofencing, per-device
  locations, "nearest place" reminders, and two-way task flows.
- [**Telegram bot**](telegram-bot.md) — run a per-server bot so users can control Carbon from
  Telegram in plain language (add/complete/tag tasks, ask what's due) via the same AI agent.
- [**Personal API keys**](api.md) — scoped access for external clients
  for natural-language task control.

### Developer / API reference

- [**REST API guide**](api.md) — endpoints, authentication, scopes.
- [**Agent API**](carbon-agent-api.md) — webhook contract + callbacks for building a skill.

### Releasing

- [**Landing page setup**](landing-page.md) — static marketing entry, custom domains and preview.

- [**Releasing (CI build + auto-update)**](RELEASING.md) — how a version tag turns into
  published desktop + Android builds, signing keys, and auto-update.
- [**Google Play Store launch**](PLAY-STORE.md) — the Play variant (no background location),
  building the signed AAB, store listing, Data safety, content rating, and the closed-testing
  requirement.

### Credits

- [**Open source projects used**](open-source.md) — every direct library and tool Carbon is built on.

---

_Engineering notes, design plans, and internal reviews are intentionally kept outside this
public documentation set._
