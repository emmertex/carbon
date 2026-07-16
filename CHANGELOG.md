# Changelog

Release notes for Carbon. The release pipeline extracts the section whose heading
starts with the pushed tag (e.g. `## v0.6.0`) and uses it verbatim as both the
GitHub Release body and the public mirror commit message — so keep each heading's
first token equal to the tag. See [docs/RELEASING.md](docs/RELEASING.md).


## v0.8.0
**Time tracking: merge, split and segment editing**
- Accidentally stopped and restarted tracking? If you restart a project within
  5 minutes of stopping it, the timer bar offers to **merge with the last block** —
  the timer continues from the original start and the gap becomes untracked time
  inside the block.
- Expanded blocks on the Time tracked screen offer **Merge with previous block**
  when the same project's previous block ended within 8 hours.
- Untracked time within a block is now listed **per gap**, in order between the
  task segments. Leading/trailing gaps can be **trimmed** off the block; deleting
  a gap in the middle **splits the block in two**, with segments, pauses and
  completions kept on the correct side.
- Task segments inside a block are now editable after the fact, within the
  block's bounds: click a segment for **Start offset** (untracked minutes before
  it) and **Task time** (its length) in whole minutes, plus **Snap to previous**
  and **Fill to next** one-tap buttons. Segments can be **removed** (the time
  becomes untracked), and tasks can be **added into any untracked gap** from a
  picker of the block's project tasks.
- Tapping a block's bar opens a much taller, touch-friendly editor: tap a segment
  to get start/end **drag handles** with 1-minute snapping, clamped against
  neighbouring segments, pauses and the block edges — working in parallel with
  the numeric fields, which mirror the drag live.
- All edits round to whole minutes silently, are conflict-safe under sync, and
  never touch the currently-recording segment (the live block still merges fine).

## v0.7.6
**UI consistency pass**
- One control language across the app. All single-choice options (task status, order
  mode, tag hold status, Nested/Flat, view switchers, filter mode, and every settings
  choice group) now use the same split-pill segmented control; separate pill toggles
  remain only for independent on/off filters. Pills, icon buttons, inputs, and selects
  share single definitions in a new `ui/` component library instead of per-file copies.
- Settings no longer feels like a different app: billing, the card form, and the sync
  danger zone were rebuilt on the shared controls and theme tokens, replacing hardcoded
  reds/ambers/greens/whites with the theme's danger/warning/success colours.
- Accent-coloured buttons now use the theme's accent text colour instead of forced
  white, so button labels stay legible on light accents (green, amber, orange).
- Dropdowns are consistently styled (bordered, themed, focus ring) while keeping the
  native picker underneath for mobile friendliness.
- Segmented controls scroll instead of clipping on narrow phone screens.
- Fixed native dropdown popups (and date/time pickers) rendering as a white OS panel
  with white text in dark themes on Linux: dark themes now declare
  `color-scheme: dark`, so the browser paints native widgets in the matching scheme,
  with themed option colours as a fallback for renderers that ignore it.

## v0.7.5
**Mobile sync fix**
- Fixed sync failing permanently with *"tried to bind a value of an unknown type"* on
  fresh devices — most visibly the Android app after a reset/resync. Record-ops written
  before newer schema columns existed (e.g. attachments before `item_id` was added)
  carry data JSON without those keys, and the ingest upserts bound the missing values
  raw, which SQLite rejects. Long-lived browser sessions never hit this because their
  sync cursor was already past the legacy ops; a first full pull from history always did.
  All record upserts now default missing nullable fields to NULL.
- Sync can no longer be wedged forever by a single bad op: an unappliable op is skipped
  (and logged to the console) instead of rolling back the whole batch — previously the
  cursor could never advance past it, so every retry re-hit the same op.
- Item-op ingest hardened the same way: object field values are stored as their JSON
  string, booleans as 0/1, and a missing `fields` key is tolerated.
- Android build script now uses JDK 21 — Capacitor 8 requires it, and builds under
  JDK 17 failed with "invalid source release: 21" (so APKs built since the Capacitor 8
  bump may not have included what they were meant to).

## v0.7.4
**Release Fix**


## v0.7.3
**Sync visibility and local-data recovery**
- Sync errors are now spelled out in Settings → Sync instead of hiding in a tooltip on
  the cloud icon (which never showed on touch devices). The panel shows live sync state,
  the actual failure message, and when the last successful sync happened.
