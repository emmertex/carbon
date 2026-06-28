# Carbon performance benchmark

A keyboard-driven, browser-based benchmark that measures how Carbon's web UI
behaves as the task list scales. It grows the in-browser list to **1,000** then
**10,000** tasks and drives real keyboard interactions — switch screens, add
tasks, complete tasks, scroll — while tracing which internal operations get slow.

It honours the intended workload shape: ~2 UI actions per task, adding 2 tasks for
every 1 completed.

## Run it

```bash
# one-time: install the browser
npm run perf:install

# run the benchmark (auto-starts the web app with the service worker disabled)
npm run perf
```

Results are written to `perf/results/<timestamp>.{md,json}` and a summary table is
printed to the console.

### Options (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `PERF_MILESTONES` | `1000,10000` | list sizes to benchmark |
| `PERF_CYCLES` | `15` | churn cycles per milestone (each = 2 adds + 1 complete) |

```bash
PERF_MILESTONES=500,2000 PERF_CYCLES=10 npm run perf
```

## How it works

- **Instrumentation** (`apps/web/src/lib/perf.ts`) records timing samples — each
  tagged with the current list size — onto `window.__carbonPerf`. It is inert
  unless `localStorage['carbon.perf']` is set (the harness sets it before boot),
  so normal use pays nothing. Hook points: `mutate.ts` (DB op), `useQuery.ts`
  (the big list query), `db.ts` (`export`/IndexedDB persist), and a React
  `Profiler` around the list render.
- **Fast-forward seeding** (`apps/web/src/lib/devSeed.ts`) bulk-inserts tasks via
  `window.__carbonSeed(n)` to reach a milestone in seconds. Only the *measured*
  add/complete/scroll/switch actions are real keystrokes — seeding just sets the
  size.
- **Driver** (`perf/`) is Playwright. `scenario.ts` has the keyboard primitives,
  `workload.ts` the milestone loop, `report.ts` the output.

## Reading the report

- **Operation latency** table — p50/p95 at each milestone, with the 1k→10k p95
  growth factor. Superlinear growth flags the scaling pain.
- **What takes longest** — operations ranked by p95 at the largest size.
- **Scroll** — frame-time p50/p95/max, jank-frame counts, and time-to-settle.

Key buckets: `query:listview.roots` (SQL-prefiltered list query — the per-mutation
floor), `render:list` (windowed render — only visible rows), `persist:export`
(whole-DB serialization), and the `interaction:*` end-to-end latencies.

The list is virtualized (`VirtualTaskList`) and the query is SQL-prefiltered
(`queryRoots` → core `queryItems`), so render/heap/DOM scale with what's *on
screen*, not workspace size. The remaining size-dependent cost is the unfiltered
`/all` view, whose query still builds the full ordered array each mutation
(~150 ms p50 at 10k).
