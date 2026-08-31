#!/bin/bash
set -euo pipefail
URL="${1:-http://localhost:5173}"
PROFILE="${HOME}/.cache/facelogin-chrome"
mkdir -p "$PROFILE"
open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE" \
  --allow-insecure-localhost \
  --ignore-certificate-errors \
  --unsafely-treat-insecure-origin-as-secure="$URL" \
  "$URL"
