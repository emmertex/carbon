import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { blobReferenceInventory, type Db } from '@carbon/core';

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** A directory becomes visible as a successful backup only after DB + every
 * referenced blob (including trash) are copied, verified and flushed. */
export function backupWorkspace(source: string, destination: string, blobsDir?: string): void {
  const stage = `${destination}.partial-${randomUUID()}`;
  mkdirSync(stage, { recursive: true });
  try {
    const dbPath = join(stage, 'carbon.db');
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try { sourceDb.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`); }
    finally { sourceDb.close(); }
    const snapshot = new DatabaseSync(dbPath, { readOnly: true });
    const files: Record<string, { size: number; sha256: string }> = {};
    try {
      if (Object.values(snapshot.prepare('PRAGMA integrity_check').get()!)[0] !== 'ok') throw new Error('Corrupt database snapshot');
      if (blobsDir) {
        const reader = {
          all: (sql: string, params: unknown[] = []) => snapshot.prepare(sql).all(...params as never[]),
          get: (sql: string, params: unknown[] = []) => snapshot.prepare(sql).get(...params as never[]),
        } as Db;
        mkdirSync(join(stage, 'blobs'));
        for (const hash of blobReferenceInventory(reader).byHash.keys()) {
          if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
          const bytes = readFileSync(join(blobsDir, hash));
          if (digest(bytes) !== hash) throw new Error(`Corrupt blob: ${hash}`);
          const file = `blobs/${hash}`;
          writeFileSync(join(stage, file), bytes);
          syncFile(join(stage, file));
          files[file] = { size: bytes.length, sha256: hash };
        }
      }
    } finally { snapshot.close(); }
    const bytes = readFileSync(dbPath);
    files['carbon.db'] = { size: bytes.length, sha256: digest(bytes) };
    syncFile(dbPath);
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ format: 'carbon-server-backup', version: 1, complete: true, files }, null, 2));
    syncFile(join(stage, 'manifest.json'));
    renameSync(stage, destination);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
