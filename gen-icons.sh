#!/usr/bin/env bash
# Regenerate the native app icons (desktop + Android) with a proper safe-zone
# border around the logo.
#
# Why this exists:
#   The browser PWA looks fine because an installed PWA uses the *maskable* icon
#   (apps/web/public/icon-512-maskable.png), which already bakes in a comfortable
#   border. The desktop (Tauri) and Android (Capacitor) launcher icons were made
#   from edge-to-edge sources, so the checkbox ran right to the rim. This script
#   rebuilds them from the maskable icon so every platform matches the PWA.
#
# How it works:
#   The maskable icon is a flat, fully-opaque #FAFAF8 square. We composite a
#   scaled-down copy of it onto a same-coloured canvas, which adds a seamless
#   border (the canvas and the icon background are the same colour). Two masters
#   are produced:
#     - SQUARE master  -> desktop icons + Android legacy launcher (modest border)
#     - FOREGROUND      -> Android adaptive foreground (extra border so the logo
#                          stays inside the adaptive safe zone and is never clipped
#                          by the launcher's mask/parallax)
#
# Requirements: ImageMagick (`magick`). Desktop step also needs the Tauri CLI
# (already a dev dependency of @carbon/desktop).
#
# Usage:
#   ./gen-icons.sh              # regenerate desktop + Android icons
#   ./gen-icons.sh --no-desktop # Android icons only (skip the Tauri CLI step)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO_ROOT/apps/web/public/icon-512-maskable.png"   # liked PWA look
BG="#FAFAF8"                                               # off-white, matches the source bg
ANDROID_RES="$REPO_ROOT/apps/mobile/android/app/src/main/res"

DO_DESKTOP=1
for arg in "$@"; do
  case "$arg" in
    --no-desktop) DO_DESKTOP=0 ;;
    *) echo "Unknown arg: $arg (use: --no-desktop)" >&2; exit 1 ;;
  esac
done

command -v magick >/dev/null || { echo "ImageMagick (magick) not found" >&2; exit 1; }
[[ -f "$SRC" ]] || { echo "Source icon not found: $SRC" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SQUARE="$TMP/master-square.png"   # 1024, logo ~63% of frame
FG="$TMP/master-foreground.png"   # 1024, logo ~56% of frame (adaptive safe zone)

# Build the two masters by shrinking the maskable onto a same-colour canvas.
# 1024 canvas; the inner number is the size the maskable is scaled to.
magick -size 1024x1024 "xc:$BG" \
  \( "$SRC" -resize 922x922 \) -gravity center -composite \
  "$SQUARE"
magick -size 1024x1024 "xc:$BG" \
  \( "$SRC" -resize 808x808 \) -gravity center -composite \
  "$FG"

# --- Desktop (Tauri) --------------------------------------------------------
if [[ "$DO_DESKTOP" == 1 ]]; then
  echo "==> Regenerating desktop icons via 'tauri icon'"
  npm run -w @carbon/desktop tauri -- icon "$SQUARE"
fi

# --- Android (Capacitor) ----------------------------------------------------
# Legacy square + round launcher icons, per density.
echo "==> Regenerating Android launcher icons"
declare -A LAUNCHER=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
for d in "${!LAUNCHER[@]}"; do
  n="${LAUNCHER[$d]}"
  out="$ANDROID_RES/mipmap-$d"
  magick "$SQUARE" -resize "${n}x${n}" "$out/ic_launcher.png"
  # round = square clipped to a circle
  c=$(( n / 2 ))
  magick "$SQUARE" -resize "${n}x${n}" \
    \( +clone -alpha transparent -draw "fill white circle $c,$c $c,0" \) \
    -compose DstIn -composite "$out/ic_launcher_round.png"
done

# Adaptive foreground, per density (108/162/216/324/432).
echo "==> Regenerating Android adaptive foreground"
declare -A FOREGROUND=( [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432 )
for d in "${!FOREGROUND[@]}"; do
  n="${FOREGROUND[$d]}"
  magick "$FG" -resize "${n}x${n}" "$ANDROID_RES/mipmap-$d/ic_launcher_foreground.png"
done

echo "==> Done. Re-run the platform build to pick up the new icons:"
echo "    desktop: npm run -w @carbon/desktop build"
echo "    android: apps/mobile/build-android.sh"
