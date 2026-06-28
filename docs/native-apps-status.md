# Native apps — status & known issues (WIP checkpoint)

_Last updated: 2026-06-24. Branch merged to `master`. See `docs/native-apps.md` for
the full build/setup guide._

This is a **decent WIP state**: desktop and Android both build and run from the shared
`apps/web` build, with no UI fork. Further work is intentionally paused here so that
**multi-tenant** can be designed first (it may reshape parts of this — see below).

## What works (tested)

| Target | State | Notes |
|---|---|---|
| Desktop (Tauri, Linux) | ✅ builds | `.deb` + `.rpm` produced on g1-cachy; raw `carbon-desktop` binary runs. AppImage needs FUSE2 + network. |
| Android (Capacitor) | ✅ builds & runs on device | Debug APK installed and launched on Andrew's phone. App loads, UI works, syncs. |
| Shared web build | ✅ | Plugins bundled as a lazy chunk; browser PWA unaffected. |
| iOS | ⛔ not attempted | Code-ready via Capacitor; needs Mac + Xcode + $99 Apple account. |

Android toolchain recipe that worked (CachyOS): SDK at `/opt/android-sdk` via AUR
(`android-sdk-platform-tools`, `android-sdk-build-tools-34`, `android-platform-34`),
`JAVA_HOME=/usr/lib/jvm/java-17-openjdk` (system default JDK 26 is rejected by AGP
8.2.1). Helper: `apps/mobile/build-android.sh` (`debug|release|install`).

## Known issues

### 1. Android app icon is wrong (cosmetic)
The launcher icon is still the **default Capacitor template** icon. We only generated
icons for the Tauri desktop project; the Android `mipmap-*/ic_launcher*.png` were never
replaced.

**Fix (next session):** generate a 1024×1024 square source (current `CarbonIcon.png` is
807×807 — upscale or re-export), then:
```fish
npm i -D @capacitor/assets -w @carbon/mobile
npx capacitor-assets generate --android --assetPath ../../assets   # icon.png + splash.png
npm run -w @carbon/mobile sync
```
Commit the regenerated `mipmap-*` and `drawable*` resources.

### 2. Push subscribe → "Failed to register (404)"
On Android the app uses the **FCM** notification provider, which POSTs the device token
to `POST /api/push/fcm`. A **404** means the server it hit doesn't have that route — i.e.
it is running an **older server build from before the Phase-0 push changes**. The route
exists in committed code (`apps/server/src/index.ts` `/push/fcm`).

**Fix (next session):** rebuild + redeploy `apps/server` (the Docker image / container the
phone syncs to). Then to actually *deliver* pushes, set `FCM_SERVICE_ACCOUNT_FILE` on the
server to the Firebase **adminsdk** service-account key (server-side only — never in the
APK). Until that env is set the sender is inert (Web Push still works for browsers).

> Also note: the Android WebView serves from `https://localhost`, so the in-app sync
> server URL must be **https** (mixed-content blocks plain-http LAN servers).

## How multi-tenant may impact this design

Carbon today is multi-*user* on a single self-hosted instance. True multi-*tenant*
(isolated orgs/families on one server) would intersect the native work here:

- **Push routing** — `push_subscriptions` and `fcm_tokens` key on `user_id`; delivery
  fans out to task owner + assignees. Tenant isolation must scope token lookup/delivery
  so a tenant never receives another's notifications.
- **In-app server URL** — the single "Sync server" field assumes one endpoint. Multi-
  tenant may need tenant selection/routing (subdomain, header, or login-derived).
- **CORS allowlist** (`CORS_ORIGINS`) — may need to be per-tenant if tenants get
  distinct origins.
- **Single FCM project** — one Firebase project (carbon-32c42) currently serves all
  devices; confirm that's acceptable across tenants, or partition by tenant.

Recommendation: design multi-tenant first, then revisit push-token scoping and the
server-URL/login flow in the shells before building Phase 3 (CI release matrix).

## Not yet done

- Android app icon + splash (issue 1).
- Server redeploy + `FCM_SERVICE_ACCOUNT_FILE` to verify a closed-app push (issue 2).
- Signed release APK (keystore + `signingConfig`) for distribution.
- Tauri Windows `.msi` / macOS `.dmg` (Phase 3 GitHub Actions matrix).
- Confirm desktop window/UI on a real display (only the binary was build-verified).
