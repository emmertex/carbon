# Carbon documentation

Carbon is a self-hosted, offline-first task manager — simple on the surface, with a full GTD
toolbox underneath (projects, tags/contexts, defer & due dates, review, recurrence, flags). It
runs fully offline in the browser and syncs to your own server whenever it's reachable.

## Guides

### Using Carbon

- [**Complete feature list**](features.md) — the full inventory of what Carbon does, grouped by
  area, marking what works offline vs what needs a sync server.
- [**Usage & keyboard shortcuts**](usage-and-shortcuts.md) — quick capture, natural-language
  commands, advanced filters, customizing the UI, undo/redo, desktop quick-add, shortcuts,
  gestures, views, offline & sync.
- [**Carbon vs Todoist / OmniFocus / Microsoft To Do**](comparison.md) — honest feature-by-feature
  comparison, including where Carbon falls short.

### Security & data

- [**Data security**](data-security.md) — workspace isolation, TLS, authentication, local-only
  mode, data ownership, and the model's boundaries.

### Apps & integrations

- [**Native apps (desktop + Android)**](native-apps.md) — building and running the Tauri desktop
  and Capacitor Android apps, plus the desktop global-hotkey / tray quick-add.
- [**Calendar sync (CalDAV & iCal)**](caldav.md) — two-way CalDAV sync and read-only iCal feed
  subscriptions, per project.
- [**Home Assistant integration**](home-assistant.md) — capture, geofencing, per-device
  locations, "nearest place" reminders, and two-way task flows.
- [**Telegram bot**](telegram-bot.md) — run a per-server bot so users can control Carbon from
  Telegram in plain language (add/complete/tag tasks, ask what's due) via the same AI agent.
- [**Hermes / agent integration**](hermes.md) — connecting an agentic framework or direct LLM
  for natural-language task control.

### Developer / API reference

- [**REST API guide**](api.md) — endpoints, authentication, scopes.
- [**Agent API**](carbon-agent-api.md) — webhook contract + callbacks for building a skill.

### Credits

- [**Open source projects used**](open-source.md) — every direct library and tool Carbon is built on.

---

_Engineering notes, design plans, and internal reviews are intentionally kept outside this
public documentation set._
