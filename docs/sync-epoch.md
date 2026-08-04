# Sync log growth & epoch reset

Carbon’s sync source of truth is two append-only SQLite logs (`ops` for item field
patches, `record_ops` for row entities). Clients keep a **full replica** (sql.js in
memory, persisted to IndexedDB). Each sync pull returns every visible row with
`rowid > cursor` in one JSON body — there is no pagination.

## When size starts to hurt

| Symptom | Rough trigger | Why |
|--------|----------------|-----|
| Slow / OOM first sync or long offline catch-up | Delta / full pull tens of MB+ | Unpaged pull + one giant JSON parse |
| UI jank, high memory, slow persist | Local DB ~50–200+ MB | Entire DB in WASM heap; persist re-exports the blob |
| Browser quota / failed persist | Hundreds of MB–GBs | IndexedDB limits |
| Server disk / backup time | GBs | Least urgent for typical workspaces |

**Rule of thumb:** keep total `ops` + `record_ops` well under ~50 MB. Past ~100 MB,
expect first-sync and client RAM issues first. SQLite itself is fine much larger;
**sql.js + unpaged sync** are the bottlenecks.

Per-row cost (order of magnitude): small field patches ~200–400 B; create ops ~0.5–2 KB;
note bodies ≈ note size per edit until note compaction keeps one winner; `record_ops`
store full JSON snapshots (settings scopes rewrite often).

## Tier 1 — safe prune (cursors stay valid)

Delete only LWW losers that cannot affect convergence. **Never delete the row holding
`MAX(rowid)`** — SQLite can reuse that value, and a peer sitting at that cursor would
skip the reused op forever.

Already in tree: superseded **note-only** ops (`compactNoteOps`). Also: superseded
**`setting`** record_ops (latest winner per scope + user). Optional `VACUUM` after large
deletes reclaims file space without renumbering rowids.

This does **not** shrink creates, status flips, shares, comments, etc.

## Tier 2 — sync epoch reset (breaks incremental sync)

Rare **operator** maintenance: rebuild the logs from materialized current state, bump
workspace `sync_epoch`, force clients off old cursors.

```bash
# From apps/server (same DATABASE_PATH / CONTROL_DB_PATH as the server):
npm run reset-sync-epoch -w @carbon/server -- <tenant|default>
```

Effects:

- Edit **history** is discarded; **current** item/entity state is preserved.
- All client `last_sync_seq` / `last_sync_rseq` cursors become invalid.
- Active **federation links must be revoked first** (the script refuses otherwise). Peers
  need a manual re-bootstrap after the owning workspace resets.

The epoch is stored in server-only `workspace_settings` (`sync_epoch`, default `1`) and
advertised on `/api/health` and `/api/sync`. Clients bind it in local `meta.sync_epoch`
on first successful sync after a wipe. On mismatch they block incremental sync and show
a recovery gate: download local DB, clear cache and re-download, or log out and operate
offline.
