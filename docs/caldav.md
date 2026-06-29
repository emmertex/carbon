# CalDAV two-way sync

Carbon can two-way sync a **project** against an external CalDAV server (Nextcloud,
Radicale, Fastmail, iCloud, …). It runs as a **CalDAV client** on the Carbon
**server** — so a configured/signed-in server is required; it does not run in
local-only/offline mode.

Configuration is **per project**, in the project's detail pane (admin only). The
binding holds the CalDAV password, so it is stored server-side and is **not** part
of the CRDT sync — it never propagates to clients.

## Setup

Open a project → **Calendar sync** → _Set up CalDAV sync_. Enter:

- **Username / Password** for the CalDAV account.
- One or both sync flavours, each with its own **collection URL** (paste the full
  collection href; auto-discovery is not implemented yet):
  - **Sync Tasks (VTODO)** — every task in the project ⇄ a VTODO in a task-list
    collection.
  - **Sync Calendar Events (VEVENT)** — every task **with a due date** → a VEVENT in
    a calendar collection, and inbound VEVENTs → new tasks in the project.
- **Sync every (seconds)** — minimum 60; default 300.
- **Default event length** — used for a dated task that has no time estimate.

Use **Test** to PROPFIND the collection(s), and **Sync now** to run a pass
immediately. The scheduler also runs each enabled config on its own interval.

Both flavours may be enabled at once: a dated task then appears **both** as a VTODO
and as a VEVENT (intentional — a to-do that also blocks time on your calendar).

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
  uses stored ETags so it never re-ingests the echo of its own writes.

## Limitations (MVP)

- **Recurrence is one-way (Carbon → server).** Inbound `RRULE` is ignored; the task
  list mirrors the recurrence master only.
- **Nesting is flat.** Sub-tasks sync as individual VTODOs (no `RELATED-TO` yet).
- **Conflict resolution favours the server.** On a simultaneous edit (a `412` on
  push), the connector re-fetches the remote object and the remote values win for
  mapped fields.
- **Time zones**: UTC (`Z`) and all-day (`VALUE=DATE`) are exact; a `DTSTART`/`DUE`
  carrying a `TZID` is interpreted as local wall-clock time (no embedded tz
  database).
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
CalDAV collection in `apps/server/src/caldav.integration.test.ts`.
