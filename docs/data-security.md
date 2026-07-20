# Data security

How Carbon handles your data: where it lives, how it's isolated between customers, how it's
protected in transit and behind authentication, and what happens when you run Carbon
**local-only** (no server) — in which case your data never leaves your device.

This document describes the security model honestly, including its boundaries. If a detail
matters to your decision, it's stated plainly rather than glossed over.

---

## At a glance

| Topic | Summary |
|---|---|
| **Isolation** | Each workspace/tenant lives in its own separate database. No shared tables across customers. |
| **In transit** | All client ⇄ server traffic is protected by **TLS (HTTPS)**. |
| **Authentication** | Login is required to reach a hosted workspace; sessions use opaque, revocable tokens — your password is never stored on your device. |
| **Local-only mode** | With no sync server configured, the entire database stays in your browser/app on your device and is never transmitted anywhere. |
| **Data ownership** | One-click full export of your entire database and attachments. No vendor lock-in. |
| **Attachments** | Files are content-addressed and access-checked per item — you can only download a file attached to something you're allowed to see. |
| **What we don't do** | Carbon is **not** end-to-end encrypted. Confidentiality in transit relies on TLS; data at rest on the server is readable by the server operator. See [Boundaries](#boundaries-what-carbon-does-not-do). |

---

## 1. Isolated workspaces (one customer, one database)

On Carbon's hosted offering, **each workspace is fully isolated in its own database**. There
is no shared, multi-customer table that mixes one workspace's tasks, notes, or files with
another's.

- **One workspace = one family/team = one dedicated SQLite database.** Workspaces are
  addressed by their own subdomain (e.g. `your-workspace.carbon.etx.sx`), and each request
  is routed to that workspace's own database.
- **No cross-workspace queries.** Because the data lives in physically separate database
  files, there is no query path that can return another workspace's data — isolation is
  structural, not just a `WHERE tenant_id = …` filter that a bug could bypass.
- **Per-workspace blob storage.** File attachments for a workspace are stored in that
  workspace's own storage area, not a shared pool.

If you **self-host**, this is even simpler: you run your own server, so all data is in *your*
database on *your* infrastructure, isolated from everyone by definition.

---

## 2. Protected in transit (TLS)

All traffic between your client (web browser, desktop app, or mobile app) and the Carbon
server is carried over **TLS / HTTPS**.

- **Encryption in transit.** Your tasks, notes, comments, attachments, and login credentials
  are encrypted on the wire so they can't be read or tampered with by anyone between your
  device and the server.
- **Tokens travel in headers, never URLs.** API and session tokens are sent in the
  `Authorization` header — never in query strings — so they don't end up in logs or browser
  history.
- **Mobile mixed-content protection.** The mobile app serves its UI from a secure origin and
  will refuse to talk to a plain-HTTP server, preventing an accidental unencrypted connection.

> **Operator note (self-host):** TLS is terminated at your reverse proxy (Caddy, nginx, Nginx
> Proxy Manager, Traefik, etc.). Always put Carbon behind HTTPS when it is reachable beyond
> `localhost` — tokens and data must never cross a network in the clear.

---

## 3. Secured by login (authentication & authorization)

### Sign-in and sessions

- A hosted workspace **requires sign-in**. Unauthenticated requests to a workspace are
  rejected and redirected to the sign-in gate.
- **Your password is never stored on your device.** When you sign in, your username and
  password are exchanged **once** (then completed with 2FA when required) for an opaque,
  server-issued **session token**. The client stores only that token; the password is never
  written to local storage.
- **Two-factor authentication is mandatory** for sync accounts (not local-only; open mode is
  opt-in via `ALLOW_OPEN_MODE=1` and disabled by default). Users enroll an **email** one-time
  code and/or an **authenticator app** (TOTP, with QR + manual secret). Either factor unlocks
  a **new device**; they are backups of each other, not stacked. One-use recovery codes cover
  lockout.
- **Trusted devices are remembered indefinitely** after a successful 2FA (or enrollment) on
  that device. Trust can be reset by the user (Settings → Security), a workspace admin, or
  the server console (`npm run mfa-admin`). Every new device must pass 2FA again.
- **Password alone cannot call the API.** Basic auth is limited to `POST /api/login`; sync
  and admin routes require a session (or a scoped integration token).
- **Sessions are revocable and expiring.** Session tokens are random, stored only as a hash on
  the server, slide forward on use, and expire after a period of inactivity. Signing out
  revokes the token immediately, server-side.
- **Passwords are hashed.** Account passwords are stored using salted **scrypt** hashing — the
  server never keeps your plaintext password. TOTP secrets live in the server-only `user_auth`
  table (same trust boundary as the database file).

### Authorization (who can see and do what)

- **Sharing is explicit.** Within a workspace, you choose what to share. Items you haven't
  shared are not visible to other members; sharing an item can optionally extend to its
  subtree.
