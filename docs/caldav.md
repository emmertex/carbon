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
- **Sync every (seconds)** — minimum 60; default 300.
- **Default event length** — used for a dated task that has no time estimate.

**Past events are never imported.** An inbound VEVENT whose end is already in the past
is skipped, so a calendar's history never floods the project — this is unconditional
(there is no toggle). A recurring series is always treated as ongoing, so it is
imported even when its first occurrence is in the past. This only gates *new* imports:
an event already linked as a task is kept even after it passes. To-dos are never
filtered on time.

Use **Test** to PROPFIND the collection(s), and **Sync now** to run a pass
immediately. **Sync now** is fire-and-forget — it queues the run on the server (a full
pass can outlast a reverse-proxy timeout) and the UI then polls the last-sync status
for the result. The scheduler also runs each enabled config on its own interval.

Both flavours may be enabled at once: a dated task then appears **both** as a VTODO
and as a VEVENT (intentional — a to-do that also blocks time on your calendar).

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
values use Carbon's local 23:59 marker ⇄ `VALUE=DATE`.

## Behaviour

- **Completing a calendar-synced task** leaves its VEVENT in place (it stops being
  updated). VTODO completion sets `STATUS:COMPLETED`.
- **Remote deletion**: a deleted VTODO soft-deletes the Carbon task (recoverable via
  the trash); a deleted VEVENT just clears the task's due date and keeps the task.
- **Local deletion** removes the remote object; clearing a task's due date removes
  its VEVENT.
- **Loop-safe**: the connector writes inbound changes as its own CRDT device, and
  uses stored ETags so it never re-ingests the echo of its own writes. Pulled
  resources are reconciled by **UID** as well as href, so a server that stores or
  returns our PUT under a different path (e.g. re-encoding the `@` in the UID, or
  relocating the resource) can't slip through as a duplicate re-import.

## Limitations (MVP)

- **Recurrence is one-way (Carbon → server).** Inbound `RRULE` is ignored; the task
  list mirrors the recurrence master only.
- **Nesting is flat.** Sub-tasks sync as individual VTODOs (no `RELATED-TO` yet).
- **Conflict resolution favours the server.** On a simultaneous edit (a `412` on
  push), the connector re-fetches the remote object and the remote values win for
  mapped fields.
- **Time zones**: UTC (`Z`), all-day (`VALUE=DATE`), and `TZID`-qualified times are all
  resolved exactly — a `DTSTART`/`DUE` carrying a `TZID` (e.g. `Australia/Melbourne`) is
  converted to the correct UTC instant via the IANA tz database bundled with Node (DST
  included). Only a *floating* time (no `Z`, no `TZID`) falls back to the server's local
  wall-clock, since it has no zone to resolve against. Outbound writes are always UTC.
- **Change detection** uses `PROPFIND` + ETag diffing. WebDAV `sync-collection`
  tokens are stored but not yet used as a fast-path.
- **Secrets**: the CalDAV password is stored in the tenant DB in plaintext (same as
  agent API keys); encryption-at-rest is a follow-up. It is never returned by the
  API or written to logs.

## LAN servers

Pointing at a private/LAN CalDAV host (e.g. a Radicale box on `10.x`) requires
private endpoints to be enabled for the workspace — the same gate as private LLM
endpoints (`ALLOW_PRIVATE_AGENT_ENDPOINTS=1` for self-host, or the host-admin
`allow_private_endpoints` flag per tenant). Otherwise the SSRF guard blocks it.

## Verifying against Radicale

```sh
# 1. run a throwaway Radicale
pip install radicale
python -m radicale --storage-filesystem-folder=/tmp/radicale-test \
  --auth-type none --server-hosts 127.0.0.1:5232 &

# 2. run the Carbon server allowing the private target
ALLOW_PRIVATE_AGENT_ENDPOINTS=1 npm --workspace @carbon/server run dev

# 3. in a project, set both collection URLs to e.g.
#    http://127.0.0.1:5232/test/tasks/  and  .../calendar/
#    then click Test, then Sync now.
```

The encode/decode mapping is unit-tested in `apps/server/src/caldav-ical.test.ts`;
the full pull/push/conflict/delete engine is covered against an in-process mock
CalDAV collection in `apps/server/src/caldav.integration.test.ts`. The read-only iCal
feed path (multi-component pull, `304` short-circuit, pure-mirror deletion) is covered
in `apps/server/src/caldav-ical-feed.test.ts`.
