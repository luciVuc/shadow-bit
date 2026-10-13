#!/bin/bash
# Builds all icon formats with no external dependencies.
#   - build/icon.png   (1024x1024, Linux + Windows/macOS source)
#   - build/icon.ico   (Windows, 16..256 multi-size PNG-in-ICO)
#   - build/icon.icns  (macOS, 16..1024 PNG chunks)
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

node scripts/gen-icon.js