- **Scoped integration tokens.** API tokens (for Home Assistant, scripts, bots) are limited to
  narrow scopes — `tasks:read`, `tasks:write`, or `inbox:write`. A capture-only automation can
  be given a token that can *only* drop new tasks into the inbox and nothing else. Integration
  tokens can never reach admin functions.
- **Per-item attachment access.** Downloading a file requires that you can see an item that
  references it. A request for a file you have no access to returns "not found" — its very
  existence isn't revealed.
- **Bot/agent permissions are constrained.** Automated agents can read for context but can only
  comment on or complete tasks they've been explicitly assigned or mentioned on.

---

## 4. Local-only mode — your data never leaves your device

Carbon is **offline-first**. The entire database runs **inside your browser or app**, on your
device, and every change is applied locally first.

**If you never configure a sync server, your data never leaves your device.** There is no
account, no upload, and no network transmission of your tasks, notes, or files — Carbon
functions as a fully local application. The database is persisted locally (in browser storage /
the app's local storage) and stays there.

- **No silent telemetry of your content.** Your task content is not sent anywhere in
  local-only mode.
- **You opt in to sync.** Data only begins syncing when *you* point Carbon at a server
  (**Settings → Sync server**) and sign in. Until then it's purely local.
- **You can leave at any time.** Because the database is local, you can export it in full
  (below) without ever touching a server.

This makes local-only mode a strong choice for the most sensitive use: nothing to breach on a
server because nothing is on a server.

---

## 5. Data ownership & export

Your data is yours, in a portable form, at all times.

- **Full export.** **Settings → Data backup** exports your *entire* database plus all
  attachment blobs as a single file — every task, note, comment, tag, and file. Notes can
  also be exported as a Markdown + images zip.
- **Full import / merge.** The same file can be imported back. Import is a non-destructive
  merge, so you can move between devices or servers without losing or duplicating data.
- **Sync recovery.** **Reset local data** re-downloads from the server when a device copy is
  corrupt; sign-in offers **Merge** or **Replace** over existing local data; sign-out can
  **erase** the local copy on shared devices.
- **No lock-in.** Self-hosting and local-only mode mean you are never dependent on a vendor to
  retain access to your own information.

---

## 6. Boundaries — what Carbon does *not* do

Honesty matters more than marketing here. Know exactly what you're getting:

- **Not end-to-end encrypted.** Carbon is **not** a zero-knowledge system. Confidentiality in
  transit is provided by TLS, but data **at rest on the server is stored in readable form**.
  This means **the server operator can read workspace data**. On the hosted offering that's the
  Carbon operator; if you self-host, it's you. If you require that *no one* operating the server
  can read your data, Carbon's current model does not meet that bar — use local-only mode for
  truly private data, or self-host so you *are* the only operator.
- **Shared-workspace trust model.** Within one workspace the trust model is "people who share a
  workspace trust each other." Any member can read and edit items shared with them. Workspaces
  are the isolation boundary; individual members within a workspace are not isolated from shared
  content.
- **Push notifications transit third parties.** If you enable push notifications, delivery uses
  standard web/mobile push services (Web Push / Firebase Cloud Messaging). Notification *content*
  should be treated as passing through those services; sensitive detail can be kept out of
  notification text.
- **Backups are your responsibility (self-host).** If you self-host, securing and backing up
  the database and blob files — and keeping TLS in front of the server — is up to you.
- **"Purge" is a soft delete, not an erase.** Settings → Data's "Purge completed tasks" (and
  deletion generally) uses Carbon's normal CRDT tombstone mechanism — there is no hard-delete
  primitive in the sync model. A purge hides data rather than erasing it: it syncs like any
  other delete, does not shrink the on-disk database file, and tombstoned records can still
  exist at rest on every synced device and on the server. If you intend to purge, export a
  backup first so you keep a copy of what you're removing.

End-to-end encrypted sync is tracked as a possible future direction, but it is not implemented
today and you should not assume it.

---

## 7. Database integrity & schema design

**No SQL foreign keys.** Carbon's database schema intentionally disables SQLite's `PRAGMA foreign_keys`
constraint enforcement. This is not a gap—it's a deliberate design choice.

- **Soft-delete tombstones with app-level integrity.** Carbon uses CRDT tombstones to track
  deletions (see Section 6 on "Purge"). Cascading deletes are enforced in application code
  rather than via SQL triggers or foreign key constraints. This gives finer control over sync
  behavior and avoids the need for table rebuilds during schema migrations.
- **No schema-level constraints.** Without SQL foreign keys, the database schema is simpler and
  more resilient to changes. Referential integrity is guarded by the application's sync and
  persistence layers, not by the database.

This design centralizes data safety in the application rather than the database. The tradeoff is
that malformed queries or corrupted data at rest could violate logical consistency — a reason to
keep database access tightly controlled and backups current (see Section 8).

---

## 8. Backups (self-host)

