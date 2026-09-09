import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBackupManifest,
  validateManifest,
  parseBackupManifest,
  verifyManifestBlob,
  bytesToBase64,
  base64ToBytes,
  sha256Hex,
  hasUnsafePath,
  BACKUP_FORMAT,
  type ManifestBlob,
} from './backup-manifest';

/** A well-formed manifest blob entry whose bytes hash to its name. */
async function goodBlob(bytes: Uint8Array, hash?: string): Promise<ManifestBlob> {
  const h = hash ?? (await sha256Hex(bytes));
  return { hash: h, size: bytes.length, checksum: h, b64: bytesToBase64(bytes) };
}

test('buildBackupManifest → parse → verify round-trips a complete export', async () => {
  const db = new Uint8Array([1, 2, 3, 4]);
  const img = new Uint8Array([9, 8, 7, 6, 5]);
  const man = buildBackupManifest({ db, blobs: [{ hash: await sha256Hex(img), bytes: img }], missing: [] });

  assert.equal(man.format, BACKUP_FORMAT);
  assert.equal(man.complete, true, 'no missing ⇒ complete');
  const parsed = parseBackupManifest(JSON.stringify(man));
  assert.equal(parsed.blobs.length, 1);
  assert.equal(await verifyManifestBlob(parsed.blobs[0]!), true, 'shipped bytes hash to the name');
  // The db bytes survive the base64 round-trip.
  assert.deepEqual(base64ToBytes(parsed.db), db);
});

test('verifyManifestBlob rejects a checksum/size/content mismatch (not silently accepted)', async () => {
  const img = new Uint8Array([1, 1, 1, 1]);
  const real = await sha256Hex(img);

  // Corrupt the content: bytes no longer hash to the name.
  const corrupt = await goodBlob(new Uint8Array([2, 2, 2, 2]), real);
  assert.equal(await verifyManifestBlob(corrupt), false, 'corrupt content rejected');

  // Wrong size field.
  const wrongSize = await goodBlob(img);
  assert.equal(await verifyManifestBlob({ ...wrongSize, size: wrongSize.size + 1 }), false);

  // checksum field that does not match the content.
  const badChecksum = await goodBlob(img);
  assert.equal(
    await verifyManifestBlob({ ...badChecksum, checksum: await sha256Hex(new Uint8Array([0])) }),
    false,
    'checksum mismatch rejected',
  );
});

test('an export with an unfetchable reference is marked incomplete + reported', () => {
  const man = buildBackupManifest({
    db: new Uint8Array([1]),
    blobs: [],
    missing: ['deadbeef'.repeat(8)],
  });
  assert.equal(man.complete, false, 'missing reference ⇒ not complete');
  assert.ok(man.missing.length === 1);
  // A tampered manifest that claims complete with a non-empty missing list is
  // still reported incomplete by the validator.
  const parsed = validateManifest({ ...man, complete: true });
  assert.equal(parsed.complete, false, 'validator overrides a false completeness claim');
});

test('validateManifest rejects unsupported versions, reserved keys, unsafe paths, malformed records', async () => {
  const db = new Uint8Array([1]);
  const base = buildBackupManifest({ db, blobs: [], missing: [] });

  assert.throws(() => validateManifest({ ...base, version: 99 }), /Unsupported backup version/);
  assert.throws(() => validateManifest({ ...base, format: 'not-carbon' }), /Not a Carbon backup/);

  // A reserved key (not a valid 64-hex hash) is rejected.
  const reserved = await goodBlob(new Uint8Array([1]), 'blobMeta'.padEnd(64, '0').slice(0, 64));
  assert.throws(
    () => validateManifest({ ...base, blobs: [reserved] }),
    /Invalid or reserved|Reserved key/,
  );

  // Malformed record (bad hash).
  assert.throws(
    () => validateManifest({ ...base, blobs: [{ hash: 'nope', size: 1, checksum: 'x', b64: '' }] }),
    /Invalid or reserved blob key/,
  );

  // Unsafe path carried on a record (a future slug/filename field).
  const withPath = await goodBlob(new Uint8Array([1]));
  assert.throws(
    () => validateManifest({ ...base, blobs: [{ ...withPath, slug: '../../etc/passwd' }] as never }),
    /Unsafe path/,
  );
});

test('hasUnsafePath flags traversal / absolute / null bytes and spares normal values', () => {
  assert.equal(hasUnsafePath('../x'), true);
  assert.equal(hasUnsafePath('/abs'), true);
  assert.equal(hasUnsafePath('C:\\win'), true);
  assert.equal(hasUnsafePath('a\0b'), true);
  assert.equal(hasUnsafePath('notes/n1.md'), false, 'a normal relative path is safe');
  assert.equal(hasUnsafePath('0123456789abcdef'.repeat(4)), false, 'a hash is safe');
});

test('legacy blobs are retained and checksummed; future versions and cache keys fail', async () => {
  const { decodeVerifiedBackup } = await import('./backup-manifest');
  const blob = await goodBlob(new Uint8Array([255, 255, 255])); // base64 begins with '/', not a path
  const legacy = { format: BACKUP_FORMAT, version: 1, db: 'AQ==', blobs: { [blob.hash]: blob.b64 } };
  assert.equal(Object.keys((await decodeVerifiedBackup(legacy)).blobs).length, 1);
  await assert.rejects(decodeVerifiedBackup({ ...legacy, version: 99 }), /Unsupported/);
  await assert.rejects(decodeVerifiedBackup({ ...legacy, blobs: { pendingBlobs: 'AQ==' } }), /reserved/);
  await assert.rejects(decodeVerifiedBackup({ ...legacy, blobs: { [blob.hash]: 'AQ==' } }), /Corrupt/);
});

test('v2 rejects a corrupt database and incomplete bundles before activation', async () => {
  const { decodeVerifiedBackup } = await import('./backup-manifest');
  const db = new Uint8Array([1, 2]);
  const manifest = { ...buildBackupManifest({ db, blobs: [], missing: [] }), db_checksum: await sha256Hex(db) };
  assert.deepEqual((await decodeVerifiedBackup(manifest)).db, db);
  await assert.rejects(decodeVerifiedBackup({ ...manifest, db: 'AQ==' }), /checksum/);
  await assert.rejects(decodeVerifiedBackup({ ...manifest, complete: false }), /Incomplete/);
  await assert.rejects(decodeVerifiedBackup({ ...manifest, blobs: {} }), /inventory/);
});
