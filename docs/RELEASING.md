# Releasing (CI build + auto-update pipeline)

How a version tag turns into published, auto-updating builds. See
[`native-apps.md`](native-apps.md) for local dev builds — this is the automated path.

## Pipeline

```
carbon_dev (private, branch master)          carbon (public, branch main)
─────────────────────────────────────        ──────────────────────────────
git tag v0.6.0 && git push --tags
        │
        ▼
.github/workflows/release-mirror.yml
  - verifies the tag is on master
  - squashes the tagged tree into one
    commit, pushes it + the tag to
    carbon ─────────────────────────────▶  .github/workflows/release.yml
                                              - desktop (ubuntu + windows matrix)
                                                via tauri-action: builds, creates
                                                the GitHub Release, signs updater
                                                artifacts, publishes latest.json
                                              - android: builds + signs the APK
                                                with its own dedicated keystore,
                                                attaches it to the same release
```

Only a **squashed snapshot** is mirrored, not carbon_dev's full commit history —
`carbon` gains one clean commit per release; the private dev history (WIP commits,
branch churn) never becomes public.

### What gets stripped from the mirror

The snapshot is produced with `git archive`, which:

- exports only **tracked** files, so untracked/gitignored cruft (`node_modules`,
  `__pycache__`, `*.pyc`, local `release/` artifacts) can never leak; and
- honours `export-ignore` in [`.gitattributes`](../.gitattributes), which strips
  `docs/internal/` (private planning/review docs) and this repo's own `.github/`
  (dev CI + the mirror workflow itself) from the published tree.

> **Gotcha:** `git archive` reads `.gitattributes` from the **tagged commit**, not
> the working tree. If you tag a commit that predates the `.gitattributes` entries,
> the strip rules won't apply and internal docs would be published. Always tag a
> commit that includes the current `.gitattributes`.

The `carbon`-side `release.yml` lives **natively in the public repo**, not here
(this repo can't push to `carbon`'s Actions), and the mirror **must not clobber it**.
The wipe step preserves the public repo's own `.git` **and `.github/`**, so `carbon`'s
release workflow (and any issue templates / FUNDING config) survive untouched while
the rest of the tree is replaced. `carbon`'s `.github/workflows/release.yml` is the
source of truth — edit it directly in your local `carbon` (public mirror) checkout.

### Release notes (single-sourced from CHANGELOG.md)

Add a section to [`CHANGELOG.md`](../CHANGELOG.md) whose heading's first token is the
tag, e.g. `## v0.6.0 — 2026-08-01`. The pipeline uses it verbatim in two places:

- the **mirror commit message** on `carbon` (extracted in `release-mirror.yml`), and
- the **GitHub Release body** (extracted in `carbon`'s `release.yml` `prepare` job).

If no matching section exists, both fall back to "No changelog entry for `<tag>`".
Because notes come from the mirrored tree, `CHANGELOG.md` must be committed **before**
you tag (same rule as `.gitattributes`).

> The `carbon`-side `release.yml` also has a `workflow_dispatch` with a `tag` input,
> so you can (re)build an already-pushed tag whose build never ran — Actions tab →
> "Build and release" → Run workflow → enter the tag.

Both workflows are guarded to their own repo (`github.repository == 'emmertex/carbon_dev'`
/ `'emmertex/carbon'`) so a fork or a stray branch can never trigger a release build.

## What auto-updates, and how

| Target | Update mechanism |
|---|---|
| Web / PWA | Already automatic — Workbox `registerType: 'autoUpdate'` (`apps/web/vite.config.ts`) pulls new assets in the background; no release pipeline involvement. |
| Desktop (Tauri) | Real silent-download, confirmed-install-and-relaunch via `tauri-plugin-updater`, checking `latest.json` published alongside each GitHub Release. See `apps/web/src/lib/tauriUpdater.ts`. |
| Android (sideloaded APK) | Link-out only — Android has no OS mechanism for a sideloaded app to silently replace itself. `apps/web/src/lib/updateCheck.ts` checks GitHub Releases and links straight to the new `.apk`. |
| Android (Play Store) | Handled entirely by Google Play — out of scope here. |
| iOS | Not built in this repo; App Store distribution (if ever added) updates via the App Store, same as Play Store. |

## One-time setup (manual — do not automate blindly)

These touch signing keys and repo credentials, so they're deliberately manual steps
for a human to run and store, not something to script unattended.

### 1. Tauri updater signing keypair

Generates the keypair that signs desktop update artifacts; the **public** half is
already baked into `apps/desktop/src-tauri/tauri.conf.json` (`updater.pubkey`) —
this step is already done for the current keypair. Only needed again if the
keypair is ever rotated.

```fish
npx @tauri-apps/cli signer generate -w ~/.tauri/carbon-updater.key
```

- Replace the `"pubkey"` value in `apps/desktop/src-tauri/tauri.conf.json`
  (`updater.pubkey`) with the printed public key.
- Add as **secrets in `carbon`** (the repo that actually runs the build):
  `TAURI_SIGNING_PRIVATE_KEY` (contents of the private key file) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### 2. Dedicated Android "sideload/auto-update" keystore

**Deliberately separate from your existing Play Store upload key.** Android refuses
to install an update whose signature doesn't match the previously-installed one, so
each distribution channel (GitHub-released APK vs. Play Store) needs its own stable
key — they never need to match each other, and keeping them apart limits the blast
radius of either leaking. Don't reuse or upload your Play Store keystore to CI.

```fish
keytool -genkeypair -v -keystore carbon-github-release.jks \
  -alias carbon-github -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 carbon-github-release.jks > carbon-github-release.jks.b64
```

Add as **secrets in `carbon`**: `CARBON_ANDROID_KEYSTORE_B64` (the base64 file
contents), `CARBON_ANDROID_KEYSTORE_PASSWORD`, `CARBON_ANDROID_KEY_ALIAS`,
`CARBON_ANDROID_KEY_PASSWORD`. `apps/mobile/android/app/build.gradle` picks these
up via `CARBON_ANDROID_KEYSTORE_PATH`/`_PASSWORD`/`_ALIAS`/`_KEY_PASSWORD` env vars
when present, falling back to your local `keystore.properties` (Play Store key)
otherwise — so local/Play Store builds are untouched.

Keep the `.jks` file and its passwords somewhere durable outside CI too (e.g. your
password manager) — losing it means every future GitHub-released APK becomes a dead
end for existing sideload installs (they'd need to uninstall/reinstall instead of
updating in place).

### 3. Cross-repo mirror token

The private → public mirror push needs a token with write access to `carbon` only.

- GitHub → Settings → Developer settings → **Fine-grained personal access token**.
- Resource owner: `emmertex`. Repository access: **only** `carbon`. Permissions:
  **Contents: Read and write**. Nothing else.
- Add as a secret **in `carbon_dev`** (this repo): `CARBON_PUBLIC_REPO_TOKEN`.

## Cutting a release

```fish
# bump version in the root package.json first, commit it on master, then:
git tag v0.6.0
git push origin v0.6.0
```

That's it — the mirror workflow picks up the tag, and `carbon`'s workflow does the rest.
