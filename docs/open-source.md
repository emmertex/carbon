# Open Source Projects Used

Carbon is built on the work of the open-source community. This page lists every direct
library, tool, and project Carbon depends on to build and run, grouped by where it's used.
Thank you to all the maintainers and contributors behind these projects. 🙏

> This lists Carbon's **direct** dependencies. Each of these in turn stands on many more
> transitive dependencies — the full tree lives in `package-lock.json` and `Cargo.lock`.

## Runtime & language

- [TypeScript](https://www.typescriptlang.org/) — typed JavaScript, used across the whole codebase.
- [Node.js](https://nodejs.org/) — server runtime, including its built-in `node:sqlite` and
  `node:crypto` modules (so no native SQLite or `firebase-admin` dependency is needed).

## Web app (`@carbon/web`)

### UI & rendering
- [React](https://react.dev/) (`react`, `react-dom`) — UI framework.
- [React Router](https://reactrouter.com/) (`react-router-dom`) — client-side routing.
- [Zustand](https://github.com/pmndrs/zustand) — state management store.
- [Lucide](https://lucide.dev/) (`lucide-react`) — icon set.
- [Tailwind CSS](https://tailwindcss.com/) — utility-first styling.
- [tailwind-merge](https://github.com/dcastil/tailwind-merge) — conflict-free Tailwind class merging.
- [clsx](https://github.com/lukeed/clsx) — conditional className builder.
- [react-markdown](https://github.com/remarkjs/react-markdown) — Markdown rendering.
- [remark-gfm](https://github.com/remarkjs/remark-gfm) — GitHub-flavored Markdown support.

### Interaction & data
- [dnd kit](https://dndkit.com/) (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers`,
  `@dnd-kit/utilities`) — drag-and-drop.
- [TanStack Virtual](https://tanstack.com/virtual) (`@tanstack/react-virtual`) — list virtualization.
- [date-fns](https://date-fns.org/) — date utilities.
- [sql.js](https://github.com/sql-js/sql.js) — SQLite compiled to WebAssembly, the in-browser database.
- [localForage](https://github.com/localForage/localForage) — offline key/value storage.

### PWA & native bridges
- [Workbox](https://developer.chrome.com/docs/workbox) (`workbox-precaching`) — service-worker precaching.
- [Capacitor](https://capacitorjs.com/) (`@capacitor/core`, `@capacitor/geolocation`,
  `@capacitor/local-notifications`, `@capacitor/push-notifications`) — native runtime for the mobile app.
- [Tauri](https://tauri.app/) (`@tauri-apps/api`, `@tauri-apps/plugin-notification`) — native runtime
  for the desktop app.

### Web build tooling
- [Vite](https://vite.dev/) (`vite`, `@vitejs/plugin-react`) — dev server and bundler.
- [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) — PWA / service-worker generation.
- [@tailwindcss/vite](https://tailwindcss.com/docs/installation/using-vite) — Tailwind Vite plugin.
- [tsx](https://github.com/privatenumber/tsx) — TypeScript execution for tests and scripts.

## Server (`@carbon/server`)

- [Hono](https://hono.dev/) (`hono`, `@hono/node-server`) — HTTP framework and Node adapter.
- [Nodemailer](https://nodemailer.com/) — transactional email (sign-up, billing).
- [web-push](https://github.com/web-push-libs/web-push) — Web Push (VAPID) notifications.
- [esbuild](https://esbuild.github.io/) — server bundler.

## Core (`@carbon/core`)

- [uuid](https://github.com/uuidjs/uuid) — RFC-compliant unique identifiers.

## Desktop app (`@carbon/desktop`)

### Rust crates
- [Tauri](https://tauri.app/) (`tauri`, `tauri-build`, `tauri-plugin-notification`) — desktop shell.
- [serde](https://serde.rs/) (`serde`, `serde_json`) — Rust serialization.

### Tooling
- [@tauri-apps/cli](https://tauri.app/) — Tauri build/dev CLI.
- [cross-env](https://github.com/kentcdodds/cross-env) — cross-platform environment variables.

## Mobile app (`@carbon/mobile`)

- [Capacitor](https://capacitorjs.com/) (`@capacitor/android`, `@capacitor/core`,
  `@capacitor/cli`, `@capacitor/geolocation`, `@capacitor/local-notifications`,
  `@capacitor/push-notifications`) — Android app shell and native plugins.

## Repo-wide build & dev tooling

- [Turborepo](https://turbo.build/repo) (`turbo`) — monorepo task runner.
- [Playwright](https://playwright.dev/) (`@playwright/test`) — end-to-end and performance tests.
- [Prettier](https://prettier.io/) — code formatting.

---

*Carbon is developed by [Emmertex P/L](https://emmertex.com).*
