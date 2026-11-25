# local-studio-browser (CLI)

Bridge between coding harnesses and the Local Studio browser extension. Any MCP client
(Claude Code, Codex, OpenCode, Cursor, OMP) and pi can drive a Chromium browser through it. Each harness
gets its own tab group and works in the background while you keep using your tabs.

```
harness ── stdio MCP ── local-studio-browser mcp ── unix socket ── native host ── native messaging ── extension
```

Nothing listens on the network. The browser spawns the native host; the host owns a
socket in `/tmp/local-studio-browser-<user>/` (0700 directory, 0600 socket) that only your
user can reach. The client refuses sockets and directories it does not own.

## Install

```bash
npm link                      # from this directory; puts local-studio-browser on PATH
local-studio-browser setup                 # build, register, load, connect and wire up your harnesses
```

`local-studio-browser setup` builds `dist-chrome` if it is missing, registers the native host for every
Chromium browser it finds, shows the one manual step (Load unpacked), waits until the
extension connects, and offers to add the MCP server to each harness it detects. It edits
a harness config only after a yes; `--yes` accepts every offer, `--no-wait` skips the
wait, `--timeout=<s>` bounds it. `local-studio-browser doctor` re-checks everything later and prints
one fix per problem (`--json` for scripts).

`local-studio-browser mcp` runs the installer itself on first use, so a harness configured to start
it needs no extra step. Reload the extension once after the first install.

## Commands

| Command | Purpose |
| --- | --- |
| `local-studio-browser setup [--yes] [--no-wait] [--timeout <s>]` | first-time setup, end to end |
| `local-studio-browser status [--json]` | is the extension connected, which sites are allowed, which browsers have the host |
| `local-studio-browser doctor [--json]` | check Node, the build, host manifests, the connection and harness configs; exits 1 on a failure |
| `local-studio-browser mcp [--session <name>]` | stdio MCP server exposing the browser tools; without `--session` (or `LOCAL_STUDIO_BROWSER_SESSION`) the session is the project's (git root), so a restarted harness resumes its tabs |
| `local-studio-browser sessions [list\|show\|rename\|end\|release\|focus\|collapse\|expand] [--json]` | agent sessions and their tab groups (see the main README, "Sessions and tab groups") |
| `local-studio-browser tabs [session] [--json]` | every agent tab, by session |
| `local-studio-browser allow <host>` | let agents open a site without a prompt (subdomains included) |
| `local-studio-browser ask` | agents ask before opening a site not yet allowed (the default) |
| `local-studio-browser allow-all` | agents may open any site without asking (`yolo` still works) |
| `local-studio-browser install [--force]` | write the native host manifest (Helium, Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Opera; Linux and Windows too) and the launchers in `~/.local-studio/browser/` |
| `local-studio-browser reload` | reload the extension (after rebuilding `dist-chrome`) |
| `local-studio-browser debug` | bridge state, recent request timings, Chrome API benchmark |
| `local-studio-browser pi-extension` | write `~/.pi/agent/extensions/local-studio-browser.ts` for pi; it removes a `local-studio.ts` or `local-studio.ts` an older copy of this helper wrote, and names the Local Studio app's own `local-studio.ts` without touching it |
| `local-studio-browser library add <doi\|arxiv> [--quote] [--location] [--note] [--tag]` | save a source, verified against its registry, OpenAlex and Crossref retraction notices |
| `local-studio-browser library list\|search\|verify\|cite\|export\|obsidian\|remove` | find, re-check, cite (apa, mla, chicago, ieee, harvard, vancouver), export (bibtex, ris, csl) or write Obsidian notes |
| `local-studio-browser serve [--port 8787]` | MCP over Streamable HTTP at `/mcp`, loopback only; every request needs a token |
| `local-studio-browser token create <name> --scope a,b` | a scoped, revocable token, shown once (`token list`, `token revoke <id\|name>`, `token scopes`) |
| `local-studio-browser tunnel tailscale [--port N] [--public] [--off]` | reach `serve` over HTTPS through your tailnet (`--public` uses Funnel) |
| `local-studio-browser tunnel cloudflare [--port N] [--off]` | reach `serve` through a cloudflared quick tunnel |
| `local-studio-browser remote setup [--tailscale\|--cloudflare [name]\|--public-url https://host]` | connect claude.ai, ChatGPT and grok.com in one command, then prove it from outside ([docs/remote.md](../docs/remote.md)) |
| `local-studio-browser remote status [--json]` | fast checks from this computer |
| `local-studio-browser remote test [--json]` | what an assistant sees from outside: public DNS, TLS, OAuth metadata, the sign-in challenge and a streaming probe |
| `local-studio-browser remote fix [--yes] [--dry-run] [--json]` | repair what test or status found, one step at a time, asking first |
| `local-studio-browser update [--check] [--rollback] [--channel stable\|nightly]` | install the latest signed release ([docs/updates.md](../docs/updates.md)) |
| `local-studio-browser completion zsh\|bash\|fish` | shell completions for commands, subcommands and flags |
| `local-studio-browser version [--json]` | the CLI's version, which is the extension's (`static/manifest.chrome.json`) |

Output is colored only on a terminal; `NO_COLOR` turns it off. Read commands take `--json`
(`status`, `doctor`, `sessions`, `tabs`, `library list`,
`library search`, `token list`, `token scopes`, `update --check`, `version`); `debug`
always prints JSON.

