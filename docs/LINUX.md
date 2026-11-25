# Local Studio's browser and computer use on Linux

These tools have to cover Linux as well as macOS. This page says what works on Linux today and what is
missing. It is measured, not assumed: the probe below was run on a Linux host (Omarchy, Hyprland,
x86_64) on 2026-11-16.

## Works today

| Part | State on Linux | How it was checked |
| --- | --- | --- |
| Extension build | `npm run build` writes `dist-chrome/` | built on this host |
| Extension in Chromium | loads unpacked with `--load-extension`, headless (`--headless=new`) | probe below, Playwright Chromium |
| Extension in Helium | loads the same way in Helium 0.17.2.1 (Chromium 153); 4 of 5 probe runs passed, and the first run's `navigate` returned a tab before its page committed (empty URL), so `get_page_text` read nothing | probe below with `TABKYRA_E2E_CHROMIUM=~/.local/bin/helium` |
| Native host registration | `tychicus install` writes the host manifest for Helium, Chrome, Chromium, Brave, Edge, Vivaldi and Opera under `~/.config` (`cli/src/install.ts`) | the probe's throwaway profile |
| CLI | `tychicus` and the old `polycarp-browser` alias run | `tychicus --help`, `polycarp-browser --help` |
| MCP server | `tychicus mcp` on stdio; browser tools work end to end | probe below: one `navigate` and one `get_page_text` |
| Unit tests, lint, types | `./check.sh` passes | this host and CI (`ubuntu-24.04`) |
| End-to-end and DOM benchmark | `npm run test:e2e`, `test:e2e:panel` and `bench:dom` in `cli/` | CI's `e2e` job on `ubuntu-24.04` |

## Missing

- **Native app control (computer use) is a separate build.** The `computer_*` tools come from
  `tychicus-hands`, built from `hands/linux` and put in `~/.local/bin` (`hands/linux/README.md`). Without it an
  agent drives web pages only, and `computer_status` says how to get it.
- **No GUI driver for the browser's own windows.** Helium's dialogs and windows outside a page
  (native file pickers, permission sheets) have no driver on Linux; the extension reaches page
  content only.
- **No packaged install.** There is no Linux package or app bundle. Linux installs from source
  with the steps in the README.
- **Native messaging to the Eukhe daemon** (the Local Studio plugin design) is not built on any
  platform yet.

## The probe

```bash
npm run build && (cd cli && npm run build)
node cli/test/headless-probe.mjs
```

It loads `dist-chrome/` into a throwaway headless Chromium profile, lets the extension spawn the
native host, connects a real MCP client to `cli/dist/index.js mcp`, opens a local page and reads it
back. It sets its own `HOME` and socket folder, so it never touches an installed browser or bridge.
The harness starts `cli/dist/index.js mcp` by path, not as `tychicus`, so the server reports the old
name `polycarp`; `tychicus mcp` reports `tychicus`.

Output on this host:

```
$ node cli/test/headless-probe.mjs
platform: linux x64
browser: Playwright Chromium
mcp server: polycarp 1.1.10
mcp tools: 48
navigate: {"tabId":636001828,"url":"http://127.0.0.1:34817/probe/","title":"Probe","changes":{"page":"new page; read_page lists it"}}
get_page_text has heading: true

$ TABKYRA_E2E_CHROMIUM=~/.local/bin/helium node cli/test/headless-probe.mjs
platform: linux x64
browser: /home/baney75/.local/bin/helium
mcp server: polycarp 1.1.10
mcp tools: 48
navigate: {"tabId":454148282,"url":"http://127.0.0.1:39345/probe/","title":"Probe","changes":{"page":"new page; read_page lists it"}}
get_page_text has heading: true
```
