# Data security

## Storage and access

Each workspace has a separate SQLite database and attachment directory. Members can
access items shared with them; attachment downloads require access to a referencing item.
Federation shares selected subtrees with another workspace.

Carbon is not end-to-end encrypted. Server operators can read stored workspace data,
including integration credentials. Use HTTPS to protect traffic between clients and
the server; self-hosted installations need a TLS reverse proxy.

## Authentication

- Sync accounts require a password and two-factor authentication through email or an authenticator app.
- Trusted devices receive a secret that rotates on login. Users and administrators can reset device trust.
- Passwords use salted scrypt hashes. Session tokens are hashed on the server, expire after inactivity and are revoked on sign-out.
- Basic authentication is limited to login. Task and sync requests use bearer tokens.
- Integration keys act as their owner and are restricted by scope. Personal keys also support expiry and project restrictions.
- Open mode is disabled by default. `ALLOW_OPEN_MODE=1` enables it for single-tenant installations without accounts.

See [API authentication](api.md#authentication) for token and device-trust details.

## Local data

Without sync, tasks and notes remain in browser or app storage. External images and
enabled integrations can still contact their providers. Anyone with access to the
device or its storage may be able to read local data.

**Settings → Data backup** exports the database and attachments. Notes can also be
exported as Markdown with images. Sign-out offers the option to erase the local copy.

## Deletion and recovery

Deletion uses sync tombstones: it hides records but does not erase them from databases
or shrink database files. **Recently Deleted** allows restoration for 30 days.

Before resetting local data, export any edits that have not synced. A reset removes
the device database and downloads the server copy.

Self-hosted operators must back up databases and attachments together. See
[backup and restore](self-hosting.md) and [sync maintenance](sync-epoch.md).

## External services

Push notifications use Web Push or Firebase Cloud Messaging. AI requests go to the
configured model or webhook provider. Calendar sync stores credentials on the server.
Location lookups use the configured geocoding provider. These services receive the
data needed to perform the requested action.
