#!/usr/bin/env bash
# sync-check.sh — compare a working repo codec file against babb-codecs current,
# archive the old version, and update current if a version bump is confirmed.
#
# Usage:
#   ./scripts/sync-check.sh <source-file> <codec-dir>
#
# Examples:
#   ./scripts/sync-check.sh ../workpadskaios/js/lib/codec.js workpads/kaios
#   ./scripts/sync-check.sh ../workpadsdotme/js/lib/codec.js workpads/web
#   ./scripts/sync-check.sh ../workpadskaios/js/lib/relational-codec.js workpads/relational

set -e

SOURCE="$1"
CODEC_DIR="$2"

if [ -z "$SOURCE" ] || [ -z "$CODEC_DIR" ]; then
  echo "Usage: sync-check.sh <source-file> <codec-dir>"
  exit 1
fi

BABB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILENAME="$(basename "$SOURCE")"
CURRENT="$BABB_ROOT/$CODEC_DIR/$FILENAME"
CURRENT_VERSION_FILE="$BABB_ROOT/$CODEC_DIR/CURRENT_VERSION"

if [ ! -f "$CURRENT" ]; then
  echo "ERROR: No current file at $CURRENT"
  exit 1
fi

CURRENT_VER="$(cat "$CURRENT_VERSION_FILE" 2>/dev/null || echo "unknown")"

if diff -q "$SOURCE" "$CURRENT" > /dev/null 2>&1; then
  echo "✓  $CODEC_DIR/$FILENAME  (v$CURRENT_VER) — up to date"
  exit 0
fi

echo ""
echo "Changes detected in $CODEC_DIR/$FILENAME  (current: v$CURRENT_VER)"
echo "────────────────────────────────────────────────────────"
diff "$CURRENT" "$SOURCE" || true
echo "────────────────────────────────────────────────────────"
echo ""
read -rp "Enter new version number to archive and update (e.g. 1.1), or blank to skip: " NEW_VER

if [ -z "$NEW_VER" ]; then
  echo "Skipped — no changes made to babb-codecs."
  exit 0
fi

VERSION_DIR="$BABB_ROOT/$CODEC_DIR/v$NEW_VER"

if [ -d "$VERSION_DIR" ]; then
  echo "ERROR: v$NEW_VER already exists at $VERSION_DIR"
  exit 1
fi

mkdir -p "$VERSION_DIR"
cp "$CURRENT" "$VERSION_DIR/$FILENAME"
cp "$SOURCE" "$CURRENT"
echo "$NEW_VER" > "$CURRENT_VERSION_FILE"

echo ""
echo "✓  Archived old version → $CODEC_DIR/v$CURRENT_VER/$FILENAME"
echo "✓  Updated current      → $CODEC_DIR/$FILENAME  (v$NEW_VER)"
echo ""
echo "Next: commit and push babb-codecs."
