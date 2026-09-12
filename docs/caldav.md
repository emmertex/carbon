# Calendar sync (CalDAV & iCal)

Carbon can sync a **project** against an external calendar. Two modes share the same
per-project setup:

- **CalDAV (two-way)** — a full CalDAV client against a server (Nextcloud, Radicale,
  Fastmail, iCloud, …). Reads _and_ writes.
- **iCal feed (read-only)** — subscribe to one or two published `.ics` feed URLs
  (the "secret" subscribe/publish link Apple and Google expose). Pull-only: remote
  events become tasks in the project, and the project is never written back. See
  [iCal feed mode](#ical-feed-read-only) below.

Both run on the Carbon **server** — so a configured/signed-in server is required;
neither runs in local-only/offline mode.

Configuration is **per project**, in the project's detail pane (admin only). The
binding holds the account password, so it is stored server-side and is **not** part
of the CRDT sync — it never propagates to clients.

## Setup (CalDAV)

Open a project → **Calendar sync** → _Set up calendar sync_ → **CalDAV (two-way)**.
Enter:

- **Username / Password** for the CalDAV account.
- One or both sync flavours, each with its own **collection URL** (paste the full
  collection href; auto-discovery is not implemented yet):
  - **Sync Tasks (VTODO)** — every task in the project ⇄ a VTODO in a task-list
    collection.
  - **Sync Calendar Events (VEVENT)** — every task **with a due date** → a VEVENT in
    a calendar collection, and inbound VEVENTs → new tasks in the project.
- **Sync every (seconds)** — minimum 60; default 3600.
- **Default event length** — used for a dated task that has no time estimate.

Past events are skipped on initial import. Recurring series, already-linked events
and to-dos remain eligible.

Use **Test** to check collections and **Sync now** to queue a sync. The panel shows
the result when it finishes. Both sync types can be enabled together; a dated task
then appears as both a VTODO and a VEVENT.

## iCal feed (read-only)

When you only have a published calendar link — not full CalDAV credentials — pick
**iCal feed (read-only)** instead. Apple Calendar ("Public Calendar" share link) and
Google Calendar ("Secret address in iCal format") both expose one `.ics` URL per
calendar.

Setup is the same panel, with the collection URLs replaced by **feed URLs**:

- **Sync Calendar Events (VEVENT)** — paste the events feed URL. Every VEVENT becomes
  a task under the project (DTSTART → due date, duration → estimate).
- **Sync Tasks (VTODO)** — paste a VTODO feed URL if your provider publishes one
  (most public feeds are events-only).
- **Username / Password** are optional — send them only if the feed itself is behind
  HTTP basic auth. Secret-URL feeds need none.

Past events are never imported here either (see above).

It is **pull-only** and a **pure mirror**: the project is never written back, and when
an item disappears from the feed it is cleaned up exactly like a CalDAV remote
deletion (a dropped VTODO soft-deletes the task; a dropped VEVENT clears the task's
due date and keeps the task). Local-only tasks are never pushed anywhere.

Change detection is per-feed: the whole document is fetched with `If-None-Match`, so
an unchanged feed short-circuits on a `304 Not Modified`; within a changed feed,
items are matched by `UID` and re-applied only when their mapped fields change.

## Field mapping

| Carbon           | VTODO                   | VEVENT                                          |
| ---------------- | ----------------------- | ----------------------------------------------- |
| title            | `SUMMARY`               | `SUMMARY`                                       |
| note             | `DESCRIPTION`           | `DESCRIPTION`                                   |
| due_date         | `DUE`                   | `DTSTART`                                       |
| defer_date       | `DTSTART`               | —                                               |
| estimate_minutes | —                       | `DTEND − DTSTART` (else _default event length_) |
| priority (0–3)   | `PRIORITY` (0,9,5,1)    | —                                               |
| completed        | `STATUS:COMPLETED`      | (event left in place)                           |
| recurrence       | `RRULE` (outbound only) | `RRULE` (outbound only)                         |

The VEVENT mappings are exact inverses (`DTSTART ↔ due_date`,
duration ↔ `estimate_minutes`) so a push → pull round-trip is stable. All-day
values use Carbon's 23:59 marker — resolved in the **project owner's** timezone
(see [Time zones](#limitations)) — ⇄ `VALUE=DATE`.

## Behaviour

- **Completing a calendar-synced task** leaves its VEVENT in place (it stops being
  updated). VTODO completion sets `STATUS:COMPLETED`.
- **Remote deletion**: a deleted VTODO soft-deletes the Carbon task (recoverable via
  the trash); a deleted VEVENT just clears the task's due date and keeps the task.
- **Local deletion** removes the remote object; clearing a task's due date removes
  its VEVENT.
- Changes are matched by UID and ETag to prevent duplicate imports.

## Limitations

- **Recurrence is one-way (Carbon → server).** Inbound `RRULE` is ignored; the task
  list mirrors the recurrence master only.
- **Nesting is flat.** Sub-tasks sync as individual VTODOs (no `RELATED-TO` yet).
- **Conflict resolution favours the server.** On a simultaneous edit (a `412` on
  push), the connector re-fetches the remote object and the remote values win for
  mapped fields.
- **Time zones:** UTC and `TZID` values use their specified zone. All-day and floating
  times use the project owner’s last reported timezone, falling back to the server
  timezone if none is available. Timed outbound values use UTC.

- **Change detection (CalDAV)** uses `PROPFIND` + ETag diffing, not the WebDAV
  `sync-collection` REPORT — every sync pass lists the whole collection.
- **Secrets**: the CalDAV password is stored in the tenant DB in plaintext (same as
  agent API keys); encryption-at-rest is a follow-up. It is never returned by the
  API or written to logs.

## LAN servers

Pointing at a private/LAN CalDAV host (e.g. a Radicale box on `10.x`) requires
private endpoints to be enabled for the workspace — the same gate as private LLM
endpoints (`ALLOW_PRIVATE_AGENT_ENDPOINTS=1` for self-host, or the host-admin
`allow_private_endpoints` flag per tenant). Otherwise the SSRF guard blocks it.
