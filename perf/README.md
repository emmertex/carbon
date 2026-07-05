# Carbon performance benchmark

A keyboard-driven, browser-based benchmark that measures how Carbon's web UI
behaves as the task list scales. It grows the in-browser list to each milestone
and drives real keyboard interactions — switch screens, add tasks, complete tasks,
scroll, and tour the heavier views (Forecast, a project drill-down) — while tracing
which internal operations get slow.

It honours the intended workload shape: ~2 UI actions per task, adding 2 tasks for
every 1 completed.

The seed is **representative, not flat**: folders, projects (some sequential),
nested sub-tasks, hierarchical tags (a couple on-hold), due/defer dates, flags, and
a handful of saved perspectives. A flat list of bare top-level tasks hides the very
costs a real workspace pays — ancestor walks, per-item tag/blocked/assignee
enrichment, and the sidebar's per-project / per-perspective recompute — so a flat
seed makes the app look far faster under benchmark than it feels in use.

## Run it

```bash
# one-time: install the browser
npm run perf:install

# run the benchmark (auto-starts the web app with the service worker disabled)
npm run perf
```

Web and the Android (Capacitor) build scale identically — Android is just a
constant-factor slower CPU. So the *shape* of the curve reproduces on desktop, and
CPU throttling makes the absolute numbers phone-like. To reproduce how it feels on
a mid-range phone:

```bash
PERF_MILESTONES=200,400,600 PERF_CYCLES=8 PERF_CPU_THROTTLE=4 npm run perf
```

Results are written to `perf/results/<timestamp>.{md,json}` and a summary table is
printed to the console. The report header records the CPU throttle and seed shape.

### Options (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `PERF_MILESTONES` | `1000,10000` | list sizes to benchmark |
| `PERF_CYCLES` | `15` | churn cycles per milestone (each = 2 adds + 1 complete) |
| `PERF_CPU_THROTTLE` | `1` | CDP CPU throttle multiplier (`1` = desktop; `4`–`6` ≈ a phone) |

```bash
PERF_MILESTONES=500,2000 PERF_CYCLES=10 PERF_CPU_THROTTLE=4 npm run perf
```

## How it works

- **Instrumentation** (`apps/web/src/lib/perf.ts`) records timing samples — each
  tagged with the current list size — onto `window.__carbonPerf`. It is inert
  unless `localStorage['carbon.perf']` is set (the harness sets it before boot),
  so normal use pays nothing. Hook points: `mutate.ts` (DB op), `useQuery.ts`
  (labelled queries — the list roots, Forecast, and a project container), `db.ts`
  (`export`/IndexedDB persist), and a React `Profiler` around the list render.
- **Representative seeding** (`apps/web/src/lib/devSeed.ts`) bulk-inserts a whole
  workspace (folders / projects / nested sub-tasks / tags / due dates / perspectives)
  via `window.__carbonSeed(n)` to reach a milestone in seconds, from a fixed-seed
  PRNG so runs are comparable. `window.__carbonReset()` wipes it between milestones.
  Only the *measured* add/complete/scroll/switch/tour actions are real keystrokes —
  seeding just sets the size.
- **Warmup** — a small discarded milestone runs first so the first *measured*
  milestone isn't penalised by one-time JIT / WASM / IndexedDB / lazy-module cost
  (which would otherwise make small milestones look slower than large ones).
- **Driver** (`perf/`) is Playwright. `scenario.ts` has the keyboard primitives
  (plus `openLargestContainer`, which clicks into the biggest project), `workload.ts`
  the milestone loop + view tour, `report.ts` the output. Confirm dialogs are
  auto-accepted so completing a parent with open sub-tasks (which cascades) doesn't
  stall the run.

## Reading the report

- **Operation latency** table — p50/p95 at each milestone, with the small→large p95
  growth factor. Superlinear growth flags the scaling pain.
- **What takes longest** — operations ranked by p95 at the largest size.
- **Scroll** — frame-time p50/p95/max, jank-frame counts, and time-to-settle.
  (`scroll:settle` is one sample per milestone and noisy; the frame-time
  distribution is the reliable smoothness signal.)

Key buckets: `query:listview.roots` (SQL-prefiltered list query — the per-mutation
floor, cached per revision), `query:forecast.data` / `query:container.data` (the
full-enrich views), `render:list` (windowed render — only visible rows),
`persist:export` / `persist:idb` (whole-DB serialization + IndexedDB write, both
debounced/background — `persist:idb` now runs off the main thread via a dedicated
Worker), and the `interaction:*` end-to-end latencies (`add`,
`complete`, `switch`, `openContainer`).

The list is virtualized (`VirtualTaskList`) and the query is SQL-prefiltered
(`queryRoots` → core `queryItems`), so render/heap/DOM scale with what's *on
screen*, not workspace size. Per-row enrichment is batched (`enrichItems` →
core `getItemTagsBatch` etc.) and workspace-level inputs (tag colours, on-hold
tags) are memoised per revision, so a mutation renders one set of reads rather than
one per row.
