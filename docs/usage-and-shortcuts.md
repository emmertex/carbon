# Usage and shortcuts

## Quick capture

The **quick-add bar** parses inline tokens as you type; recognised
tokens are stripped from the title:

| Token | Effect | Notes |
|-------|--------|-------|
| `#tag` | add tag | created if new; case-insensitive de-dupe |
| `@user` | assign to user | must match a roster username, else kept as literal text |
| `!priority` | set priority | `!1`/`!low`/`!l` … `!3`/`!high`/`!h`; `!0`/`!none` clears |

Example: `Email the landlord #home @user !2` → task "Email the landlord", tag `home`,
assigned to user, priority medium.

Quick-add bar keys: **↑/↓** move through the autocomplete suggestions, **Enter** or **Tab**
accept the highlighted suggestion, **Esc** dismiss the menu. With the menu closed, **Enter**
submits the task.

### Natural-language commands

Enable an agent and natural-language commands in **Settings → Integrations**,
then enable **Assistant in add box** under UI complexity.

Start a line with a configured keyword (defaults: `add`, `remind`, `check off`, `mark off`,
`mark as`, `can`) and write plainly — typing a date anywhere else in a normal task title is
left as literal text:

- `add milk and eggs to shopping` → creates both tasks in the *shopping* list.
- `remind me to get milk at Supermarket` → adds the task, tags it `supermarket`, and geofences the tag
  to the **nearest Supermarket** to your current location (no coordinates needed).
- `I got the milk` / `tick off milk and bread` → marks those tasks done (past tense works).
- `delete the milk task` → removes it (rather than faking completion).
- `rename milk to oat milk` → renames in place.
- `tick everything off my shopping list` / `untick my weekly items` → whole-list / whole-tag
  complete or reopen.
- `what's due tomorrow in work?` / `what's overdue?` → lists matching dated items.
- `tag everything in shopping urgent` → bulk-tags the whole list.

The agent matches task, list and tag names. View command usage in
**Settings → Natural-language commands**.

### Notes

Notes are a first-class item type (alongside tasks and projects):

- Create a note from the quick-add bar (note mode) or convert an existing **task ↔ note**
  from the detail pane — conversion keeps title, body, tags and nesting.
- Flip a project to **Notes** and new children default to notes (a notebook). Note rows
  show as cards with a thumbnail when they have an image or body.
- Notes use a rich Markdown editor with inline images; they don't auto-complete when a
  parent task is done, and they stay out of Today / CalDAV action surfaces.
- Flip a note to **Recipe** mode for a scaled servings view; Settings → Recipes sets the
  cup convention. Use **Optimise** (sync server) or the copy-able import prompt to turn
  web recipes into clean Markdown.
- **Data backup → Export notes (zip)** dumps every note as Markdown plus images.

### Desktop quick-add

