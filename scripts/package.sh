#!/bin/sh
# Builds dist/ai-slop-badge-<version>.zip for the Chrome Web Store with runtime files only.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(node -p "require('./manifest.json').version")"
out="dist/ai-slop-badge-${version}.zip"

mkdir -p dist
rm -f "$out"
zip -r -X -q "$out" manifest.json background.js lib content popup icons -x '*.DS_Store'
unzip -l "$out"
