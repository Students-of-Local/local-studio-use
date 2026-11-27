# Local Studio Use

[![CI](https://github.com/Students-of-Local/local-studio-use/actions/workflows/browser-ci.yml/badge.svg?branch=main)](https://github.com/Students-of-Local/local-studio-use/actions/workflows/browser-ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

Browser use and computer use for AI agents. Claude Code, Codex, pi or any MCP client drives your real browser in
background tabs of its own while you keep working, and reaches desktop apps through a platform driver.

- **The Chrome extension** (`src/`, `static/`): Chromium 141+ (Helium, Chrome, Brave, Edge, Chromium). It runs the
  agent's tabs and the side panel.
- **Computer use** (`hands/`): `local-studio-computer`, the helper that reads and acts on desktop apps (AT-SPI on Linux,
  Accessibility on macOS).
- **The MCP server** (`local-studio`): `local-studio-browser mcp`, a stdio server with the browser and computer tools.
- **One small helper** (`cli/`): `local-studio-browser`, the command line tool and the native host the extension talks to.

The Local Studio app ships all of them and keeps them updated. With the app running, the side panel chats through it on
your local models, and the extension holds no API key.

## Install

This repository has no releases yet, so build from source. You need Node 22, git and a Chromium 141+ browser.

```bash
git clone https://github.com/Students-of-Local/local-studio-use && cd local-studio-use
./scripts/setup-siblings.sh        # clones pinned pi-mono and mini-lit into vendor/, patches, installs
npm run build                      # writes the unpacked extension to dist-chrome/
(cd cli && npm run build && npm link)
local-studio-browser setup         # registers the native host, waits for the extension, offers to add the MCP server
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick `dist-chrome/`. The
extension ID (`igjafcggmahiboobmnhfkndodphjdnhg`) comes from the manifest key, so it is the same in every copy.
`local-studio-browser doctor` checks each piece and prints the command that fixes it.

## Claude Code

`local-studio-browser setup` offers to do this. By hand:

```bash
claude mcp add --scope user local-studio -- ~/.local-studio/browser/local-studio-browser mcp
```

That path is the launcher `local-studio-browser install` writes; it pins Node by absolute path, so an agent started from
a GUI app needs no `node` on its PATH. [GUIDE.md](GUIDE.md#connect-your-agent) has Codex, OpenCode, Cursor and others.

## Checks

```bash
./check.sh                         # biome, tsc, theme check, extension and CLI unit tests
```

CI (`.github/workflows/browser-ci.yml`) runs the same on every pull request, plus the CLI on Windows, the headless
end-to-end tests, an install from an empty home folder and the market eval.

## More

- [GUIDE.md](GUIDE.md): the full user guide (sessions, skills, library, remote MCP, safety model).
- [docs/](docs/README.md): design notes and references. [docs/remote.md](docs/remote.md): reaching the MCP server from
  claude.ai, ChatGPT and grok.com.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Credits

The agent bridge is the work of [0xSero](https://github.com/0xSero)
([0xSero/sitegeist](https://github.com/0xSero/sitegeist)). The extension is
[Mario Zechner](https://github.com/badlogic)'s [Sitegeist](https://github.com/badlogic/sitegeist),
built on his [pi](https://github.com/badlogic/pi-mono) and
[mini-lit](https://github.com/badlogic/mini-lit) libraries. Details are in
[GUIDE.md](GUIDE.md#credits) and [docs/fork-changes.md](docs/fork-changes.md).

## License

[AGPL-3.0](LICENSE), unchanged from upstream. If you run a modified version for others over a network, the AGPL asks you
to offer them its source. The Local Studio name and logo are not covered by this license.
