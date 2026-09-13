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
#       paru -S --needed android-sdk-platform-tools android-sdk-build-tools android-platform-37
#     compileSdk is 37 (AndroidX requirement), targetSdk is 36; build-tools is pinned to the
#     installed version in variables.gradle because AGP can't auto-install into the RO SDK.
#   - Because the SDK is read-only, Gradle can't write license-acceptance files itself.
#     Create them once (root): /opt/android-sdk/licenses/android-sdk-license with the
#     standard accepted SHA hashes, else builds fail with "license not accepted".
#   - android/local.properties (gitignored) points Gradle at the SDK.
#   - Push/FCM is wired via google-services.json + @capacitor/push-notifications;
#     the firebase-adminsdk service-account key is server-side only, NOT in the app.
#
# Usage:
#   ./build-android.sh              # both sideload and playstore release APK + AAB
#   ./build-android.sh debug        # sideload debug APK + AAB
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

REPO_DIR="$(cd "$MOBILE_DIR/../.." && pwd)"
RELEASE_DIR="$REPO_DIR/release"
MODE="${1:-all}"

case "$MODE" in
  all|debug|install|release|playstore) ;;
  *)
    echo "Unknown mode: $MODE (use: all | debug | release | playstore | install)" >&2
    exit 1
    ;;
esac
VERSION="$(node -p 'require(process.argv[1]).version' "$REPO_DIR/package.json")"

# Ensure local.properties exists (gitignored, machine-specific).
if [[ ! -f "$ANDROID_DIR/local.properties" ]]; then
  echo "sdk.dir=$ANDROID_HOME" > "$ANDROID_DIR/local.properties"
  echo "==> wrote $ANDROID_DIR/local.properties"
fi

# Build and collect each flavor before syncing the next flavor's web assets.
build_variant() {
  local mode="$1" flavor bt variant btl apk_file aab_file name artifact
  local -a web_env
  case "$mode" in
    debug|install) flavor="sideload"; bt="Debug"; web_env=(VITE_PLAY_STORE=0) ;;
    release)       flavor="sideload"; bt="Release"; web_env=(VITE_PLAY_STORE=0) ;;
    playstore)     flavor="playstore"; bt="Release"; web_env=(VITE_PLAY_STORE=1) ;;
  esac

  variant="${flavor}${bt}"
  btl="${bt,,}"
  apk_file="$OUT_BASE/apk/$flavor/$btl/app-${flavor}-${btl}.apk"
  aab_file="$OUT_BASE/bundle/$variant/app-${flavor}-${btl}.aab"
  # Keep the original sideload artifact name; only Play Store adds a suffix.
  name="Carbon_${VERSION}_android"
  [[ "$flavor" != "playstore" ]] || name="${name}_playstore"
  [[ "$bt" != "Debug" ]] || name="${name}_debug"

  echo "==> Building web bundle (@carbon/web) with ${web_env[*]}"
  env "${web_env[@]}" npm run --prefix "$MOBILE_DIR" build:web

  echo "==> Capacitor sync (copies dist + plugins into android/)"
  ( cd "$MOBILE_DIR" && npx cap sync android )

  echo "==> Gradle assemble$variant + bundle$variant (Java 21)"
  ( cd "$ANDROID_DIR" && ./gradlew "assemble$variant" "bundle$variant" --no-daemon )

  # Require both expected artifacts before collecting a successful build.
  for artifact in "$apk_file" "$aab_file"; do
    if [[ ! -s "$artifact" ]]; then
      echo "Missing or empty build artifact: $artifact" >&2
      return 1
    fi
  done
  # Capgo reads this class's package while loading the plugin in both flavors.
  # Check the actual R8 output: moving it to the unnamed package crashes startup.
  if [[ "$bt" == "Release" ]]; then
    local service_class="com.capgo.capacitor_background_geolocation.BackgroundGeolocationService"
    local mapping_file="$OUT_BASE/mapping/$variant/mapping.txt"
    if ! grep -Fqx "$service_class -> $service_class:" "$mapping_file"; then
      echo "Unsafe R8 output: background geolocation service package was not preserved" >&2
      return 1
    fi
  fi

  mkdir -p "$RELEASE_DIR"
  cp "$apk_file" "$RELEASE_DIR/$name.apk"
  cp "$aab_file" "$RELEASE_DIR/$name.aab"
  echo "==> Artifacts:"
  echo "$RELEASE_DIR/$name.apk"
  echo "$RELEASE_DIR/$name.aab"

  if [[ "$mode" == "install" ]]; then
    echo "==> adb install -r $RELEASE_DIR/$name.apk"
    "$ADB" install -r "$RELEASE_DIR/$name.apk"
  fi
}

if [[ "$MODE" == "all" ]]; then
  build_variant release
  build_variant playstore
else
  build_variant "$MODE"
fi

echo "==> Done."