The desktop app adds a **global hotkey** (`Ctrl/⌘ + Shift + A`) and a **system-tray** icon
that pop a spotlight capture bar from anywhere — type a task (or an NL command) and it lands
in your inbox without switching windows. See [native apps](native-apps.md#quick-add-global-hotkey--tray).

## Copy as Markdown

Use **Copy as Markdown** in an item’s row menu to copy it and its subtasks as a checklist.

```
* [ ] Plan the trip #travel @due:20260628
  * [x] Book flights @due:202606281830
  * [/] Renew passport #errand
```

- **Checkbox** reflects status: `[ ]` active, `[x]` done, `[/]` dropped.
- **Indentation** is two spaces per level; subtasks nest under their parent in sort order.
- **`#tags`** are listed inline (full path for nested tags, e.g. `#Shopping:Supermarket`).
- **`@due:`** appears only when a due date is set — `YYYYMMDD`, or `YYYYMMDDHHmm` when the
  due has a specific time.

Other fields (notes, defer, effort, priority, flags) are omitted to keep the paste clean.

## Global shortcuts

Work from anywhere (ignored while typing in a field):

| Key | Action |
|-----|--------|
| **g** then **t / i / f / a / p / o / r / d** | go to Today / Inbox / Flagged / All / Plan / Forecast / Review / Recently Deleted |
| **c** or **/** | focus the quick-add bar |
| **Ctrl/⌘ + Z** | undo the last change |
| **Ctrl/⌘ + Shift + Z** | redo |
| **Home / End** | scroll the list to top / bottom |
| **PageUp / PageDown** | scroll the list up / down a page |

Undo/redo covers completion, flags, priorities, planning and deletion for the current
session. Changes sync to other devices; the undo stack clears on reload.

**Recently Deleted** (`g` `d`) restores deletes from the last 30 days, including
subtrees deleted with a parent.

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



## Gestures (touch / mobile)

Configured in **Settings → Gestures & mobile**:

- **Swipe a task right** → always **complete** it.
- **Swipe a task left** → your chosen action: *Add to Plan*, *Flag*, *Open Details*, or
  *Delete* (default configurable).
- **Pane gestures** (toggle): edge-swipes open the side panes; centre-swipes act on the task
  under the finger.
- **Right-edge swipe** → jump to a destination: *Project Root*, *Today*, *Inbox*, or *Plan*.
- **Row quick-menu**: tap the row's menu affordance for quick assign / tag / flag actions
  without opening the detail pane. **Copy as Markdown** there copies the task (or project)
  and all its subtasks to the clipboard as a nested checklist. See [Copy as Markdown](#copy-as-markdown).

## Views & perspectives

- **Today** — available (not deferred) tasks due/started by end of today.
- **Inbox** — unfiled top-level tasks (no project / parent).
- **Flagged** — flagged active tasks (shown even if deferred).
- **Review** — projects due for review (per-project review interval).
- **Forecast** — agenda ribbon + month-grid date picker.
- **Plan** — today's planning surface: pull tasks in, see a time **budget** (startup minutes
  + per-task estimates) vs the day.
- **Time** — logged time: List / Timeline / Chart, grouped by project or day with subtotals.
  Expand a block to merge with the previous block, trim or split untracked gaps, edit
  segment start/length (fields or drag handles), remove a segment, or add a task into a gap.
  While tracking, the timer bar can add a **time note** or show a satellite indicator when
  **Record GPS while time-tracking** is on (Settings → Reminders & location).
- **Tags** — browse by tag/context.
- **Focus mode** — the eye toggle beside the flag drills into a task as a container (only it
  + descendants) with a breadcrumb bar; exit returns you to where you were. Works from any
  view.
- **Saved perspectives** — saved view + sort + filter combinations (in the sidebar).

## Filtering: basic & advanced

Every list view has a **filter & sort bar**. The sort dropdown and the icon chips
(Completed, Flagged, Hide deferred, Hide blocked, Hide on-hold) plus the expandable panel
(tags, priority, project, date range) are the **basic** filters — quick, flat, AND-ed
together.

Open the filter panel and switch **Basic → Advanced** to build a **nested boolean
expression** instead:

- Combine conditions with **AND / OR** groups and wrap any node in **NOT**.
- Conditions cover flagged, completed, priority (=/≥/≤), due-within-/after-N-days, overdue,
  no due date, deferred, blocked, on-hold, has-tag, in-project, and title/note contains.
- Example: *due within 1 day **OR** (due within 2 days **AND** high priority) **OR** flagged,
  **AND NOT** tagged #OnHold.*

The chosen mode and expression are saved per view (and can be saved into a perspective).

### Natural-language filters

In the advanced panel, the **"Describe a filter…"** box turns plain English into an
expression using the configured LLM agent (same setup as NL commands — **Settings → AI
agents**). Type *"things due tomorrow or flagged, but not on hold"*, and the builder fills
in for you to review and tweak before applying. Token usage is recorded server-side under
`filter_build`, alongside the other agent usage kinds.

## Customizing the UI (Features)

Choose **Simple**, **Standard** or **Advanced** on first run.

Fine-tune it any time in **Settings → Features & UI complexity**:

- Switch preset, or choose **Custom** to toggle individual features yourself.
- Toggleable surfaces include the **filter & sort bar**, the **Show bar** (per-row icon
  toggles), **GTD Tools** (advanced filters, defer dates and task dependencies), **Nearby**
  (location), **Forecast**, **Review**, **time tracking**, **saved views**, the **tags**
  section, and the **assistant** in the add box.
- Each feature has separate **Desktop** and **Mobile** switches — e.g. hide the filter bar on
  your phone but keep it on the desktop.

Hidden features only disappear from the UI; their data and behaviour are untouched (a hidden
filter bar still filters by the saved settings).

Detail sections expand or collapse with your feature settings. Hidden sections
remain accessible through **More…**.

By default, your Features choices — along with saved views, per-view filters, and
perspectives — **sync across your devices** (see below). Turn this off per device with
**"Sync views & UI settings across devices"** in the same section.

## Settings tour (quick map)

Appearance (mode/theme/accent — including Nord and Catppuccin) · **Features & UI complexity**
(presets + per-feature, per-device toggles + settings sync) · Gestures & mobile · Planning budget /
Profile (signed in) · Sync server (URL + sign-in, live sync state, **Reset local data**) ·
Subscription (admin) · Data backup (full export/import, purge completed tasks, notes zip export) ·
Reminders & location (push / foreground geofence / **Record GPS while time-tracking**) · This
device (location sources) · Home Assistant (person link) · API tokens (admin) · AI agents (admin,
incl. token usage) · Natural-language commands (admin, incl. token usage) · Users (admin) · About
(version) · Install app (browser only; links to the app stores).

## Offline & sync

Carbon is **offline-first** — the whole database lives in your browser and every change is
applied locally first, then synced when a server is reachable. You can use it with **no
server** at all (local-only). To sync across devices, point it at a Carbon server in
**Settings → Sync server** and sign in. The Sync panel shows live state, the last successful
sync, and any error message (not just the cloud-icon tooltip).

**Recovery options:**

- **Reset local data** — erase this device's database and re-download from the server (when the
  local copy is corrupt or missing projects).
- **Sign-in Merge vs Replace** — if the device already has local tasks, choose Merge (combine
  with the account) or Replace (discard local and pull fresh).
- **Sign-out** — keep the local copy for offline use, or erase it on shared devices.
- **Sync epoch reset** — rare operator maintenance that rebuilds the server's change history.
  Incremental sync cannot continue; Carbon shows a gate with **Download local DB**, **Clear
  cache and re-download**, or **Log out and operate offline**. Download first if you have
  unpushed local edits.

Alongside your tasks, Carbon also syncs your **UI settings, saved views, per-view filters and
perspectives** (last-writer-wins, scoped to your account). It's on by default and pulled when
you first sign in on a new device; toggle it per device in **Settings → Features & UI
complexity**.

Local changes are saved automatically. Export regular backups, especially when
working without a sync server. See [data security](data-security.md).

### Detail panes and long-list movement

Details dock when the space remaining beside navigation can fit both list and detail.
On narrow panes, details fill the width. The default remains two taps; enable
**Open task details on the first tap** in Settings → Gestures & mobile to change it.
Dependency and project pickers search on demand instead of loading every option.

Manual task lists remain draggable above 200 items. Hold a row to drag; the highlighted
target shows before/after placement. Keyboard users can focus a sortable row, press
Space, use arrow keys, and press Space to drop or Escape to cancel. For distant moves,
select the task and use **Move selected task to position** above the list.
