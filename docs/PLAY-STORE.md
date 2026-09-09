# Google Play Store launch

Everything needed to publish Carbon on the Play Store. The **internet side**
(public repo, GitHub Releases, landing page, hosted server, privacy policy) is
already live — see [`RELEASING.md`](RELEASING.md) and [`native-apps.md`](native-apps.md).
This doc covers only the Play Store path, which is deliberately separate because
Google Play has its own signing, review, and policy requirements.

> **Account note:** a *personal* Play Console account created after 13 Nov 2023
> cannot publish straight to production — it must pass the **20-tester / 14-day
> closed-testing** requirement first (see [Closed testing](#closed-testing-20-testers--14-days)).

---

## 1. The Play variant (`playstore` flavor)

Carbon ships in two Android flavors (see `apps/mobile/android/app/build.gradle`):

| Flavor | Background GPS tracks | Distribution | Signing key |
|---|---|---|---|
| `sideload` | ✅ full (foreground service) | GitHub Releases | dedicated CI keystore |
| `playstore` | ❌ omitted | Google Play | Play upload key (`keystore.properties`) |

Google Play restricts `ACCESS_BACKGROUND_LOCATION` to a short approved-use list
that does **not** include activity/trip tracking. Rather than fight a likely
rejection, the Play variant drops it. The `src/playstore/AndroidManifest.xml`
overlay uses `tools:node="remove"` to strip `ACCESS_BACKGROUND_LOCATION`,
`FOREGROUND_SERVICE_LOCATION`, and the `@capgo` foreground service from the
merged manifest. The web bundle is built with `VITE_PLAY_STORE=1` so the
"Record GPS while time-tracking" toggle is hidden and the recorder never starts.

**What still works in the Play build:** foreground geofencing + location
reminders (coarse/fine location, app open), push, local notifications, exact
alarms — everything except background GPS tracks on time sessions.

---

## 2. Build the signed Play AAB

The Play upload artifact is a signed **AAB** (Android App Bundle), built locally
with the Play upload key in `apps/mobile/android/keystore.properties`
(`carbon-release-key.jks`, alias `carbon`).

```fish
# Produces apps/mobile/android/app/build/outputs/bundle/playstoreRelease/app-playstore-release.aab
./apps/mobile/build-android.sh playstore

# …or via the all-in-one collector, which also copies it to release/:
./build-all.sh playstore
# -> release/Carbon_<version>_playstore_android.aab
```

`build-all.sh playstore` also builds the desktop bundles; to build only the
Android Play variant, use `build-android.sh playstore` directly.

> First Play upload: enroll in **Play App Signing** when Play Console prompts
> you. Upload your `.aab`; Google extracts and keeps the **app signing key** and
> re-signs store deliveries with it. Your `keystore.properties` key remains the
> **upload key** — you keep using it for every subsequent upload. Keep the `.jks`
> and its passwords in a password manager; losing the upload key means requesting
> a key upgrade from Play Support.

### Coordinate the public release.yml (sideload flavor) — one-time

Adding the flavor dimension means AGP no longer produces an un-flavored
`release` variant, so the **public** repo's `emmertex/carbon/.github/workflows/release.yml`
(which builds the sideload APK for GitHub Releases) must call the flavor-qualified
tasks. In that file, change:

```diff
- ./gradlew assembleRelease bundleRelease
+ ./gradlew assembleSideloadRelease bundleSideloadRelease
```

(If it calls `apps/mobile/build-android.sh release`, no change is needed — that
script already maps `release` → the sideload flavor.) The dev repo's own mirror
workflow is unaffected.

---

## 3. Store listing

### Title / branding
- **App name:** `Carbon` (this is `appName` in `capacitor.config.ts`).
- **Store title (≤30):** `Carbon — Task Manager & Notes`
- **Developer name:** `Emmertex` (matches the public repo / landing page).

### Short description (≤80 chars)
```
Offline-first task manager: projects, notes, reminders, time tracking. Self-host.
```

### Full description (≤4000 chars)
```
Carbon is an offline-first task manager that's simple on the surface and powerful
underneath. It works fully offline — no account, no internet — and syncs to a
server you control whenever it's reachable. No SaaS, no ads, no tracking.

YOUR DATA STAYS YOURS
Everything lives on your device by default. Turn on sync only if you want it, and
point it at a server you self-host or trust. Export your entire database any time.

CAPTURE & ORGANIZE
• Quick capture with inline #tags, @assignees and !priority
• Projects, nested tasks, notes (with images), and recipe notes
• Due / defer / flag / priority, recurrence, and a Review perspective
• Today, Inbox, Flagged, and custom saved perspectives
• Drag to reorder or nest; focus mode drills into a task as a container

REMINDERS & LOCATION
• Push reminders for due and deferred tasks (needs a sync server)
• Local, on-device notifications — no server required
• Location reminders that fire while the app is open
• Home Assistant integration for background geofencing and automations

TIME TRACKING
• Start timers on projects and tasks; pause, resume, and park
• Merge, split, and segment-edit your tracked time afterwards
• Time notes, charts, and a timeline view

AND MORE
• Two-way CalDAV sync and iCal feed subscriptions
• A token-scoped REST API for Home Assistant and scripts
• Optional AI agents / natural-language commands
• Themes, keyboard shortcuts, and a Recently Deleted recovery view

Self-host with Docker, or use Carbon local-only. Your tasks, your server, your rules.
```

### Category & tags
- **App type / category:** App → **Productivity**
- **Tags:** `Task`, `To-Do List`, `Productivity`, `Notes`, `GTD`

### Contact details
- **Privacy policy URL:** `https://carbon.etx.sx/privacy` (already live — `PrivacyView`,
  mirrors `docs/privacy-policy.md`).
- **Support email / contact:** `email@emmertex.com`
- **Marketing/website:** `https://carbon.etx.sx`

---

## 4. Store listing assets

| Asset | Size (px) | Source |
|---|---|---|
| App icon | 512 × 512, 32-bit PNG (no alpha) | derive from `CarbonIcon.png` / `carbonLogo.png` (`gen-icons.sh`) |
| Feature graphic | 1024 × 500 PNG/JPG | create (wordmark + tagline on brand background) |
| Phone screenshots | 2–8, min 320 px, max 3840 px on the long side; 16:9 or 9:16 | capture on a phone/emulator (see below) |

### Screenshots to capture (suggested set)
Capture at 1080 × 1920 (or a real device). Recommended screens:

1. **Today** perspective with a few tasks, one flagged, due dates visible.
2. **A project** expanded, showing nested tasks + drag handles.
3. **A note** in fullscreen (with an image) — shows the notes capability.
4. **Time tracking** — the Time view timeline/chart, or the timer bar running.
5. **Quick add** bar with `#tag @user !priority` tokens typed.
6. **Settings → Sync** (or the offline/local-only onboarding) — reinforces "your data, your server".
7. (Optional) **Review** perspective or **Flagged**.

> The landing page uses real application captures in `apps/web/public/shots/landing-*`.
> Store submissions need screenshots from the build being submitted, at the required
> store dimensions. Browser-width examples do not establish native device support.

---

## 5. Data safety form

Answer based on the **Play variant's** actual behaviour (no background GPS tracks;
no analytics/ads/crash-reporting).

**Does your app collect or share any of the required user data types?** → **Yes**
(it collects account + optional location data when sync is used).

| Category | Collected? | Detail |
|---|---|---|
| **Personal info — Email address** | ✅ Yes | Account management, security (2FA), sign-in. Only when a sync server is used. |
| **Personal info — Name** (user/display) | ✅ Yes | Username + optional display name within a workspace. Server only. |
| **Location — Approximate** | ✅ Yes | Foreground geofencing / location reminders (app open). Sync server only; no history kept. |
| **Location — Precise** | ✅ Yes | Same as above (fine location). |
| Photos, videos, audio, files, messages | ❌ No | (Attachments exist but are user content, not "collected" data; not transmitted except via the user's own sync.) |
| Financial, health, fitness | ❌ No | |
| Emails / SMS / notifications | ❌ No | |
| Web browsing / search history | ❌ No | |
| App activity / performance / crash) | ❌ No | No telemetry, analytics, or crash reporting of any kind. |
| Device/other IDs | ❌ No | |

For each "Yes" row, also set:
- **Shared?** → No (data goes only to the sync server the user configures, not to third parties). *Exception:* push delivery transits Firebase Cloud Messaging (standard infrastructure) — declare under Push if asked.
- **Encrypted in transit?** → **Yes** (all client⇄server traffic is TLS/HTTPS).
- **Can users request data deletion?** → **Yes** — in-app Settings → Data backup export, and account deletion at `https://carbon.etx.sx/delete-account`.
- **Is data collection optional / required?** → The app works fully offline with **no** collection; email/location are only collected when the user opts into a sync server / location feature.

---

## 6. Content rating (IARC questionnaire)

Carbon is a productivity app with no age-restricted content. Answer:

| Question | Answer |
|---|---|
| Is the app directed at / does it feature content for children? | No |
| Cartoon / fantasy / realistic violence | No |
| Sexual content / nudity | No |
| Profanity / crude humour | No |
| Controlled substances (drugs, alcohol, tobacco) | No |
| Gambling | No |
| Fear / horror | No |
| User-generated content / unrestricted internet / social features | The app has no public social feed; sync is private to a workspace. If asked about *unrestricted web access*, answer No. |
| In-app purchases / paid digital goods | No (hosted sync billing, if any, is out-of-app; the Play build has no IAP) |

**Expected rating:** Everyone (E).

---

## 7. Target audience & app content

- **Target audience:** 13+ (general productivity; not directed at children).
- **News app:** No.
- **Government apps:** No.
- **Data deletion** (required because accounts can be created): declare that users
  can delete their account/data — provide `https://carbon.etx.sx/delete-account`
  and Settings → Data backup. (Already implemented; Play requires the policy + a
  working deletion path, both present.)
- **Financial features:** None in the Play build (no IAP, no lending/loyalty).

---

## 8. Closed testing (20 testers / 14 days)

A personal account created after 13 Nov 2023 **must** run a closed test before
any production release:

1. **Create a closed testing track** in Play Console → Closed testing →
   *Create release* → choose the Play AAB built in [§2](#2-build-the-signed-play-aab).
2. **Add ≥ 20 testers** to a Google Group (or opt-in URL list). Testers opt in
   via the opt-in URL, then install from Play.
   - You can reuse the same group across releases.
   - Testers don't have to be active daily, but the track must show the release
     as live to them for the period.
3. **Keep the release live for 14 consecutive days** with the testers enrolled.
   The console's "Eligibility for production" status will confirm when the
   requirement is satisfied.
4. After 14 days, you can promote the build (or a newer one) to **Production**.

Tip: the same AAB you intend to ship to production can be the closed-test build —
you don't need a separate artifact, just the testing period to elapse.

---

## 9. Submission checklist

- [ ] `keystore.properties` present (Play upload key) and `google-services.json`
      placed (for FCM push) at `apps/mobile/android/app/google-services.json`.
- [ ] FCM service account key set server-side (`FCM_SERVICE_ACCOUNT_FILE`) on the
      server the app will point at.
- [ ] Built `app-playstore-release.aab` via `build-android.sh playstore`.
- [ ] Public `release.yml` updated to `assembleSideloadRelease bundleSideloadRelease`.
- [ ] Store listing filled (title, short/full description, category, tags, icon,
      feature graphic, ≥2 screenshots).
- [ ] Data safety form completed (matches [§5](#5-data-safety-form)).
- [ ] Content rating (IARC) completed → Everyone.
- [ ] Target audience 13+; data-deletion declared.
- [ ] Privacy policy URL `https://carbon.etx.sx/privacy` live (it is).
- [ ] App signed and uploaded; enrolled in Play App Signing.
- [ ] Closed testing live with 20 testers for 14 days, then promote to Production.

---

*See [`privacy-policy.md`](privacy-policy.md) and [`data-security.md`](data-security.md)
for the data model behind the Data safety answers, and [`RELEASING.md`](RELEASING.md)
for the GitHub-Release / desktop pipeline.*