- Added a **Reset local data** button (Settings → Sync): erases this device's local
  database and re-downloads everything from the server. This is the recovery path when
  projects or tasks are missing or the local copy is corrupt/half-migrated — a symptom
  that could otherwise survive a sign-out/sign-in because the bad local data was kept.
- Signing in now offers **Merge** (keep local tasks and combine with the account — the
  previous default) or **Replace** (discard local and pull the account fresh) whenever
  the device already has local data. Clean installs sign in silently as before.
- Signing out now asks whether to **keep** the local copy for offline use or **erase**
  it, so nothing is left behind on shared devices.

## v0.7.2
**Natural-language assistant overhaul**
- Everyday phrasings now work in the quick-add bar and Telegram: past-tense completion
  ("I got the milk"), remove/delete (drops the task rather than faking completion),
  rename, priority/flag changes, and clearing dates. Dictated speech is handled too —
  filler words are ignored and self-corrections applied.
- Whole-list and whole-tag completion ("tick everything off my shopping list", "untick
  my weekly items") now actually works server-side — previously the prompt promised it
  but the call silently matched nothing.
- Date questions answered: "what's due tomorrow in work?" / "what's overdue?" — the
  items tool gained due_before/due_after filters, returning dated items soonest-first.
- More reliable scheduling with small local models: due/reminder times are now written
  as local time with a UTC offset instead of asking the model to do UTC conversion
  arithmetic itself (a common source of off-by-a-day dates).
- Tool-loop hardening: exact duplicate mutation calls are skipped (no more double-added
  tasks from looping models), a provider error mid-command now reports what actually
  happened instead of a generic failure, and raw JSON fallback actions no longer leak
  into Telegram replies.
- NL commands now request low temperature and low reasoning effort for faster, more
  deterministic runs (tunable via CARBON_NL_TEMPERATURE / CARBON_NL_REASONING_EFFORT;
  providers that reject these parameters are detected automatically and skipped).
- "remind" added to the default Add-box trigger keywords, so "remind me to…" entries
  route to the assistant on fresh installs.

## v0.7.1
**Security, billing, and reliability hardening**
- Added Basic-auth brute-force throttling, scoped per workspace so one tenant cannot
  lock out another tenant's users with the same username.
- Hardened billing flows: Square webhook retries no longer lose paid invoices for
  not-yet-persisted subscriptions, duplicate webhook deliveries short-circuit before
  side effects, and failed subscribe/cancel paths return stable errors while logging
  upstream detail server-side.
- Added a self-host database backup script using SQLite `VACUUM INTO`, documented
  scheduled backups and restore steps, and set a SQLite busy timeout for better
  concurrent reliability.
- Improved server error handling so unexpected host or tenant exceptions return
  generic JSON errors instead of leaking internal details.
- Split rarely used web screens out of the main bundle and added a top-level React
  error boundary plus an accessible shared modal primitive for onboarding/import
  dialogs.
- Tightened compact-layout gesture checks and reduced avoidable sidebar/plan-list
  re-renders.

## v0.7.0
**Introducing Notes**
- Notes are a special type of Tasks
- They do not autocomplete when parents are tasks and completed
- They have almost no 'task' functionality, designed for notes first
- Notes can be converted to Tasks, and Tasks to Notes, losing no data

## v0.6.3
**Bump all libraries**
- Bumped versions of all libraries to the latest

## v0.6.2
**Security hardening & CalDAV fixes**
- Fixed all-day CalDAV tasks/events landing on the wrong calendar day (and showing a
  bogus specific time instead of "all day") when your server and device are in different
  timezones — the common case for most self-hosted setups. All-day dates now anchor to
  your own timezone instead of the server's.
- Task dependency links ("blocks" / "blocked by") now correctly sync to the server and
  your other devices — they were previously accepted locally but silently dropped on
  push in multi-user setups.
- Hardened federation (cross-workspace sharing): a linked workspace can no longer act
  outside what was actually shared with it, deny-listing a peer now cuts an
  already-active link immediately, and a few other trust-boundary edges were tightened.
- Comment permissions tightened — commenting/@mentioning now correctly requires access
  to the task, closing a gap that could otherwise also trigger an AI agent on a task you
  couldn't see.
- Hardened the outbound-request guard (agent endpoints, webhooks, CalDAV) against
  redirect-based bypass and DNS-rebinding.
- A round of smaller reliability, performance, and error-handling fixes across sync,
  billing, push notifications, the Telegram bot, and the AI agent tool loop.


## v0.6.1
**Performance and Reliability**
- Added option to purge completed tasks (soft-delete, not removed from database)  
- Added reminders to purge when large amounts of completed tasks (to keep performance)
- More batched queries, to increase performance
- Lots and lots of sanity checks and other hardening


## v0.6.0
**Federation & cross-workspace sharing**
- Share a project and its subtree with **another workspace** — on the same Carbon server or a
  different Carbon host — with edits flowing **both ways** (read or write).
- **Three gates, off by default.** A server-host ceiling (`FEDERATION_MODE`:
  off / intra_server / cross_server, overridable per workspace), a workspace-admin policy
  (workspace-only / admin-approved whitelist / user-approved), and per-user approval. Nothing
  leaves a workspace unless all three allow it.
- **Approve in your Inbox.** An incoming share offer arrives as a "from Carbon" task with
  Approve / Decline — no separate notifications screen. Declining notifies the sender and clears
  the pending link.
- **Settings → Federation** panel: set the policy, manage the peer whitelist (admin), send an
  offer, and view/revoke links. You can also share to a workspace straight from a task.
- **Find people:** between two same-server workspaces that have whitelisted each other, pick a
  recipient from a directory instead of typing their address.
- **Attachments** are fetched on demand from the owning peer and hash-verified before caching.
  Tags aren't federated, and AI agents never run on federated content.
- **Unsharing retracts:** moving an item out of a shared subtree (or revoking) now removes the
  peer's copy instead of leaving a stale one.
- Cross-server (different-host) transport is **new** — behind NAT you'll need a reverse proxy or
  Tailscale, and it's worth verifying in your own setup. See [docs/federation.md](docs/federation.md).
- Under the hood: a reusable **system-notice** mechanism (the server can drop a marked task into
  your Inbox) that federation approvals use and future billing/invoice messages can reuse.

## v0.5.5
**UI Polishing**  
- Made CalDAV Settings less technically worded

**Performance**  
Heaps more clean up and optimisation.  
What matters is the results..  

|Operation|Original|Now|
|---|---|---|
|interaction:add|1009 ms|193 ms (5.2×)|
|interaction:complete|574 ms|139 ms (4.1×)|
|interaction:switch|439 ms|243 ms (1.8×)|
|query:forecast.data|261 ms|96 ms (2.7×)|
|query:container.data|26 ms|2.9 ms (9×)|
|scroll frames >50ms jank|~13|5|

**More Thorough Testing**
- Better and more complete performance tests
- True 2 server, and 2 browser testing using playwright for end to end tests


## v0.5.4
**UI Polishing**
- Show task count on Plan
- Don't show decimal minutes in side panel for time tracked
- Sync Interval for CalDAV and ical are now in Minutes, not Seconds
- Collapse Calendar Sync by default in Right Panel

**Performance**
- Added prepared statement cache, about 5x improvement to performance
- Sidebar calculations in background, no interaction delay when computing task counts

**iCal and CalDAV Changes**
- Never allow pulling past events
- Protect against potential push-pull-> loop with sync
- Timezone Corrections

## v0.5.3
**Calendar Sync Enhancements**
- Support iCal
- Support Repeating Events in CalDAV
- Only fetch current and future calendar events

## v0.5.2
**Time Tracker Enhancements**
- Track Start and End time of each task within a time block
- Record Task Completion time
- Track Pause Start and End times
- Report Wall Time, Task Time and Project Time as individual stats
- Report all above, as well as tags on each task, in exported CSV

## v0.5.1

- Automated multi-platform release pipeline: tagging in the private dev repo now
  mirrors a squashed snapshot to the public repo, which builds and publishes
  desktop (Linux + Windows) and Android artifacts to a GitHub Release.
- Desktop auto-update via the Tauri updater (silent download, confirmed install).
- Android sideload builds link out to the newest GitHub-released APK.
- About page now shows App version and Server version separately.

## v0.5.0 - Carbon Perspective

- Perspective views and related improvements.
