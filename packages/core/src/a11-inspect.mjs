#!/usr/bin/env node
// A11: Analyze which unreviewed core functions are already tested.
import { readFileSync } from 'fs';

const SRC = '/home/ku7/git/carbon_dev/packages/core/src';
const LEDGER = '/home/ku7/git/carbon_dev/docs/internal/a0/ledger';

// Read ledger
const ledger = JSON.parse(readFileSync(LEDGER + '/core.json', 'utf8'));
const unreviewed = ledger.filter(e => e.status === 'unreviewed');

// Read all test files
let testContent = '';
const testFiles = [
  'availability.test.ts', 'bench.test.ts', 'compaction.test.ts', 'federation-core.test.ts',
  'folders.test.ts', 'geo-near.test.ts', 'geo.test.ts', 'invariants.test.ts', 'notebooks.test.ts',
  'notes.test.ts', 'opencounts.test.ts', 'perspectives.test.ts', 'recurrence.test.ts',
  'repo.test.ts', 'sync-epoch.test.ts', 'tags.test.ts', 'timetrack.test.ts', 'trash.test.ts',
  'test-fixtures.test.ts', 'field-shape.test.ts', 'crdt.test.ts', 'sync-records.test.ts',
  'migration-cursor.test.ts', 'blob-inventory.test.ts', 'backup-manifest.test.ts',
  'review.test.ts', 'test-helpers.test.ts'
];

for (const tf of testFiles) {
  try {
    testContent += '\n' + readFileSync(SRC + '/' + tf, 'utf8');
  } catch {}
}

// For each unreviewed function, check if it appears in test files
const results = {};
for (const entry of unreviewed) {
  const name = entry.name;
  const regex = new RegExp(`\\b${name}\\s*\\(`);
  const inTests = regex.test(testContent);
  results[entry.id] = {
    name: name,
    file: entry.file,
    inTests: inTests
  };
}

console.log(JSON.stringify(results, null, 2));
