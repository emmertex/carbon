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
  password are exchanged **once** for an opaque, server-issued **session token**. The client
  stores only that token; the password is never written to local storage.
- **Sessions are revocable and expiring.** Session tokens are random, stored only as a hash on
  the server, slide forward on use, and expire after a period of inactivity. Signing out
  revokes the token immediately, server-side.
- **Passwords are hashed.** Account passwords are stored using salted **scrypt** hashing — the
  server never keeps your plaintext password.

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
  attachment blobs as a single file — every task, note, comment, tag, and file.
- **Full import / merge.** The same file can be imported back. Import is a non-destructive
  merge, so you can move between devices or servers without losing or duplicating data.
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

End-to-end encrypted sync is tracked as a possible future direction, but it is not implemented
today and you should not assume it.

---

## 7. Self-host security checklist

If you run your own Carbon server:

- [ ] Serve **only over HTTPS** (TLS at your reverse proxy) whenever it's reachable beyond
      `localhost`.
- [ ] Require login — set up user accounts rather than running open mode on anything
      internet-facing.
- [ ] Give integrations the **narrowest token scope** they need (`inbox:write` for capture).
- [ ] Keep `tasks:write` and admin tokens off automations you don't fully control.
- [ ] Back up the database and attachment storage; protect those backups.
- [ ] Keep the Firebase service-account key (if using Android push) **server-side only** —
      never in a shipped app.

---

## Related

- [`api.md`](api.md) — REST API authentication, scopes, and token handling.
- [`home-assistant.md`](home-assistant.md) — keeping integration tokens safe.
- [`usage-and-shortcuts.md`](usage-and-shortcuts.md) — offline & sync behaviour, data backup.
</content>
</invoke>
