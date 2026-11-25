#!/bin/sh
# Install the rival tools the market eval compares by hand (README.md), at the versions the 2026-11-17 study measured,
# into evals/market/rivals/tools (or $MARKET_RIVALS_DIR). Nothing here runs in CI, and nothing paid or signed in.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tools=${MARKET_RIVALS_DIR:-$here/tools}
mkdir -p "$tools/pw" "$tools/ab" "$tools/cdt"
(cd "$here" && npm ci --no-audit --no-fund)
(cd "$tools/pw" && npm init -y > /dev/null && npm install --no-audit --no-fund @playwright/mcp@0.0.85 @modelcontextprotocol/sdk@1.32.2)
(cd "$tools/ab" && npm init -y > /dev/null && npm install --no-audit --no-fund agent-browser@0.43.0)
(cd "$tools/cdt" && npm init -y > /dev/null && npm install --no-audit --no-fund chrome-devtools-mcp@1.13.0)
# browse ships a Rust relay and an extension; it needs cargo and bun on PATH.
if command -v cargo > /dev/null && command -v bun > /dev/null; then
	[ -d "$tools/browse/.git" ] || git clone https://github.com/anomalyco/browse "$tools/browse"
	(cd "$tools/browse" && git fetch -q origin && git checkout -q c3ad2ada2c4c17749a1eae95c205a99a38c505b8 && bun install && bun run build && (cd rust && cargo build))
else
	echo "skipped browse: it needs cargo and bun (rivals/README.md)" >&2
fi
(cd "$here/../../../cli" && npx playwright-core install chromium)
echo "rivals installed in $tools"
