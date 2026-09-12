# Cross-workspace sharing

Federation shares a project subtree with another workspace. Read access allows
viewing; write access allows edits in both directions. Federation is disabled by
default and requires host, workspace and recipient approval.

## The three sharing tiers

| Tier | Scope | Transport |
|---|---|---|
| **L1 — within a workspace** | users inside one workspace | native shares/assignees (always on) |
| **L2 — within a server** | two workspaces (subdomains) on the **same** Carbon host | in-process loopback between the tenant apps |
| **L3 — cross server** | workspaces on **different** Carbon hosts | HTTPS between the two servers |

L1 is ordinary in-workspace sharing and needs no configuration. L2 and L3 are
"federation" proper. They use the identical protocol — L3 is simply L2's delivery step
carried over HTTPS instead of an in-process call.

## Host ceiling — `FEDERATION_MODE` (server operator)

The operator sets the **maximum** federation scope the whole host will permit, via the
`FEDERATION_MODE` environment variable:

- **`off`** *(default)* — L1 only. No federation anywhere on this host.
- **`intra_server`** — L2 allowed, **L3 blocked**. Workspaces on this host can federate
  with each other, but not with any external Carbon host. This is *"disable external
  federation."*
- **`cross_server`** — L2 **and** L3 allowed.

A **single-tenant self-host** (no `BASE_DOMAIN` set) has no meaningful peer, so the
ceiling always resolves to `off` there and the subsystem is inert.

### Per-workspace override

On a multi-tenant host, a host admin can pin one workspace **below** the env default with
a per-tenant `federation_mode` override (via `PATCH /host/tenants/:id`,
`{ "federationMode": "off" | "intra_server" | "cross_server" | null }`; `null` inherits
the env default). This lets you run the host at `cross_server` while pinning one abusive
workspace to `intra_server` or `off`.

The ceiling is the only **hard** external kill switch. It is enforced server-side at
**both** edges of every offer — the sender's outbound check and the recipient's inbound
check — so a misconfigured or malicious peer that skips its own check is still rejected.

## Workspace policy (workspace admin)

Within the ceiling, a workspace **admin** chooses how their workspace shares
(Settings → Federation):

- **`workspace_only`** *(default)* — L1 only. This workspace neither sends nor accepts
  federation offers.
- **`admin_whitelist`** — offers are permitted **only** to/from peers the admin has
  pre-approved (the **Allow List**). A user cannot reach a peer that isn't listed.
- **`user_open`** — any user may send an offer to any address they know, and may receive
  offers from anyone — still subject to the host ceiling and the recipient's approval.

Under `admin_whitelist`, the admin manages the **Allow List** in the same panel (each entry
is a peer subdomain or base URL); peers not on it are refused at both edges.

The admin can also keep a **Deny List**, enforced under **both** `user_open` **and**
`admin_whitelist` — a peer on the Deny List is **always blocked** (deny wins over the Allow
List and over Open), at both edges and for user discovery. Use it to block one workspace
without turning off open sharing. Federation has its own **Settings → Federation** category.

## Sending & accepting an offer

Addresses are `username@subdomain` for a **same-host (L2)** peer, or
`username@subdomain.host` (a dotted host) for a **cross-server (L3)** peer. Carbon does
**no** user discovery — you must know the address out-of-band.

1. **Sender** shares a project: pick the project, enter the recipient's address, choose
   **read** or **write**. The sending workspace runs its outbound gates (ceiling +
   policy) and delivers the offer to the recipient's server.
2. **Recipient's server** runs its inbound gates (ceiling + policy) and, if they pass,
   drops a task into the addressed user's **Inbox** — a "from Carbon" system notice
   naming who wants to share what, with **Approve** / **Decline** actions. There is no
   separate notifications UI; the Inbox task *is* the prompt.
3. **Recipient user** clicks **Approve** (this action is authed to that user's own
   session — nobody else can act on it). The link activates, a **shadow user** is
   provisioned for the sender, and the recipient's server pulls the shared subtree. The
   project materializes in the recipient's workspace; edits then flow both ways within
   the granted subtree.

**Decline** clears the pending link on **both** sides and drops an Inbox notice back to the
person who offered ("… declined your share of …"); no copy is created. Either admin can later
**revoke** an active link (Settings → Federation), which stops the exchange and rejects
further edits on it.

## What a peer can see (trust model)

A federated share is **full-subtree**. A **write** grantee sees the entire shared subtree
and every participant's edits within it, and can push edits back; a **read** grantee
can't write back. **Share only what you'd hand the peer server's operator** — a malicious
peer host learns the shared subtree's structure and content.

Some things are deliberately **not** federated: tags are dropped on ingest, and agents never fire on federated ingest. Attachment **bytes** are fetched on demand from the owning peer
over the link and **hash-verified** before caching, so a peer cannot poison content.

## Network access

Cross-server peers must be reachable at their advertised HTTPS address. Private
addresses require `ALLOW_PRIVATE_AGENT_ENDPOINTS=1`. Same-server sharing uses
in-process delivery. Federation requires a multi-tenant host with `BASE_DOMAIN` set.

## Limitations

- **No offer expiry.** A pending offer stays in the recipient's Inbox until they act on it.
  Pending links never sync anything, so an unanswered offer is inert — decline or dismiss it
  to clear it.
- **Unsharing / moving out retracts the peer's copy.** If you revoke a link, or move an item
  *out* of the shared subtree, the owning side tells the peer, which **drops** its copy
  (rather than leaving a stale one behind or forking on a later edit). Revoking a link you
  own also delivers a best-effort final retraction of everything you'd shared through it.
- **Comment attachments over federation are untested.** Fetch-from-peer for attachment bytes
  is verified for **task** attachments; attachments on *comments* are not yet covered by a
  test and should not be relied on until they are.
- **No cross-workspace user discovery.** You must know the recipient's `username@subdomain`
  out-of-band. Directory lookup between mutually-whitelisted workspaces — and sharing to a
  federation address directly from a task's share dialog — is planned but not yet available.
- **Sync epoch reset invalidates federation cursors.** An operator rebuild of a workspace's
  op log (see [`sync-epoch.md`](sync-epoch.md)) bumps `sync_epoch` and rewrites `ops` /
  `record_ops` rowids. Active federation links must be revoked before that script runs;
  re-establish links afterward so peers pull a fresh bootstrap — do not continue old
  `federation_cursors` across an epoch bump.

## Environment variables

| Variable | Effect |
|---|---|
| `FEDERATION_MODE` | Host ceiling: `off` (default) \| `intra_server` \| `cross_server`. |
| `ALLOW_PRIVATE_AGENT_ENDPOINTS=1` | Also lets L3 federation reach private/loopback/LAN peers (same flag agents/CalDAV use). |
| `BASE_DOMAIN` | Must be set for multi-tenant / any federation; unset ⇒ single-tenant self-host, federation inert. |
