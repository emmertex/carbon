# Backup and restore

Run `npm run backup -w @carbon/server` with the server’s environment configuration.

## Backups

The script snapshots the default, control and tenant databases using `VACUUM INTO`.
It reads `DATABASE_PATH`, `CONTROL_DB_PATH` and `TENANTS_DIR` from the environment
and can run while the server is active.

Snapshots are stored under `BACKUP_DIR/default`, `control` or `tenants/<id>`, each
in a timestamped directory containing `carbon.db`, a checksum manifest and workspace
`blobs/`. Missing or corrupt content fails the backup and returns a nonzero exit code.

`BACKUP_RETENTION_DAYS` defaults to 14. Retention removes older complete snapshots
only after a successful backup of the same source.

## Restore

1. **Stop the server.**
2. **Verify the snapshot.** Check each file against `manifest.json` (SHA-256 and
   size). Keep the current database and blobs as a rollback copy.
3. **Restore both parts.** Copy the snapshot's `carbon.db` to the configured database
   path and its `blobs/` files to that workspace's blob directory. Remove the stopped
   database's old `-wal` and `-shm` sidecars. Control-plane snapshots contain only a DB.
4. **Reset the sync generation** using [sync epoch reset](sync-epoch.md) before
   allowing clients to write; follow the recovery negotiation instructions.
5. **Restart the server.** Verify images and attachments before discarding rollback copies.

Browser exports fetch and verify every referenced blob. Missing/corrupt content produces
an explicit incomplete-backup error instead of a successful download. Imports accept
version 1 and 2 bundles with the current database schema, verify content and versions, and stage the merge before durable
activation. Version 2 also checksums the database. Failed activation leaves existing
records intact; safely staged content may remain cached for a retry.
