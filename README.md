# Local Studio: browser and computer use

[![CI](https://github.com/baney75/local-studio/actions/workflows/browser-ci.yml/badge.svg?branch=main)](https://github.com/baney75/local-studio/actions/workflows/browser-ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

This is the part of Local Studio that gives AI agents browser use and computer use: a Chromium
extension, a CLI helper and an MCP server. Claude Code, Codex, pi or any MCP client drives your real browser through it,
in background tabs of its own, while you keep working. The computer-use tools reach desktop apps
through a platform driver.

It ships inside the Local Studio app: the app carries the helper, the computer-use helper and the extension, and updates
all three. The panel chats through the app's Eukhe daemon, on your local models and the subscriptions you signed in to
there, without the extension holding any API key (see below).

The command and npm package are `local-studio-browser`, the MCP server is `local-studio` and the native host is
`com.localstudio.browser`.

## How the panel reaches models

When the app runs, the side panel's default provider is **Local Studio**, and the first run
asks for no key. The panel sends each chat to the `local-studio-browser` native host over Chrome native
messaging; the host passes it to Local Studio's Eukhe daemon on its local socket, and each panel
chat becomes a Eukhe session of its own. The daemon runs the model and streams the answer and its
tool steps back to the panel. Stop sends Abort to that session.

- **No keys in the extension.** The extension never sees a key or a sign-in token. Local models
  need none; subscriptions are signed in inside Local Studio, with `eukhe` and its `/login`
  command (ChatGPT, Claude, Copilot and others). The model picker lists local models first, then
  the signed-in subscriptions, each labeled.
- **The browser tools come back through the plugin.** `local-studio-browser install --local-studio` gives
  Eukhe the `local-studio` tool server, so the session reads and acts on your tabs with the small tool
  list.
- **A page can't make a panel chat change your files.** Each panel session works in an empty
  private folder, and only reads there run unasked (Eukhe's `shell.autoEffects`, for that session
  alone); the panel says no to every command and write. If Local Studio won't take the limit, the
  chat does not start.
- **Only this extension.** The host answers only the pinned extension ID and exits for
  any other caller before it reads a message.
- **When Local Studio is not running**, a chat on it says so and how to fix it (start Local
  Studio, or run `eukhe` in a terminal) within a few seconds, instead of waiting. Local Studio
  chats are not on Windows yet.
- **API keys are still there.** On the first run, "Use an API key instead" opens the provider
  keys, and every key provider stays in the model picker.

## Provider terms

Driving a consumer subscription (a chat plan you pay for as a person) through automation may
break that provider's terms of service. Some providers allow it, some forbid it, and terms
change. Local Studio does not decide this for you. Read your provider's terms and decide whether to
connect a subscription; API keys under a developer agreement are the safer route where terms
are unclear.

## Install

You need a Chromium 141+ browser (Helium, Chrome, Brave, Edge or Chromium) and the
[Local Studio app](https://github.com/baney75/local-studio/releases). In the app, Settings > Browser and computer use:

1. Turn on Browser use and tick your browsers. That registers the native host with each of them and nothing else.
2. Load the extension from the folder the page shows: open `chrome://extensions`, turn on Developer mode, choose **Load
   unpacked** and pick it. Its ID is fixed by the manifest key, so the host registration already allows it.
3. For desktop apps, turn on Computer use. On a Mac the page says what to allow in System Settings.

The app's own threads get the tools at once. To use them from an agent you run yourself, build from source (below) and
run `local-studio-browser setup --agents`. A headless machine installs the Linux app build.

## Build and load the extension

You need Node 22 or newer, git, and a Chromium 141+ browser (Helium, Chrome, Brave or Chromium).

```bash
git clone https://github.com/baney75/local-studio && cd local-studio/browser
./scripts/setup-siblings.sh        # clones pinned pi-mono and mini-lit into vendor/, patches, installs
npm run build                      # writes the unpacked extension to dist-chrome/
(cd cli && npm run build && npm link)
```

Load it by hand: open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**
and pick the `dist-chrome/` folder. Then register the native host and connect your agents:

```bash
local-studio-browser setup                     # or: local-studio-browser doctor
claude mcp add --scope user local-studio -- local-studio-browser mcp
```

The extension ID (`igjafcggmahiboobmnhfkndodphjdnhg`) comes from the manifest key, so it is the same in every copy.

### Where things are kept

The helper's settings and sign-ins are in `~/.local-studio/browser` (private), its launchers (`local-studio-browser`,
`local-studio-browser-host`) beside them, its sockets in `/tmp/local-studio-browser-<user>`, and its services are named
`com.localstudio.browser.<name>` (`local-studio-browser-<name>.service` on Linux). The extension's chats, keys and settings
are in the browser's own storage for its ID: removing the extension deletes them, and updating it keeps them.

## Checks

```bash
./check.sh                         # biome, tsc, theme check, extension and CLI unit tests
(cd cli && npm run bench:dom)      # 44-page DOM benchmark against cli/test/dom-bench/floor.json
```

CI runs the same on every push and pull request (`.github/workflows/browser-ci.yml`), plus the headless
end-to-end tests.

## Platforms

macOS and Linux run the extension, the CLI and the MCP server. Native app control on Linux comes
from `local-studio-computer` ([hands/linux/README.md](hands/linux/README.md)), a static helper that works through AT-SPI in
the background and never sends physical input. [docs/LINUX.md](docs/LINUX.md) covers the rest of Linux.

## More

- [GUIDE.md](GUIDE.md): the full user guide (sessions, skills, library, remote MCP, safety model).
- Change any site: ask an agent "make x.com dark", "hide every post about crypto on x.com" or "remove Shorts from
  YouTube", or open Change this site in the side panel. It is saved for every visit, and Undo is one click
  ([GUIDE.md, Site edits and feed filters](GUIDE.md#site-edits-and-feed-filters)).
- [docs/](docs/README.md): design notes and references.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Remote access

`local-studio-browser remote setup` makes the MCP server reachable from claude.ai, ChatGPT and grok.com through a relay
on your own free Cloudflare account, Tailscale Funnel or your own Cloudflare tunnel; [docs/remote.md](docs/remote.md) has every step.

## Credits

The agent bridge is the work of [0xSero](https://github.com/0xSero)
([0xSero/sitegeist](https://github.com/0xSero/sitegeist)). The extension is
[Mario Zechner](https://github.com/badlogic)'s [Sitegeist](https://github.com/badlogic/sitegeist),
built on his [pi](https://github.com/badlogic/pi-mono) and
[mini-lit](https://github.com/badlogic/mini-lit) libraries. Details are in
[GUIDE.md](GUIDE.md#credits) and [docs/fork-changes.md](docs/fork-changes.md).

## License

[AGPL-3.0](LICENSE), unchanged from upstream; the rest of the repository is MIT. If you run a
modified version for others over a network, the AGPL asks you to offer them its source. The
Local Studio name and logo are not covered by this license.
