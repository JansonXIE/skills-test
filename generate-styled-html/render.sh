#!/usr/bin/env bash
# render.sh — screenshot a generated HTML file to PNG for visual verification.
# Usage: ./render.sh <file.html> [out.png] [width] [height]
# Auto-locates the Playwright-cached Chromium; falls back to system chrome.
set -euo pipefail

HTML="${1:?usage: render.sh <file.html> [out.png] [width] [height]}"
OUT="${2:-/tmp/styled-html-shot.png}"
W="${3:-1280}"
H="${4:-1600}"

# Resolve to an absolute file:// URL.
case "$HTML" in
  /*) ABS="$HTML" ;;
  *)  ABS="$(pwd)/$HTML" ;;
esac
[ -f "$ABS" ] || { echo "no such file: $ABS" >&2; exit 1; }

find_chrome() {
  for c in \
    "$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)" \
    "$(command -v chromium-cli 2>/dev/null || true)" \
    "$(command -v chromium 2>/dev/null || true)" \
    "$(command -v chromium-browser 2>/dev/null || true)" \
    "$(command -v google-chrome 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

CHROME="$(find_chrome)" || { echo "no chromium/chrome found" >&2; exit 1; }
echo "chrome: $CHROME" >&2

"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size="${W},${H}" \
  --screenshot="$OUT" "file://$ABS" >/dev/null 2>&1

[ -f "$OUT" ] || { echo "screenshot failed" >&2; exit 1; }
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