Section 6 is blunt that backing up the database is your responsibility when you self-host.
`apps/server/scripts/backup-dbs.ts` gives you a ready-made way to do that on a schedule,
rather than relying solely on the on-demand full export (Section 5) or remembering to copy
files by hand.

- **What it backs up.** The default (single-tenant) DB, the control-plane DB (multi-tenant
  hosts only), and every tenant DB under `TENANTS_DIR`. It reads the same `DATABASE_PATH`,
  `CONTROL_DB_PATH`, and `TENANTS_DIR` environment variables the server itself uses, so it
  finds the same files without extra configuration.
- **Consistent snapshots, no downtime.** Each database is WAL-mode, so a plain file copy could
  catch a database mid-write. The script instead opens each DB read-only and runs
  `VACUUM INTO`, which SQLite guarantees produces a single, self-consistent snapshot file —
  safe to run against a live server, no need to stop it first.
- **Where backups land.** Snapshots are written under `BACKUP_DIR` (default: a `backups/`
  folder next to your data directory), one timestamped `.db` file per source database, grouped
  into `default/`, `control/`, and `tenants/<id>/` subfolders.
- **Retention.** Old snapshots are pruned automatically after `BACKUP_RETENTION_DAYS` days
  (default **14**). Each run backs up first, then prunes, so you always have at least one
  fresh snapshot even if retention is set aggressively low.
- **Running it.** `npm run backup -w @carbon/server`, or on a schedule via the systemd timer
  example below. Exits non-zero if any individual database failed to back up, so a cron/timer
  failure is easy to alert on; a missing file (e.g. a tenant that doesn't exist yet) is logged
  and skipped, not treated as an error.

### Restore procedure

1. **Stop the server** (`systemctl stop carbon` or equivalent) — restoring into a running
   server risks the live process immediately overwriting what you restore.
2. **Copy the backup file back** over the live database path, e.g.:
   ```
   cp /path/to/backups/default/2026-07-08T12-00-00-000Z.db /path/to/data/carbon.db
   ```
   For a tenant DB, copy into `TENANTS_DIR/<id>/carbon.db`; for the control DB, into
   `CONTROL_DB_PATH`.
3. **Remove any stale WAL/SHM side-files** next to the path you restored (`carbon.db-wal`,
   `carbon.db-shm`) if present, so the server doesn't try to replay a WAL from before the
   restore.
4. **Restart the server.**

Restoring only rewinds the database you copied — if you're restoring a tenant DB, its blob
storage directory is untouched, so attachments referenced by data older than your backup may
be missing (blobs are additive and rarely deleted, so this is usually only relevant if you're
rolling back a long way).

### Example systemd timer

Run the backup daily via a systemd service + timer pair. Adjust `WorkingDirectory`, `User`,
and the env vars to match your deployment:

```ini
# /etc/systemd/system/carbon-backup.service
[Unit]
Description=Carbon database backup
After=network.target

[Service]
Type=oneshot
User=carbon
WorkingDirectory=/opt/carbon/apps/server
Environment=DATABASE_PATH=/opt/carbon/data/carbon.db
Environment=BACKUP_DIR=/opt/carbon/backups
Environment=BACKUP_RETENTION_DAYS=14
ExecStart=/usr/bin/npm run backup
```

```ini
# /etc/systemd/system/carbon-backup.timer
[Unit]
Description=Run carbon-backup.service daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now carbon-backup.timer`. Check `systemctl status
carbon-backup.timer` and `journalctl -u carbon-backup.service` to confirm it's running and
succeeding.

---

## 9. Self-host security checklist

If you run your own Carbon server:

- [ ] Serve **only over HTTPS** (TLS at your reverse proxy) whenever it's reachable beyond
      `localhost`.
- [ ] Require login — create user accounts (`npm run add-user`). Do **not** set
      `ALLOW_OPEN_MODE=1` on anything internet-facing (open mode is off by default).
- [ ] Behind a reverse proxy, set `TRUST_PROXY=1` so per-IP rate limits use the real client
      address; set `CORS_ORIGINS` on hosted (`BASE_DOMAIN`) deploys instead of default `*`.
- [ ] If using the Telegram bot webhook, set `TELEGRAM_WEBHOOK_SECRET` (required).
- [ ] Give integrations the **narrowest token scope** they need (`inbox:write` for capture).
- [ ] Keep `tasks:write` and admin tokens off automations you don't fully control.
- [ ] Back up the database and attachment storage; protect those backups — see Section 8 for
      an automated, scheduled way to do this.
- [ ] Keep the Firebase service-account key (if using Android push) **server-side only** —
      never in a shipped app.

---

## Related

- [`api.md`](api.md) — REST API authentication, scopes, and token handling.
- [`home-assistant.md`](home-assistant.md) — keeping integration tokens safe.
- [`usage-and-shortcuts.md`](usage-and-shortcuts.md) — offline & sync behaviour, data backup.
