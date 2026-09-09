/**
 * A8: Large workspace performance benchmark — virtualized lists and drag.
 * Uses core test fixtures with better-sqlite3 to measure database operations
 * at the normal target (10k active + 90k historical).
 */
import {
  seedLargeWorkspace,
  liveItemCount,
  deletedItemCount,
} from '../packages/core/src/test-fixtures.js';
import { openMemoryDb } from '../packages/core/src/test-helpers.js';
import {
  allItems,
  queryItems,
  getItem,
  getChildren,
  getProjects,
  getFolders,
  openCountsByContainer,
  deletedRoots,
  trashCount,
  needsReview,
  isOverdue,
} from '../packages/core/src/index.js';

function bench(name, fn) {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  console.log(`  ${name}: ${elapsed.toFixed(1)}ms${result ? ` (${result} rows)` : ''}`);
  return elapsed;
}

function benchRepeated(name, fn, iterations = 5) {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = bench(`${name} (run ${i + 1})`, fn);
    times.push(t);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  console.log(`  ${name} avg: ${avg.toFixed(1)}ms (min ${min.toFixed(1)}ms, max ${max.toFixed(1)}ms)`);
  return avg;
}

console.log('=== A8: Large Workspace Performance Benchmark ===\n');
console.log('Scenario: 10k active + 90k historical tasks\n');

// Seed the workspace
console.log('Seeding workspace...');
const db = openMemoryDb();
const start = performance.now();
const counts = seedLargeWorkspace(db, 'test-device', { active: 10_000, historical: 90_000 });
const seedTime = performance.now() - start;
console.log(`Seeded: ${counts.active} active, ${counts.historical} historical in ${seedTime.toFixed(1)}ms\n`);

// Verify counts
console.log('Counts:');
console.log(`  liveItemCount: ${liveItemCount(db)}`);
console.log(`  deletedItemCount: ${deletedItemCount(db)}`);

console.log('\n--- Query Operations (repeated for stable measurements) ---');

// allItems — loads every live row
benchRepeated('allItems()', () => allItems(db).length);

// queryItems for "today" view (flagged or due)
benchRepeated('queryItems(today)', () => queryItems(db, { tasksOnly: true, activeOnly: true, dueOrFlagged: true }).length);

// queryItems for "flagged" view
benchRepeated('queryItems(flagged)', () => queryItems(db, { tasksOnly: true, activeOnly: true, flaggedOnly: true }).length);

// queryItems for "inbox" view
benchRepeated('queryItems(inbox)', () => queryItems(db, { tasksOnly: true, activeOnly: true, rootOnly: true }).length);

// queryItems for "all" view
benchRepeated('queryItems(all)', () => queryItems(db, { tasksOnly: true, activeOnly: true }).length);

console.log('\n--- Sidebar Count Operations ---');

// These are what the sidebar computes for its badges
benchRepeated('getProjects()', () => getProjects(db).length);
benchRepeated('getFolders()', () => getFolders(db).length);

// Open counts by container
const projects = getProjects(db);
benchRepeated('openCountsByContainer(projects)', () => {
  const counts = openCountsByContainer(db, projects.map(p => p.id), 'all');
  return counts.size;
});

// Needs review count
benchRepeated('needsReview count', () => projects.filter(p => needsReview(p)).length);

// Overdue count
benchRepeated('isOverdue count', () => allItems(db).filter(i => i.type === 'task' && isOverdue(i)).length);

// Trash count
benchRepeated('deletedRoots()', () => deletedRoots(db).length);
benchRepeated('trashCount() (lightweight)', () => trashCount(db));

console.log('\n--- Individual Item Access ---');

// getItem — should be fast (single row lookup)
const someItem = allItems(db)[0];
if (someItem) {
  benchRepeated('getItem()', () => !!getItem(db, someItem.id));
  benchRepeated('getChildren()', () => getChildren(db, someItem.id).length);
}

console.log('\n=== Benchmark Complete ===');
