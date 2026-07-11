#!/usr/bin/env bash
# Build the Carbon Capacitor Android app.
#
# Toolchain notes (CachyOS / g1-cachy):
#   - System Java defaults to 26, which AGP 8.2.1 rejects. We force Java 17.
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
#   ./build-android.sh              # debug APK (default)
#   ./build-android.sh release      # release APK (needs signing config)
#   ./build-android.sh install      # debug build + adb install to attached device
set -euo pipefail

export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
# Capacitor 8 compiles against Java 21 (17 fails with "invalid source release: 21").
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
ADB="$ANDROID_HOME/platform-tools/adb"

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"

MODE="${1:-debug}"

# Ensure local.properties exists (gitignored, machine-specific).
if [[ ! -f "$ANDROID_DIR/local.properties" ]]; then
  echo "sdk.dir=$ANDROID_HOME" > "$ANDROID_DIR/local.properties"
  echo "==> wrote $ANDROID_DIR/local.properties"
fi

echo "==> Building web bundle (@carbon/web)"
npm run --prefix "$MOBILE_DIR" build:web

echo "==> Capacitor sync (copies dist + plugins into android/)"
( cd "$MOBILE_DIR" && npx cap sync android )

case "$MODE" in
  release)
    echo "==> Gradle assembleRelease (Java 17)"
    ( cd "$ANDROID_DIR" && ./gradlew assembleRelease --no-daemon )
    ( cd "$ANDROID_DIR" && ./gradlew bundleRelease --no-daemon )
    echo "==> Release APK(s):"
    find "$ANDROID_DIR/app/build/outputs/apk/release" -name '*.apk'
    ;;
  debug|install)
    echo "==> Gradle assembleDebug (Java 17)"
    ( cd "$ANDROID_DIR" && ./gradlew assembleDebug --no-daemon )
    echo "==> Debug APK: $APK"
    ls -lh "$APK"
    if [[ "$MODE" == "install" ]]; then
      echo "==> adb install -r"
      "$ADB" install -r "$APK"
    fi
    ;;
  *)
    echo "Unknown mode: $MODE (use debug|release|install)" >&2
    exit 1
    ;;
esac

echo "==> Done."
