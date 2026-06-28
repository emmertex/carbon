import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { MilestoneResult } from './workload';

function gitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const f1 = (n: number | undefined) => (n === undefined ? '—' : n.toFixed(1));

interface Row {
  op: string;
  category: string;
  /** p50/p95/max per milestone. */
  per: Map<number, { p50: number; p95: number; max: number; count: number }>;
}

function buildRows(results: MilestoneResult[]): Row[] {
  const byKey = new Map<string, Row>();
  for (const r of results) {
    for (const b of r.buckets) {
      const op = `${b.category}:${b.label}`;
      let row = byKey.get(op);
      if (!row) {
        row = { op, category: b.category, per: new Map() };
        byKey.set(op, row);
      }
      row.per.set(r.milestone, { p50: b.p50, p95: b.p95, max: b.max, count: b.count });
    }
  }
  return [...byKey.values()];
}

/** Print the headline tables to the console and return the markdown + json. */
export function report(
  results: MilestoneResult[],
  meta: { cyclesPerMilestone: number; durationMs: number },
): { md: string; json: unknown } {
  const milestones = results.map((r) => r.milestone).sort((a, b) => a - b);
  const small = milestones[0]!;
  const large = milestones[milestones.length - 1]!;
  const rows = buildRows(results);

  // Growth factor on p95 between the smallest and largest milestone.
  const growth = (row: Row) => {
    const a = row.per.get(small)?.p95;
    const b = row.per.get(large)?.p95;
    if (!a || !b || a === 0) return undefined;
    return b / a;
  };

  // ---- console: comparison table ----
  const tableRows = rows
    .slice()
    .sort((x, y) => (y.per.get(large)?.p95 ?? 0) - (x.per.get(large)?.p95 ?? 0))
    .map((row) => {
      const a = row.per.get(small);
      const b = row.per.get(large);
      const g = growth(row);
      return {
        operation: row.op,
        [`p50@${small}`]: f1(a?.p50),
        [`p95@${small}`]: f1(a?.p95),
        [`p50@${large}`]: f1(b?.p50),
        [`p95@${large}`]: f1(b?.p95),
        [`max@${large}`]: f1(b?.max),
        'p95 growth': g ? `${g.toFixed(1)}×` : '—',
      };
    });

  // eslint-disable-next-line no-console
  console.log('\n=== Carbon perf: operation latency (ms) ===');
  // eslint-disable-next-line no-console
  console.table(tableRows);

  const ranked = rows
    .slice()
    .filter((r) => r.per.has(large))
    .sort((x, y) => (y.per.get(large)!.p95 ?? 0) - (x.per.get(large)!.p95 ?? 0))
    .slice(0, 8);

  // eslint-disable-next-line no-console
  console.log(`\n=== What takes longest at ${large} tasks (p95, ms) ===`);
  for (const r of ranked) {
    const g = growth(r);
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.op.padEnd(22)} ${f1(r.per.get(large)!.p95).padStart(8)}   (${
        g ? g.toFixed(1) + '× vs ' + small : 'n/a'
      })`,
    );
  }

  // eslint-disable-next-line no-console
  console.log('\n=== Scroll ===');
  for (const r of results) {
    const s = r.scroll;
    // eslint-disable-next-line no-console
    console.log(
      `  @${r.milestone}: frame p50 ${f1(s.p50)} p95 ${f1(s.p95)} max ${f1(s.max)} | jank>16.7ms ${
        s.jank17
      }/${s.frames}, >50ms ${s.jank50} | settle ${f1(s.settle)}ms`,
    );
  }

  // eslint-disable-next-line no-console
  console.log('\n=== Memory (after GC, on /all) ===');
  for (const r of results) {
    const m = r.memory;
    // eslint-disable-next-line no-console
    console.log(
      `  @${r.milestone}: JS heap ${f1(m.jsHeapMB)} MB | DOM nodes ${m.domNodes} | rows ${m.listRows}`,
    );
  }

  // ---- markdown ----
  const md = buildMarkdown(results, rows, { small, large, growth, meta });

  const json = {
    generatedAt: new Date().toISOString(),
    gitHash: gitHash(),
    durationMs: meta.durationMs,
    cyclesPerMilestone: meta.cyclesPerMilestone,
    milestones,
    results,
  };

  return { md, json };
}

function buildMarkdown(
  results: MilestoneResult[],
  rows: Row[],
  ctx: {
    small: number;
    large: number;
    growth: (r: Row) => number | undefined;
    meta: { cyclesPerMilestone: number; durationMs: number };
  },
): string {
  const { small, large, growth, meta } = ctx;
  const lines: string[] = [];
  lines.push(`# Carbon performance benchmark`);
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Commit: \`${gitHash()}\``);
  lines.push(`- Milestones: ${results.map((r) => r.milestone).join(', ')} tasks`);
  lines.push(`- Cycles per milestone: ${meta.cyclesPerMilestone}`);
  lines.push(`- Wall-clock: ${(meta.durationMs / 1000).toFixed(0)}s`);
  lines.push('');

  const ranked = rows
    .filter((r) => r.per.has(large))
    .sort((x, y) => (y.per.get(large)!.p95 ?? 0) - (x.per.get(large)!.p95 ?? 0));

  lines.push(`## Top 5 slowest operations at ${large} tasks (p95)`);
  lines.push('');
  lines.push('| Operation | p95 (ms) | Growth vs ' + small + ' |');
  lines.push('| --- | ---: | ---: |');
  for (const r of ranked.slice(0, 5)) {
    const g = growth(r);
    lines.push(`| \`${r.op}\` | ${f1(r.per.get(large)!.p95)} | ${g ? g.toFixed(1) + '×' : '—'} |`);
  }
  lines.push('');

  lines.push('## Operation latency (ms)');
  lines.push('');
  lines.push(
    `| Operation | p50@${small} | p95@${small} | p50@${large} | p95@${large} | max@${large} | p95 growth |`,
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of ranked) {
    const a = r.per.get(small);
    const b = r.per.get(large);
    const g = growth(r);
    lines.push(
      `| \`${r.op}\` | ${f1(a?.p50)} | ${f1(a?.p95)} | ${f1(b?.p50)} | ${f1(b?.p95)} | ${f1(
        b?.max,
      )} | ${g ? g.toFixed(1) + '×' : '—'} |`,
    );
  }
  lines.push('');

  lines.push('## Scroll');
  lines.push('');
  lines.push('| Tasks | frame p50 | frame p95 | frame max | jank >16.7ms | jank >50ms | settle (ms) |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    const s = r.scroll;
    lines.push(
      `| ${r.milestone} | ${f1(s.p50)} | ${f1(s.p95)} | ${f1(s.max)} | ${s.jank17}/${s.frames} | ${
        s.jank50
      } | ${f1(s.settle)} |`,
    );
  }
  lines.push('');

  lines.push('## Memory (after GC, on /all)');
  lines.push('');
  lines.push('| Tasks | JS heap (MB) | DOM nodes | rendered rows |');
  lines.push('| ---: | ---: | ---: | ---: |');
  for (const r of results) {
    const m = r.memory;
    lines.push(`| ${r.milestone} | ${f1(m.jsHeapMB)} | ${m.domNodes} | ${m.listRows} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Write the JSON + markdown report under perf/results and return their paths. */
export function writeReport(md: string, json: unknown): { mdPath: string; jsonPath: string } {
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const mdPath = path.join(dir, `${stamp}.md`);
  const jsonPath = path.join(dir, `${stamp}.json`);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  return { mdPath, jsonPath };
}
