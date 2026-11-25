#!/bin/bash
# Builds the zip for the Chrome Web Store: scripts/build-store.sh <out dir>
# The normal build, minus the debug page, the source maps and the dev `key` (Google assigns the store
# id). scripts/store-package.mjs checks the result and fails the build if any of it came back, if the name
# is not Local Studio, if an icon is missing, if the version is not package.json's, or if a permission has no
# reason in store/permissions.md. Writes <out dir>/local-studio-browser-<version>-store.zip.
# It also loads no code from outside the package: LOCAL_STUDIO_BROWSER_STORE_BUILD=1 gives the prompts that name only the libraries
# the zip packs for sandbox.html (scripts/build.mjs), `prepare` packs them and takes every remote source out of the
# sandbox's content security policy, and `check` fails if a remote source or a CDN's name is left anywhere.
set -euo pipefail
out="${1:?usage: build-store.sh <out dir>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$here"
LOCAL_STUDIO_BROWSER_STORE_BUILD=1 LOCAL_STUDIO_BROWSER_NO_BUMP=1 LOCAL_STUDIO_BROWSER_OUT_DIR="$work/ext" npm run --silent build
node scripts/store-package.mjs prepare "$work/ext" "$here"
node scripts/store-package.mjs check "$work/ext" "$here"
version="$(node -p "require('$work/ext/manifest.json').version")"
zip_path="$out/local-studio-browser-$version-store.zip"
rm -f "$zip_path"
(cd "$work/ext" && zip -qr -X "$zip_path" .)
echo "$zip_path ($(du -h "$zip_path" | cut -f1), $(find "$work/ext" -type f | wc -l | tr -d ' ') files)"
