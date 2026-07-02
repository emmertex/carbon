# Carbon functional E2E tests

Playwright tests that drive the **real web UI** against a **live sync server** on
`localhost:3042` + `localhost:3069`. Each run uses a throwaway server database
(`e2e/.tmp/`) and a fresh client (IndexedDB + localStorage cleared per test).

## Run locally

```bash
npm ci
npm run e2e:install   # once — Chromium for Playwright
npm run e2e
```

The config starts both `@carbon/server` and `@carbon/web` automatically. Reuses
already-running dev servers when not in CI (`reuseExistingServer`).

## Test credentials

The server boots with `AUTH_USERS=alice:<sha256(e2e-test-pass)>` (see
`e2e/playwright.config.ts`). Sign-in flows in specs use username `alice` and
password `e2e-test-pass`.

## Layout

| Path | Role |
|------|------|
| `playwright.config.ts` | Dual `webServer`, greenfield data dir |
| `global-setup.ts` | Wipes `e2e/.tmp/` before each run |
| `fixtures/client.ts` | Fresh browser storage per test |
| `helpers/` | API helpers, keyboard primitives, app wait |
| `specs/` | Tier 1–5 functional specs |

## Tiers

1. **local-core** — boot, quick-add, complete, views, undo, appearance
2. **sync-auth** — sign-in, sync push/pull, API tokens
3. **organization** — tags, flagged, focus mode, review/time views
4. **backup** — export → import round-trip (`carbon-backup` v1)
5. **collaboration** — comments, agent API, admin user creation
6. **scheduling** — due today, defer, daily recurrence respawn, review workflow
7. **multi-user** — two browser contexts: share/assign → sync → comment back
   (single-server baseline for the future federation cross-server spec)

## Gotchas

- Client persistence (sql.js → IndexedDB) is **debounced**; a bare `page.goto()`
  after a mutation or sync reloads the page and loses unflushed writes. Use
  `gotoFlushed()` / `syncNow()` from `helpers/scenario.ts` (they flush first),
  or call `flushClientDb()` explicitly.
- The seeded `carbon.ui` prefs set `complexityChosen` **and** `welcomed` — both
  onboarding overlays block clicks at `z-[60]` otherwise.
- `window.__carbonE2e.inspect(sql)` (dev-gated) runs read-only SQL against the
  live client DB for debugging/assertions.

## Perf benchmarks

Keyboard performance benchmarks remain in [`../perf/`](../perf/) and are **not**
part of this suite. CI runs `npm run perf` on `main` only; PRs run `npm run e2e`.

## OPFS (deferred)

Client persistence still uses **sql.js + localforage** (`apps/web/src/lib/db.ts`).
Migrating to official `@sqlite.org/sqlite-wasm` with OPFS would improve persist
performance at scale but is out of scope here — E2E isolation uses Playwright
storage wipes instead. Track as a follow-up (`feat/opfs-persistence`).
