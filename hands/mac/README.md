# tychicus-hands for macOS

Tychicus's computer-use helper: `tychicus-hands mcp [--connector]`, a stdio MCP server that speaks the hands protocol
(`docs/hands-protocol.md`). Tychicus's `computer_*` tools find it on PATH, in `~/.local/bin`, or through
`TYCHICUS_HANDS_BIN`.

How it is built:

- The router runs in this process; `TychicusHost` gives it windows from Accessibility and the window server.
- No window manager keeps an agent workspace for it: the windows of apps this helper started count as the agent's, and
  nothing moves (`AgentWorkspace.swift`).
- No window-manager verbs (workspaces, query, events, arrange, move, switch, focus, frame). `close` stays. A connector
  still gets `permission_denied` for every managing verb.
- No consent sheets yet, so nothing widens access: the mode is Default, or Read Only with
  `defaults write tychicus-hands agentAccessMode read_only`. Lending answers `needs_lend`.

## Install

A release installs it. The darwin archive (`tychicus-<version>-darwin-arm64.tar.gz`) carries it as
`bin/tychicus-hands`, covered by `SHA256SUMS` and the build attestation like everything else in the archive, and
`tychicus install --release <folder>` (which the one-command installer runs) copies it to `~/.local/bin/tychicus-hands`.
It is copied, not linked, so it keeps one path across versions; a reinstall of the same bytes leaves the file alone.
`tychicus doctor` then names it (`Computer use: tychicus-hands (~/.local/bin/tychicus-hands), answered as ...`).

It is one file: the engine (agent-desktop's C library) is linked in, so nothing sits beside it.

## Accessibility

macOS lets a program read and act on other apps' windows only with the Accessibility grant, and it checks the grant
against the program responsible for the helper, not always the helper itself: the app it runs under (Terminal, or the
app an agent runs in) when an agent starts it from there, or the program a background service started. The helper
asks macOS which program that is, and when the grant is missing:

- `computer_status` says so and names the program and its path: "macOS hasn't allowed Terminal to use Accessibility,
  so tychicus-hands can't read or act on windows. Ask the person to open System Settings > Privacy & Security >
  Accessibility and turn on Terminal (/System/Applications/Utilities/Terminal.app)...".
- every window verb, `windows` and `open` included, answers `permission_denied` with the same words.

It asks macOS on every call (`AXIsProcessTrusted`), not once at start. The helper never opens System Settings or
changes a permission itself.

A capture (`shot`, or `snapshot` with `screenshot: true`) also needs Screen Recording, checked against the same program:
System Settings > Privacy & Security > Screen & System Audio Recording. Without it those answer `permission_denied` and
everything else works.

## Signing

Release builds are signed ad hoc with the hardened runtime: `codesign --force --sign - --options runtime --identifier
com.tychicus.hands` (`scripts/package.sh`). There is no Developer ID yet, so it isn't notarized either. The trade-off:

- macOS matches a program signed ad hoc by its hash, and every build has a new one. A person who allowed
  `tychicus-hands` itself in Accessibility (or the `tychicus` program, for a background service) has to allow it again
  after each update: select it in the list, click -, then + and add `~/.local/bin/tychicus-hands` again. A grant to an
  app such as Terminal is not affected. `tychicus install --release` says this whenever it puts a new helper in place.
- The engine is linked in statically because the hardened runtime's library validation refuses a library signed ad
  hoc ("mapping process and mapped file (non-platform) have different Team IDs"). One file also means no library
  beside it can be swapped while its grant stays.
- Not notarized, so Gatekeeper may refuse it when it carries the quarantine flag. The one-command installer downloads
  with `curl`, which sets no quarantine flag; an archive downloaded with a browser has one, and the unpacked files can
  keep it. That path is untested.

## Build

```sh
scripts/build-engine.sh          # agent-desktop's static library, pinned in engine/PIN (needs cargo); TYCHICUS_HANDS_ARM64_ONLY=1 for arm64 only
swift build -c release           # .build/release/tychicus-hands
scripts/package.sh <out-dir>     # both of the above for arm64, then the release copy: signed ad hoc and checked
```

`package.sh` fails unless the signed copy links only system libraries, verifies with the runtime flag and the
identifier, and answers `initialize` as `tychicus-hands`.

## Check

```sh
swift test                       # HandsCore; needs engine/lib, because the helper is linked too
cd ../../cli && TYCHICUS_HANDS_CONFORMANCE_BIN=$PWD/../hands/mac/.build/release/tychicus-hands node --test test/hands-conformance.test.mjs
```

CI (`.github/workflows/browser-hands-mac.yml`) runs `scripts/package.sh` and `swift test` on a macOS runner, and the conformance
suite against the signed binary at Default and Read Only. The runner gives the helper no Accessibility grant: window verbs answer
`permission_denied`, which the suite accepts, so CI proves the wire and the cap, not acting on windows.

## Not done yet

- Developer ID signing and notarization, so a grant to the helper survives updates.
- Consent sheets (lend, allow, Full Access). Until then lending answers `needs_lend` and Full Access can't be chosen.
- Right clicks and pop-up menus (`click` with `button: right`, `select` or `click` on a pop-up button): the menu would open
  on the person's screen, so they are refused until a window manager shows an agent workspace.
- Copies an agent left open when its helper ends stay open, and the next helper doesn't count them as the agent's.
- Close without saving for apps that autosave in place: TextEdit saved typed text into the file on `close` in the
  live test, and `cmd+z` or File > Revert To did not undo it in the background copy.
- An Intel (x86_64) build: the release has a darwin-arm64 archive only.
