# Carbon — usage & keyboard shortcuts

A practical guide to driving Carbon by keyboard, gesture, and quick-add syntax. Shortcuts
are taken directly from the code (`TaskTree.tsx`, `QuickAdd.tsx`, `TaskDetail.tsx`,
`Comments.tsx`) so they reflect what actually ships.

## Quick capture

The **quick-add bar** parses inline tokens as you type (`lib/quickadd.ts`); recognised
tokens are stripped from the title:

| Token | Effect | Notes |
|-------|--------|-------|
| `#tag` | add tag | created if new; case-insensitive de-dupe |
| `@user` | assign to user | must match a roster username, else kept as literal text |
| `!priority` | set priority | `!1`/`!low`/`!l` … `!3`/`!high`/`!h`; `!0`/`!none` clears |

Example: `Email the landlord #home @andrew !2` → task "Email the landlord", tag `home`,
assigned to andrew, priority medium.

Quick-add bar keys: **↑/↓** move through the autocomplete suggestions, **Enter** or **Tab**
accept the highlighted suggestion, **Esc** dismiss the menu. With the menu closed, **Enter**
submits the task.

## Global shortcuts

Work from anywhere (ignored while typing in a field):

| Key | Action |
|-----|--------|
| **g** then **t / i / f / a / p / o / r** | go to Today / Inbox / Flagged / All / Plan / Forecast / Review |
| **c** or **/** | focus the quick-add bar |
| **Home / End** | scroll the list to top / bottom |
| **PageUp / PageDown** | scroll the list up / down a page |

## Outline / list keyboard navigation

The task tree **and** the flat list views (Today / Inbox / Flagged / All) are
keyboard-drivable (focus the list first — click it or press **Tab**). `mod` below means
**Alt or Shift**.

| Key | Action |
|-----|--------|
| **↑ / ↓** | move focus up / down |
| **Home / End** | jump focus to the first / last row |
| **PageUp / PageDown** | jump focus ~10 rows up / down |
| **mod + ↑ / ↓** | reorder the focused task among its siblings *(outline)* |
| **mod + ← / →** | collapse / expand the focused task's children *(outline)* |
| **Tab / Shift-Tab** | indent / outdent (re-nest under previous sibling / up to grandparent) *(outline)* |
| **Enter** | edit the focused task's title inline *(outline)*, or open detail *(list)* |
| **Ctrl/⌘ + Enter** | open the focused task's detail pane |
| **Space** | toggle complete (with a brief "just completed" hold so it doesn't vanish instantly) |

### While editing a title inline

| Key | Action |
|-----|--------|
| **Enter** | save, then create a **new sibling below** and start editing it (rapid entry) |
| **Tab / Shift-Tab** | save + indent / outdent |
| **Backspace** (empty title) | delete the task and focus the previous row |
| **Esc** | cancel editing, return focus to the list |

### Detail pane & comments

- **Enter** in the detail title / a tag input commits that field.
- **Ctrl/⌘ + Enter** in the comment box submits the comment.

> **Large lists.** List views render only the rows on screen (plus a few above and
> below), so they stay fast into the tens of thousands of tasks. Drag-to-reorder is
> available on manually-sorted lists up to ~200 items; longer lists keep their order
> but are reordered by editing rather than dragging.

## Gestures (touch / mobile)

Configured in **Settings → Gestures & mobile**:

- **Swipe a task right** → always **complete** it.
- **Swipe a task left** → your chosen action: *Add to Plan*, *Flag*, *Open Details*, or
  *Delete* (default configurable).
- **Pane gestures** (toggle): edge-swipes open the side panes; centre-swipes act on the task
  under the finger.
- **Right-edge swipe** → jump to a destination: *Project Root*, *Today*, *Inbox*, or *Plan*.
- **Row quick-menu**: tap the row's menu affordance for quick assign / tag / flag actions
  without opening the detail pane.

## Views & perspectives

- **Today** — available (not deferred) tasks due/started by end of today.
- **Inbox** — unfiled top-level tasks (no project / parent).
- **Flagged** — flagged active tasks (shown even if deferred).
- **Review** — projects due for review (per-project review interval).
- **Forecast** — agenda ribbon + month-grid date picker.
- **Plan** — today's planning surface: pull tasks in, see a time **budget** (startup minutes
  + per-task estimates) vs the day.
- **Time** — logged time: List / Timeline / Chart, grouped by project or day with subtotals.
- **Tags** — browse by tag/context.
- **Focus mode** — the eye toggle beside the flag drills into a task as a container (only it
  + descendants) with a breadcrumb bar; exit returns you to where you were. Works from any
  view.
- **Saved perspectives** — saved view + sort + filter combinations (in the sidebar).

## Settings tour (quick map)

Appearance (mode/theme/accent) · Gestures & mobile · Profile & Planning (signed in) ·
Install app · Data backup (full export/import) · Sync server (URL + sign-in) · Reminders
(push / foreground geofence) · Users + AI agents (admin) · HA person · API tokens (admin) ·
About (version/device id).

## Offline & sync

Carbon is **offline-first** — the whole database lives in your browser and every change is
applied locally first, then synced when a server is reachable. You can use it with **no
server** at all (local-only). To sync across devices, point it at a Carbon server in
**Settings → Sync server** and sign in. The sync indicator shows idle/syncing/error state.

> Durability: writes persist on a 250 ms debounce **and** flush immediately when the tab is
> hidden or closed (`visibilitychange`/`pagehide`), so a reload or app-kill won't drop your
> last edits.
>
> Local-only mode keeps everything on this device — nothing is sent anywhere until you
> configure a sync server. See [`data-security.md`](data-security.md) for the full data-handling
> picture.
