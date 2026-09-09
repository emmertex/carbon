#!/usr/bin/env bash
# Build the Carbon Capacitor Android app.
#
# Two distribution flavors (see app/build.gradle):
#   sideload  — full feature set incl. background GPS tracks. Debug/release.
#   playstore — Google Play variant: no background location. Release AAB/APK only.
#
# Toolchain notes (CachyOS / g1-cachy):
#   - System Java defaults to 26, which AGP rejects. We force Java 21
#     (Capacitor 8 needs JDK 21; 17 fails "invalid source release: 21").
#   - SDK lives at /opt/android-sdk (root-owned, read-only to the user), populated via AUR:
#       paru -S --needed android-sdk-platform-tools android-sdk-build-tools android-platform-35
#     compileSdk/targetSdk is 35 (Play Store requirement); build-tools is pinned to the
#     installed version in variables.gradle because AGP can't auto-install into the RO SDK.
#   - Because the SDK is read-only, Gradle can't write license-acceptance files itself.
#     Create them once (root): /opt/android-sdk/licenses/android-sdk-license with the
#     standard accepted SHA hashes, else builds fail with "license not accepted".
#   - android/local.properties (gitignored) points Gradle at the SDK.
#   - Push/FCM is wired via google-services.json + @capacitor/push-notifications;
#     the firebase-adminsdk service-account key is server-side only, NOT in the app.
#
# Usage:
#   ./build-android.sh              # sideload debug APK (default)
#   ./build-android.sh release      # sideload signed APK + AAB (GitHub release)
#   ./build-android.sh playstore    # Google Play signed AAB + APK (local keystore.properties
#                                   #   = Play upload key; web built with VITE_PLAY_STORE=1)
#   ./build-android.sh install      # sideload debug build + adb install to attached device
set -euo pipefail

export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
# Capacitor 8 compiles against Java 21 (17 fails with "invalid source release: 21").
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
ADB="$ANDROID_HOME/platform-tools/adb"

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
OUT_BASE="$ANDROID_DIR/app/build/outputs"

MODE="${1:-debug}"

# Ensure local.properties exists (gitignored, machine-specific).
if [[ ! -f "$ANDROID_DIR/local.properties" ]]; then
  echo "sdk.dir=$ANDROID_HOME" > "$ANDROID_DIR/local.properties"
  echo "==> wrote $ANDROID_DIR/local.properties"
fi

# Mode -> (flavor, build type, web env). AGP qualifies every task/output with the
# flavor: assembleSideloadRelease / bundlePlaystoreRelease, etc.
case "$MODE" in
  debug|install) FLAVOR="sideload"; BT="Debug";   WEB_ENV=() ;;
  release)       FLAVOR="sideload"; BT="Release"; WEB_ENV=() ;;
  playstore)     FLAVOR="playstore"; BT="Release"; WEB_ENV=(VITE_PLAY_STORE=1) ;;
  *)
    echo "Unknown mode: $MODE (use: debug | release | playstore | install)" >&2
    exit 1
    ;;
esac

VARIANT="${FLAVOR}${BT}"                           # e.g. sideloadRelease / playstoreRelease
BTL="$(echo "$BT" | tr '[:upper:]' '[:lower:]')"   # release
APK_DIR="$OUT_BASE/apk/$VARIANT"
AAB_FILE="$OUT_BASE/bundle/$VARIANT/app-${FLAVOR}-${BTL}.aab"

echo "==> Building web bundle (@carbon/web)${WEB_ENV:+ with ${WEB_ENV[*]}}"
env "${WEB_ENV[@]}" npm run --prefix "$MOBILE_DIR" build:web

echo "==> Capacitor sync (copies dist + plugins into android/)"
( cd "$MOBILE_DIR" && npx cap sync android )

echo "==> Gradle assemble$VARIANT + bundle$VARIANT (Java 21)"
( cd "$ANDROID_DIR" && ./gradlew "assemble$VARIANT" "bundle$VARIANT" --no-daemon )

echo "==> Artifacts:"
find "$APK_DIR" -name '*.apk' 2>/dev/null || true
[[ -f "$AAB_FILE" ]] && echo "$AAB_FILE"

if [[ "$MODE" == "install" ]]; then
  APK="$(ls -t "$APK_DIR"/*.apk 2>/dev/null | head -n1 || true)"
  if [[ -n "$APK" ]]; then
    echo "==> adb install -r $APK"
    "$ADB" install -r "$APK"
  fi
fi

echo "==> Done."
