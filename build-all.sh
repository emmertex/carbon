#!/usr/bin/env bash
# Build every Carbon app available on the current OS and collect the installers
# into a single release/ directory.
#
# What it builds, per OS (Tauri cannot cross-compile, so the desktop bundle is
# whatever the host can produce):
#   Linux   : desktop  -> .deb, .rpm, .AppImage      + Android .apk
#   macOS   : desktop  -> .dmg, .app(.tar.gz)         + Android .apk (if SDK present)
#   Windows : desktop  -> .msi, .exe (NSIS setup)     (run under Git Bash / MSYS)
#
# All artifacts are copied (renamed where needed) into ./release/ at the repo root.
# The Android APK is renamed to Carbon_<version>_android.apk to match the versioned
# naming of the desktop bundles. In release mode the signed sideload AAB (the
# GitHub-release upload) is collected as Carbon_<version>_android.aab.
#
# Android ships in two flavors (see apps/mobile/android/app/build.gradle):
#   sideload  — full feature set, distributed via GitHub Releases (default).
#   playstore — Google Play variant (no background location). Build it with
#               `playstore`, which collects Carbon_<version>_playstore_android.aab/.apk.
#
# Usage:
#   ./build-all.sh                 # build everything for this OS (Android = debug)
#   ./build-all.sh release         # Android signed sideload APK + AAB (needs signing config)
#   ./build-all.sh playstore       # Android signed Play variant AAB + APK (needs signing config)
#   ./build-all.sh --no-android    # desktop only
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$REPO_ROOT/release"
BUNDLE_DIR="$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle"

# --- args -------------------------------------------------------------------
ANDROID_MODE="debug"
DO_ANDROID=1
for arg in "$@"; do
  case "$arg" in
    release)      ANDROID_MODE="release" ;;
    debug)        ANDROID_MODE="debug" ;;
    playstore)    ANDROID_MODE="playstore" ;;
    --no-android) DO_ANDROID=0 ;;
    *) echo "Unknown arg: $arg (use: release | playstore | debug | --no-android)" >&2; exit 1 ;;
  esac
done

# --- version (single-sourced from repo-root package.json) -------------------
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
echo "==> Carbon v$VERSION"

# --- OS detection -----------------------------------------------------------
case "$(uname -s)" in
  Linux*)            OS="linux" ;;
  Darwin*)           OS="macos" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
echo "==> Host OS: $OS"

mkdir -p "$RELEASE_DIR"

# Copy helper: copies matches of a glob into release/, reports what it took.
collect() {
  local label="$1"; shift
  local found=0
  for f in "$@"; do
    if [[ -f "$f" ]]; then
      cp -f "$f" "$RELEASE_DIR/"
      echo "    + $label: $(basename "$f")"
      found=1
    fi
  done
  [[ "$found" == 1 ]] || echo "    ! $label: no artifact found (looked for: $*)"
}

# ---------------------------------------------------------------------------
# 1. Desktop (Tauri)
# ---------------------------------------------------------------------------
echo "==> Building desktop bundle (npm run -w @carbon/desktop build)"
npm run -w @carbon/desktop build

echo "==> Collecting desktop artifacts for v$VERSION"
case "$OS" in
  linux)
    collect "deb"     "$BUNDLE_DIR"/deb/Carbon_"${VERSION}"_*.deb
    collect "rpm"     "$BUNDLE_DIR"/rpm/Carbon-"${VERSION}"-*.rpm
    collect "AppImage" "$BUNDLE_DIR"/appimage/Carbon_"${VERSION}"_*.AppImage
    ;;
  macos)
    collect "dmg"     "$BUNDLE_DIR"/dmg/Carbon_"${VERSION}"_*.dmg
    collect "app"     "$BUNDLE_DIR"/macos/Carbon.app.tar.gz
    ;;
  windows)
    collect "msi"     "$BUNDLE_DIR"/msi/Carbon_"${VERSION}"_*.msi
    collect "nsis"    "$BUNDLE_DIR"/nsis/Carbon_"${VERSION}"_*-setup.exe
    ;;
esac

# ---------------------------------------------------------------------------
# 2. Android (Capacitor) — Linux/macOS only; needs Android SDK + Java 21
# ---------------------------------------------------------------------------
if [[ "$DO_ANDROID" == 1 && "$OS" != "windows" ]]; then
  if [[ -x "$REPO_ROOT/apps/mobile/build-android.sh" ]]; then
    echo "==> Building Android ($ANDROID_MODE)"
    "$REPO_ROOT/apps/mobile/build-android.sh" "$ANDROID_MODE"

    # Map mode -> (flavor, build type) for AGP's flavor-qualified output dirs.
    case "$ANDROID_MODE" in
      debug|install) AFLAVOR="sideload";  ABT="Debug" ;;
      release)       AFLAVOR="sideload";  ABT="Release" ;;
      playstore)     AFLAVOR="playstore"; ABT="Release" ;;
    esac
    AVARIANT="${AFLAVOR}${ABT}"
    ABTL="$(echo "$ABT" | tr '[:upper:]' '[:lower:]')"
    APK_SRC="$REPO_ROOT/apps/mobile/android/app/build/outputs/apk/$AVARIANT"

    # Suffix Play artifacts so they don't collide with the sideload ones.
    SUFFIX="$([[ "$AFLAVOR" == "playstore" ]] && echo "_playstore" || echo "")"

    APK_FILE="$(ls -t "$APK_SRC"/*.apk 2>/dev/null | head -n1 || true)"
    if [[ -n "$APK_FILE" ]]; then
      DEST="$RELEASE_DIR/Carbon_${VERSION}${SUFFIX}_android.apk"
      cp -f "$APK_FILE" "$DEST"
      echo "    + apk: $(basename "$DEST")"
    else
      echo "    ! apk: no APK found in $APK_SRC"
    fi

    # Release builds also produce the signed AAB. Sideload AAB = GitHub-release
    # upload; Play AAB = Google Play upload (distinct name so both can coexist).
    if [[ "$ANDROID_MODE" == "release" || "$ANDROID_MODE" == "playstore" ]]; then
      AAB_FILE="$REPO_ROOT/apps/mobile/android/app/build/outputs/bundle/$AVARIANT/app-${AFLAVOR}-${ABTL}.aab"
      if [[ -f "$AAB_FILE" ]]; then
        DEST="$RELEASE_DIR/Carbon_${VERSION}${SUFFIX}_android.aab"
        cp -f "$AAB_FILE" "$DEST"
        echo "    + aab: $(basename "$DEST")"
      else
        echo "    ! aab: no AAB found at $AAB_FILE"
      fi
    fi
  else
    echo "==> Skipping Android (apps/mobile/build-android.sh not executable/found)"
  fi
elif [[ "$OS" == "windows" ]]; then
  echo "==> Skipping Android on Windows host"
fi

# ---------------------------------------------------------------------------
echo
echo "==> Done. Artifacts in $RELEASE_DIR:"
ls -lh "$RELEASE_DIR" | tail -n +2
echo
cat <<EOF
Note: Tauri cannot cross-compile. To get the other desktop installers, run this
script on that OS:
  - macOS   -> .dmg / .app    (run on a Mac)
  - Windows -> .msi / .exe    (run under Git Bash/MSYS on Windows)
EOF
