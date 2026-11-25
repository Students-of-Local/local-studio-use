#!/bin/bash
# Builds local-studio-computer for a release and signs it ad hoc: <out>/local-studio-computer, one file (the engine is linked in).
#
#   scripts/package.sh <out-dir>
#
# Steps: build the engine (scripts/build-engine.sh, arm64 only: the release archive is darwin-arm64) and the helper
# (swift build -c release); copy it out and drop the build machine's own library paths from it; sign it ad hoc with the
# hardened runtime; then check that it links only system libraries, that the signature verifies with the runtime flag and
# the identifier, and that the signed copy runs and answers `initialize` as local-studio-computer.
#
# Ad hoc, not Developer ID: macOS matches an ad hoc program by its hash, so a person who allowed local-studio-computer itself in
# Accessibility allows it again after each update (README.md, "Signing").
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/package.sh <out-dir>" >&2; exit 2; }
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
cd "$(dirname "$0")/.."

LOCAL_STUDIO_COMPUTER_ARM64_ONLY=1 scripts/build-engine.sh
swift build -c release
BIN=$(swift build -c release --show-bin-path)/local-studio-computer

cp "$BIN" "$OUT/local-studio-computer.tmp"
chmod 755 "$OUT/local-studio-computer.tmp"
# Library search paths that name this machine's folders: none is needed (the engine is static), and a path that
# doesn't exist on the person's Mac is one a local process could fill.
otool -l "$OUT/local-studio-computer.tmp" | sed -n '/cmd LC_RPATH/,/path /s/^ *path \(.*\) (offset.*/\1/p' | while IFS= read -r rpath; do
  case "$rpath" in
    /usr/lib/* | @*) ;;
    *) install_name_tool -delete_rpath "$rpath" "$OUT/local-studio-computer.tmp" ;;
  esac
done
codesign --force --sign - --options runtime --identifier com.localstudio.computer "$OUT/local-studio-computer.tmp"
# Checked under its temporary name, and renamed only once it passes, so a failed build never replaces a working helper.
HANDS="$OUT/local-studio-computer.tmp"

fail() { echo "package: $*" >&2; exit 1; }
# Only the system's libraries: anything else would have to ship beside it.
otool -L "$HANDS" | tail -n +2 | awk '{ print $1 }' | grep -Ev '^(/usr/lib/|/System/Library/)' | grep . \
  && fail "local-studio-computer links a library outside the system's (above)"
codesign --verify --strict --verbose=2 "$HANDS" 2>&1 || fail "the signature doesn't verify"
INFO=$(codesign -dv "$HANDS" 2>&1)
grep -q '^Identifier=com.localstudio.computer$' <<<"$INFO" || fail "the identifier isn't com.localstudio.computer: $INFO"
grep -q 'flags=.*adhoc' <<<"$INFO" || fail "not signed ad hoc: $INFO"
grep -q 'flags=.*runtime' <<<"$INFO" || fail "no hardened runtime in the signature: $INFO"
lipo -archs "$HANDS" | grep -qx arm64 || fail "not arm64: $(lipo -archs "$HANDS")"
"$HANDS" --version | grep -q '^local-studio-computer ' || fail "--version didn't answer"
HELLO='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"package","version":"0"}}}'
REPLY=$(printf '%s\n' "$HELLO" | "$HANDS" mcp)
grep -q '"name":"local-studio-computer"' <<<"$REPLY" || fail "the signed copy didn't answer initialize: $REPLY"
mv "$HANDS" "$OUT/local-studio-computer"
HANDS="$OUT/local-studio-computer"
echo "package: $HANDS ($(lipo -archs "$HANDS"), signed ad hoc with the hardened runtime, $(shasum -a 256 "$HANDS" | cut -c1-16))"
