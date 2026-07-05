# Changelog

Release notes for Carbon. The release pipeline extracts the section whose heading
starts with the pushed tag (e.g. `## v0.6.0`) and uses it verbatim as both the
GitHub Release body and the public mirror commit message — so keep each heading's
first token equal to the tag. See [docs/RELEASING.md](docs/RELEASING.md).


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