Exit codes, for every command: **0** success; **1** failed, not connected, or nothing found
(the message says the next step); **2** usage error (an unknown command, option or
argument). `update --check` exits 100 when an update exists; `library add` exits 3 for a
retracted source and 4 when the retraction check couldn't finish. `remote setup` and `remote fix` exit 3 when a
person has to act, and `remote test` exits 3 when nothing is set up.

### Shell completions

```bash
echo 'eval "$(local-studio-browser completion zsh)"' >> ~/.zshrc     # zsh
echo 'eval "$(local-studio-browser completion bash)"' >> ~/.bashrc   # bash
local-studio-browser completion fish > ~/.config/fish/completions/local-studio-browser.fish
```

The launcher `local-studio-browser install` writes (`~/.local-studio/browser/local-studio-browser`, what harness configs run)
sets `NODE_COMPILE_CACHE` (Node 22.1+). The saving is small: on one Apple M-series machine
`local-studio-browser mcp` started in 108 ms with it and 119 ms without (medians of 15 interleaved starts
each, `cli/eval/bridge-metrics.mjs --only launcher`), while the same harness on main, where
both arms are identical, differed by 9 ms. Treat it as at most about 10%.

## Harness setup

`local-studio-browser setup` does this for you. By hand, point each harness at the launcher
`~/.local-studio/browser/local-studio-browser`, which `local-studio-browser install` writes. It runs this CLI with an
absolute Node path, so harnesses started from a GUI don't need `node` on their PATH:

```bash
claude mcp add --scope user local-studio -- ~/.local-studio/browser/local-studio-browser mcp
codex mcp add local-studio -- ~/.local-studio/browser/local-studio-browser mcp
local-studio-browser pi-extension
```

OpenCode (`~/.config/opencode/opencode.json`):

```json
{ "mcp": { "local-studio": { "type": "local", "command": ["/Users/you/.local-studio/browser/local-studio-browser", "mcp"], "enabled": true } } }
```

Cursor (`~/.cursor/mcp.json`) and OMP (`~/.omp/agent/mcp.json`):

```json
{ "mcpServers": { "local-studio": { "command": "/Users/you/.local-studio/browser/local-studio-browser", "args": ["mcp"] } } }
```

## Permissions

By default the extension asks before an agent opens a new site. MCP clients that support
elicitation (Claude Code, Codex) show the prompt inline; otherwise answer it in the
Local Studio side panel under Settings > Agents, run `local-studio-browser allow <host>`, or switch the
mode to "allow any site" there. pi: set `LOCAL_STUDIO_BROWSER_AUTO_ALLOW=1` to auto-approve.

`LOCAL_STUDIO_BROWSER_SESSION=<name>` makes a harness re-adopt the same tab group across restarts.
`LOCAL_STUDIO_BROWSER_SOCKET_DIR` moves the socket directory (the end-to-end test runs a private bridge this way).
`LOCAL_STUDIO_BROWSER_CLIENT_NAME` overrides the tab group label.

## MCP tools

| Tool | Does |
| --- | --- |
| `status` | connection, permission mode, allowed sites, your tab group and its tabs; never fails |
| `tabs_context`, `tabs_create`, `tabs_close`, `tabs_select` | your own background tabs |
| `tabs_show` | bring a tab in front of the user (the only tool that changes what they see) |
| `navigate` | open a URL, or go back/forward |
| `read_page`, `find`, `get_page_text`, `get_page_html`, `screenshot` | read the page |
| `click`, `hover`, `type`, `press`, `fill`, `scroll`, `drag`, `actions` | act on it; all but `hover` return `changes`: new refs and what changed or went |
| `run_js`, `wait`, `read_console`, `read_network` | scripts, waits (for text, a selector, or `until: "settled"`) and debugging; input tools wait up to 2.5 s for the page to settle |
| `handle_dialog` | answer an alert, confirm or prompt box; while one is open, other calls fail at once with `dialog_open` |
| `capture` | evidence from the agent's own tab as files under `~/.local-studio/browser/captures`: a redacted HAR (`network_start`/`network_stop`), a WebM recording (`record_start`/`record_stop`), the last minute of video (`flight_start`/`flight_save`); `status`, `cancel` |
| `library_add`, `library_search`, `library_cite` | the source library (`local-studio-browser library`) |

**How much a read returns.** Each read tool answers with a bounded part and says when it cut, with the call that reads on, so one page can't fill an agent's context: `get_page_text` and `get_page_html` 50,000 characters (a PDF tab by pages), `run_js` values 50,000 (an `offset` reads on from the value kept, without running the code again) and `page_markdown` 40,000, all with `offset`; `read_page` 300 elements and 3,000 characters of text; `read_console` and `read_network` the newest 100 entries at 2,000 characters each, older ones by `offset` (after `clear` they are gone, and the note says so); `crawl` 3,000 characters a page; `files` `read` 50 KB of text (up to 200 KB with `max_bytes`) and `offset`, cut on a character boundary. No tool result is longer than 100,000 characters.

Every tool documents its parameters and includes an example in its description. The server's instructions tell the
agent that page text is untrusted data and that it must ask before acting under the
user's sign-in. With no browser connected, every tool returns: "Local Studio isn't connected.
Ask the user to open Helium/Chrome with the Local Studio extension loaded, or run
`local-studio-browser doctor`."
