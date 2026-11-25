# Changelog

## [Unreleased]

### Added
- One list of chats with the Local Studio app. Side panel chats are threads in the app and go on in either place; the app's threads are in Past
  chats. Settings > Privacy > "Same chats in the Local Studio app" turns it off. Decision D75.
- Agents can open a settings page for you (`open_settings`) and give you buttons that open an app, a file, a folder or a page of your computer's
  settings, or run a Shortcut, when you click them (`offer_buttons`, or a `localstudio:` link in the panel agent's answer). Decision D74.
- Synthetic is a provider. Every key field links to the page where that key is made.
- Ask an agent to change how a site looks, and it stays that way. "Make x.com dark", "bigger text on Reddit" or "hide the sidebar here": the
  agent saves it with `site_edit` (new: `style`, `dark` and `update`), open tabs follow at once, and the side panel shows one card with Undo and
  Keep. A style can't load anything, add text or hide itself (`src/site-edits/style.ts`). The side panel's own agent has it too. Decision D73.
- Change this site takes one click. It is on an empty chat, under More and on a page's right-click menu, and opens switches for Dark and the site's
  ready-made changes (YouTube, X, Reddit), Hide something, and every saved change with its own switch. Decision D73.
- Site changes are kept outside the browser, so a new profile starts with them. The helper writes `~/.local-studio/browser/sites.json`;
  `local-studio-browser sites` lists, turns off and removes them, and Settings > Sites exports and imports them. Scripts always arrive off.

### Changed
- Choosing a model and finding a past chat are full pages with a back arrow. The model page lists your recent models, then each connected provider
  with prices; details are one click away. Decision D76.
- Every settings section has the same look: grouped rows, the explanation one click away. The first screen and the settings have about a quarter
  fewer words. Decision D76.
- The side panel opens 141 KB lighter: viewers for slides and documents load when one is opened.
- Local Studio's service is found where Eukhe 0.10.74 and later listens.
- The side panel and Settings show less, and connecting a model is on the home screen. ChatGPT and GitHub Copilot plans, an API key and a model on this
  computer are one list with one button each; Settings is ten sections with each one's state on its row; skills are grouped by what they do. Decision D72.
- Site icons are drawn here. The panel no longer asks Google's favicon service which sites you open.
- The extension wears the Local Studio look and mark, and everything it installs has a Local Studio name. The command is `local-studio-browser`, the MCP
  server `local-studio`, the computer use helper `local-studio-computer`.
- Skills now come with the Local Studio app, and only from there. The browser's 42 skills are in the app's one store, with
  your own and your plugins'. `local-studio-browser skill` and all its commands are gone: use `local-studio skills list`, `search`,
  `read` and `create`. An update no longer touches the copies an earlier version installed in Claude Code, Codex or
  OpenCode; they stay as they are. `kyraskillmaker` is gone (`@create` and `local-studio skills create` write a skill).
  The setup prompt installs no skills. Decision D71.
- Releases now come from baney75/local-studio, and the install command has a new address there.
  A release is the tag `browser-v<version>`; the `browser` release always holds the newest installers. `local-studio-browser update` reads those tags.
  Versions up to 1.4.1 stay at baney75/local-studio, and a downloaded one is still checked against that repository's attestations. A checkout may
  be the `browser/` folder of local-studio; one of baney75/local-studio keeps updating from its own remote.

## [1.4.1] - 2026-11-25

### Added
- The first time computer use lands on an app, its result names the skills you have for that app. Same limits as for a
  site, below. Test: `cli/test/skill-lines.test.mjs`.
- An agent's first look at a site names the skills you have for it. At most three names, once per site in a session, and
  the result waits at most 300 ms for them. Nothing is looked up for a page in an incognito window. Tests:
  `cli/test/skill-lines.test.mjs`, `test/private-page.test.mjs`.
- Sign in without giving an agent your password. An agent that reaches a sign-in form can ask for it (`tabs_show` with `username_ref` and
  `password_ref`), and a small window pops up that names the site and takes your username and password. They go straight into the page's
  fields; the agent is told only that they are in, and its page reads leave those fields' values out. The window takes no focus, and the panel's card opens it too. Needs https, or a page on
  this computer (D69). Tests: `test/sign-in.test.mjs`, `cli/test/e2e-panel.test.mjs`.
- PRIVACY.md names every host the code contacts by itself or on request, when, and how to turn it off where there is a switch. It also says the
  chat copy for coding agents is on by default, and which other agents' settings files the helper opens. `test/privacy-hosts.test.mjs` fails when code
  names a host the policy doesn't, and when the policy names one nothing here contacts. Settings > Privacy says the copy is on by default and is not uploaded.
- The side panel shows what an agent is waiting on (a site to open, files to upload) as a card above the chat, with the
  same buttons as Settings > Agents, which draws the same card. A remote session's questions come up in those two places only. Two agents
  asking at once both get a card, a card takes no click for half a second after it comes up or another card goes, and a question left by an earlier worker, which nothing could answer, is cleared. Test:
  `test/agent-asks.test.mjs`.
- A remote session (through `local-studio-browser serve`: a web connector, a token, a hub) is never in Yolo: under Yolo it gets
  Auto's rule, and it can't answer its own question, allow a site or change the mode. Every bridge step in the
  Runs log records the mode it started under. A session from an older CLI counts as remote when `serve` named it. Decision D67. Tests: `test/permission-guard.test.mjs`, `test/dialog-preset.test.mjs`,
  `cli/test/model-tier.test.mjs`.
- An agent over the bridge can't put text into a password or payment field, in any permission mode. `type`, `fill` and a
  press of a character are refused where the text would go in, and the agent is told to open the sign-in window for a password, or show you the tab for a payment.
  Text is also refused when Local Studio can't tell which field would get it. A script (`run_js`) isn't checked. Decision D67. Tests: `test/dialog-preset.test.mjs`,
  `test/permission-guard.test.mjs`, `cli/test/e2e-bridge.test.mjs`.
- Settings > Privacy has a switch that stops the model detail lookup on models.dev. The lookup (the public
  table at `https://models.dev/api.json`, when the copy is a day old, only while a key is saved for a provider that lists
  its models) had no off switch. Off, `loadMetadata` in `src/models/registry.ts` never fetches it. Test: `test/models-dev-switch.test.mjs`.
- Agents get Linux guests on your Mac that reset to clean in under a second.
  `local-studio-browser vm up linux` starts one; `exec`, `shot`, `reset`, `down` and `list` work it. `vm/mac` is `local-studio-vm`, a windowless Virtualization.framework helper (no Dock icon, no focus changes) signed ad hoc
  with the virtualization entitlement. The guest is Debian 13 arm64, pinned by SHA-512, on an APFS clone, set up by
  cloud-init with no users and no SSH, and reached through a vsock agent. The first boot saves a ready point (machine
  state plus a disk clone); `reset` restores it, `down` saves the session and `up` resumes it. A gate checks power, RAM,
  disk (5 GB at least) and load before `up`. `vm shot` saves the guest's console framebuffer as PNG.
  `scripts/vm-bench.mjs` measures it against the #28 targets (a rerun of D66's numbers is owed).
  Decision D66. Tests: `cli/test/vm.test.mjs`.
- Agents can now filter a site's feed for you, by topic or account, on every visit. Ask "hide every post about crypto
  on x.com" and the new `site_filter` MCP tool saves words, phrases, `/regex/` terms and account handles for a site; posts that match are hidden
  with a class and a stylesheet (never removed), new ones too as you scroll, and a count on the page ("12 hidden by your
  filter") shows them on a click. Built-in post finders for x.com, YouTube (the word Shorts hides Shorts), Reddit, Hacker
  News, Bluesky and LinkedIn, `article` elsewhere, or an `items` selector. It is a new `filter` site edit, so Settings >
  Sites lists it with a switch and `site_edit` lists and removes it. The extension's own content script
  (`src/site-edits/feed-filter.ts`, registered per site in `apply.ts`) does the work, so no user-scripts switch is
  needed. Decision D64. Tests: `test/feed-filter.test.mjs`, `cli/test/e2e-feed-filter.test.mjs` (2,000 posts, every
  batch under 50 ms; 15 to 17 ms measured).
- Computer use works on Linux: `local-studio-computer` reads and acts on native apps in the background. `hands/linux` is a static Rust helper (x86_64 and aarch64, musl) that speaks the hands protocol over AT-SPI. Windows come from Hyprland, Sway or an X11 EWMH window manager; GNOME and KDE under Wayland get AT-SPI alone, and the helper says what that leaves out. Pictures use grim on wlroots and X11 capture otherwise. It never sends physical input: `drag`, right clicks and keys with no accessibility meaning answer `not_supported`. On Sway an opened app and its dialogs go straight to the `local-studio-agent` workspace without focus, by rules that name a security-context id made for that launch (on Sway before 1.10, a pid the helper holds until Sway exits, where `flatpak run` and `snap run` are refused); on X11 focus goes back to the person's window. Access is `hands.json` in Local Studio's config folder (`read_only`, `default`, `full`, and the apps an agent may start; a file that won't parse means Read Only), and browsers, mail, chat and password managers are never started for an agent, even behind `env` or `flatpak run` (`needs_sandbox`). An agent's app gets a D-Bus session bus of its own, so the person's later launch of the same editor opens their own copy, and under Default a picture is refused when another window could show in it. A connector's helper now also gets the desktop's variables (`connectorHelperEnv` in `cli/src/computer.ts`), and the instructions no longer say Mac. Decision D63. Issue #27. Tests: `cli/test/hands-linux-live.test.mjs` (every verb on a GTK fixture, the person's focus and typing, and `local-studio-browser mcp` end to end), the conformance suite against the binary at each access mode, both in `.github/workflows/hands-linux.yml` under Xvfb with openbox and headless sway; `cli/test/computer.test.mjs`.
- Computer use now looks for Local Studio's own helper, `local-studio-computer`, and `local-studio-browser doctor` names it. The wire any helper speaks is written down in `docs/hands-protocol.md` (verbs, schemas, envelopes, the `--connector` cap), and `cli/test/hands-conformance.test.mjs` checks a helper against it: in CI against a fake helper, and against broken copies of the fake that it must fail (a missing verb, a connector that answers as local, gets Full Access or may move windows). `computer.ts` looks in `LOCAL_STUDIO_COMPUTER_BIN`, `local-studio-computer` on PATH, `~/.local/bin` and `Local Studio.app`; a connector helper must answer as `local-studio-connector`. `computer_status` names the helper that answered, and with none says so. Issue #27. Tests: `cli/test/computer.test.mjs`, `cli/test/hands-conformance.test.mjs`.
- Computer use works on a Mac with nothing else installed: a release installs `local-studio-computer` in `~/.local/bin`. The darwin archive carries it as `bin/local-studio-computer` (covered by `SHA256SUMS` and the attestation), `local-studio-browser install --release` copies it to `~/.local/bin`, and `local-studio-browser doctor` names it. It is signed ad hoc with the hardened runtime, with no Developer ID yet, so a person who allowed `local-studio-computer` itself in Accessibility allows it again after each update; the installer says so when the helper changed. Without the grant, `computer_status` names the program macOS checks (the app the helper runs under, such as Terminal) and the System Settings steps to allow it, through the helper's new optional `hands/grants` method. The engine is now linked in statically, because library validation refuses an ad hoc library. CI builds, signs and checks it on a macOS runner (`.github/workflows/hands-mac.yml`), and the release workflow builds it there for the darwin archive. Decision D68. Tests: `cli/test/release-install.test.mjs`, `cli/test/computer.test.mjs`.
- Computer use for macOS, `local-studio-computer`, in `hands/mac/` (issue #27). `local-studio-computer mcp [--connector]` speaks `docs/hands-protocol.md` and passes the conformance suite. It starts apps as separate background copies and counts their windows as the agent's. Access is Default or Read Only, never Full Access, and it has no window-manager verbs. Build: `hands/mac/scripts/build-engine.sh` then `swift build -c release`, or `hands/mac/scripts/package.sh` for the signed release copy.
- The market comparison is now published: `docs/market.md` shows Local Studio against agent-browser, browse, Chrome DevTools
  MCP and Playwright MCP. Task success, cold start, first page text, click and fill medians, install time from nothing
  and install steps, with the date, machine and versions. `evals/market/page.mjs` builds it from the runs kept in
  `evals/market/published/`, and `test/market-page.test.mjs` fails when the page and those runs disagree. New: a Chrome
  DevTools MCP adapter and `evals/market/rivals/install-time.mjs` (#30).
- `local-studio-browser remote setup` now makes a free relay on your own Cloudflare account, with no domain. With no route named it no longer asks Tailscale or Cloudflare; it signs you in to Cloudflare in your browser (Cloudflare's `wrangler` 4.163.0 through `npx`), deploys the relay Worker as `local-studio-browser-relay` (`--relay <name>` picks another, `--account <id>` the account; a relay of that name another computer set the key of is left alone unless you name it), and sets a new relay key as the Worker's secret. If the account has no workers.dev subdomain, it opens the page to pick one and waits. It prints the `https://<name>.<subdomain>.workers.dev` address and checks that `/v1/health` through the relay comes back from serve. `remote status` shows the connector's state, `remote fix` restarts it, and `remote off` removes it and says how to delete the Worker. Tailscale (`--tailscale`), a Cloudflare tunnel on your domain (`--cloudflare`) and `--tailnet` stay as options. Decision D70. Tests: `cli/test/relay-remote.test.mjs` (wrangler is a stand-in; nothing reaches Cloudflare).
- `local-studio-browser remote relay run` connects this computer to a relay Worker on your own Cloudflare account. It is the relay route's service (`com.localstudio.browser.relay`, `local-studio-browser-relay.service`), the way `remote cloudflare run` runs cloudflared: it dials `wss://<relay>/_relay/connect` with the relay key from `remote.json` and carries serve's MCP and OAuth paths and `/v1/health` to `127.0.0.1:<port>`, nothing else. The connector is vendored from baney75/local-studio-tunnels (`cli/src/relay-client.ts`, the source commit in its header, its SHA-256 pinned by `cli/test/relay-vendor.test.mjs`). It writes its state (`connected`, `disconnected`, `unauthorized` and so on) to `relay-state.json` for `remote status`, and stays up in a state it won't retry, so the service doesn't restart it into the same refusal. serve now answers `GET /v1/health` with `{"ok":true}`. Tests: `cli/test/relay.test.mjs` (a local stand-in relay carries a request to a real serve and back).
- The side panel's remote access screen has one button to set up your own relay. Settings > Agents > "Use Local Studio from Claude, ChatGPT and Grok" now puts "Set up my relay" first: it shows the terminal command with a copy button, moves on by itself once setup saves the route, and then shows the connector's live state (connected, disconnected, unauthorized, replaced, outdated or stopped) with the command for the ones the connector can't leave by itself. The helper reports the state and never the key. Tailscale and Cloudflare stay below it. Tests: `test/connect-panel.test.mjs`, `cli/test/connect-remote.test.mjs`.

- The market eval now scores which agent actions Auto should ask about: 59 of 59 risky ones caught. Auto's rule
  list is one file, `src/bridge/risk-rules.ts`: risky actions (send, post, buy or pay, delete or cancel, change
  account settings or access, grant OAuth, download a program to run), sensitive sites (mail, banks and payments,
  password managers, cloud consoles and DNS, government, health, account settings pages), sensitive apps for
  computer use, and the password and payment fields no mode may type into. `evals/market/risky-actions` holds 86
  labeled actions; recall on the 59 risky ones is the new `riskyActions` floor in `evals/market/floors.json` (100%),
  and 0 of the 27 safe ones are flagged. Decision D67. Issue #33. Tests: `test/risk-rules.test.mjs` (one per rule).

### Changed
- A site skill's domain patterns are matched by a small matcher of our own (`src/storage/stores/domain-match.ts`) whose time is bounded by the pattern and the address, and a pattern over 256 characters or past a skill's first 100 matches nothing. `*`, `**` and `?` mean what they did; `{a,b}`, `[ab]` and `!(a)` are now plain text, so list each address instead. The `minimatch` dependency is gone. Test: `test/transcript.test.mjs`.
- In Auto, an agent on a frontier model now asks before it opens a sensitive site (mail, a bank or payments, a password
  manager, a cloud console, a government or health site, a site's account settings pages), unless your allowed sites
  cover it. A sensitive site's frame on another page isn't read without that either. Where a clicked link or a redirect
  leads isn't checked, in Manual either. Ordinary sites open as before, Manual and Yolo are unchanged, and a remote
  session under Yolo gets this rule too. Decision D67. Test: `test/permission-guard.test.mjs`.
- The extension is named Local Studio. Its manifest name, toolbar title, side panel, settings, onboarding and setup prompts
  say so, and where the text means the desktop program it says the Local Studio app. The extension ID, commands, MCP
  names and folders don't change here. Issue #104.
- Agents' tab groups say "Local Studio · ...", and groups an earlier version made under its old name are still found and
  tidied; a resumed session's own group takes the new name. The assistant's own prompt, the notes and errors agents read from the extension, and the name the ChatGPT
  sign-in shows say Local Studio too. Test: `test/browser-session.test.mjs`.
- The helper's own text (setup, remote setup, pairing, update, service, sessions, the community catalog and errors) says
  Local Studio. The `local-studio-browser` command, the MCP name, environment variables and folders don't change here. Issue #104.
- Messages about missing computer use name Local Studio's own helper, `local-studio-computer`, and how to get it on that OS. `computer_status`, `local-studio-browser doctor`, `link --scope computer.*` and a hub's refusal named another app. `handsHowTo` in `cli/src/computer.ts` writes the line.
- Local Studio opens in its dark look until you pick Light or Match system in Settings > Appearance. The side panel, its first frame and the in-use veil on agents' pages all follow it. Before, nothing saved meant Match system, so a Mac in light mode got a white panel; that choice is now stored by name, and anyone who never picked one gets dark. Tests: `test/appearance.test.mjs`.
- Site access is now a permission mode: Manual, Auto (the default) or Yolo, in Settings > Agents. Manual is the
  old "Ask before opening a new site", Yolo the old "Always allow", and Auto keeps "Match the model" (frontier models
  open ordinary sites, small or unknown models ask). A stored setting moves to its new name on update; an install
  that never chose one is Auto, with a one-time notice in the side panel and a Switch to Manual button. The mode is
  one store (`permission_mode`), for computer use and VMs to read too; `permission.setMode` and `status` take and
  report the new names (`mode`), and still take and report the 1.4.0 ones for an older CLI. Decision D67. Issue #33.
  Tests: `test/permission-modes.test.mjs`, `test/site-access-by-model.test.mjs`.
- Clicks, fills and page loads answer faster: an action no longer waits out a hidden tab's 50 ms input hold. While an agent acts, its tab draws (a 1x1 screencast that stops 3 s after the last action), so Chromium's `DeferRendererTasksAfterInput` hold ends at the next frame. The settle after an action returns at the drained look (`IDLE_MS` and `LOADED_QUIET_MS` are 0) and counts `Page.frameRequestedNavigation` as a reaction. The change report's look, fill and locate scripts are installed once per document and called by a salted key, so V8 no longer recompiles 15 to 25 KB per call. A click on a download link waits for the download to begin (at most 1 s), and a recording takes over the tab's frame-keeping cast. The tab's activity pill is put up while the action finds its target, not before; the first input still waits for it. `LOCAL_STUDIO_BROWSER_TRACE=1` records per-hop times. Decision D62. Trace: `docs/verification/speed-trace.md`.
- Ask an agent to check a past thread or session and it runs the rsi loop on it. The `rsi` skill now says to
  read the whole thread and rank a "done" the user later disputed above any tool error, to move a lesson that
  was already written down but happened again into the skill or check the agent has open at that moment, and to
  change a skill from another source in its own repo. Router cases in `skills-eval/` cover thread checks.
- The `skill-judge` CI job lets a pull request rename a skill: a base router case may carry the new name when `skills-eval/accepted-drops.json` records the rename under `renamed` (`from`, `to`, `reason`), the old skill is gone and the new one is new. The new name keeps the old accuracy floor. Any other removed or relabeled case still fails.

### Fixed
- A request that reuses an idle connection to `serve` or the hub no longer fails now and then. Node closed an idle connection after 5 seconds,
  while a tunnel keeps its own for about 90 and sends the next request down it, so one that went out as Node closed it came back as a 502. Both now
  keep an idle connection for 2 minutes. Tests: `cli/test/remote.test.mjs`, `cli/test/hub-hardening.test.mjs`.
- A hand-back an agent already gave up on no longer shows its card. A cancel or a disconnect that came before the hand-back, or while it looked its tab up, found
  nothing to end and the card waited 10 minutes for nobody. A run in the Runs view no longer says "Running" for good after its agent left in the middle of a call: the
  call's answer is logged as a step of the ended run (#52). Tests: `test/handback-worker.test.mjs`, `test/runs.test.mjs`.
- `read_page` right after a page opens now holds a cross-site frame (a payment form) that arrives a moment later. It waits for a frame it
  first saw under a second ago, and starts no new look after a second; a frame that still hasn't arrived is listed as "not loaded yet". The market
  task `t05-iframe` missed the form in 2 of 3 runs on a Mac (#75). Tests: `test/frames.test.mjs`, `cli/test/e2e-bridge.test.mjs`.
- A click that opens a new tab reports it on a slow machine too. The report waited only for the page to go quiet (300 ms), and under heavy load the new
  tab joined the session after that: the answer had no `newTabs` and said nothing happened. It now waits for the tab, at most 2 seconds from the moment the
  page opened it, and only when the page opened one (#75). Test: `test/new-tab.test.mjs`.
- Local Studio no longer adds CORS headers to the responses of api.anthropic.com, api.z.ai or a custom provider's host
  (`static/cors-rules.json` and the dynamic rules are gone, and each worker start takes away the saved ones). The side
  panel's own requests go out under the extension's host permissions and never needed them. Test: `test/provider-cors.test.mjs`.
- After the one-command install, typing `local-studio-browser` runs the release you just installed. Before, nothing put `local-studio-browser` on PATH, so every printed `local-studio-browser <command>` failed with "command not found", and a `~/.local/bin/local-studio-browser` left from a dev checkout kept running that old code. `local-studio-browser install --release` now links `~/.local/bin/local-studio-browser` to `~/.local/share/local-studio-browser/release/local-studio-browser`, which follows every later install. A link to a Local Studio program (an older version, a checkout's or npm's `cli/dist/index.js`) or to nothing is repointed; anything else is asked about in a terminal (default no) and otherwise left, with the `ln -sf` command printed. It says when `~/.local/bin` isn't on PATH, with the line for your shell, or when another `local-studio-browser` comes first. `install.sh` ends with `local-studio-browser setup` when that name reaches the release, else the full path. macOS and Linux. README's Platforms section now says the Linux computer-use helper exists. Tests: `cli/test/path-link.test.mjs`, `cli/test/release-install.test.mjs`, `test/install-script.test.mjs`.
- JavaScript run in a page (`browserjs` in the side panel, `run_js` over the bridge) runs apart from the page's own
  scripts on the debugger path too, as it does with the user scripts permission: in an isolated world made for it
  (`src/browser/inject.ts`), with its messaging only there. Before, without that permission it ran in the page's own
  world. `run_js` with `world: "main"` still reaches the page's globals. Tests: `test/inject-world.test.mjs`,
  `cli/test/e2e-bridge.test.mjs`.
- Feed filters (`site_filter`) match words in Chinese, Japanese, Thai and other scripts written without spaces: `比特币` now hides "今天比特币大涨", and a mixed word like `AI芯片` still needs a word edge before its "A". Two more kinds of `/regex/` that could freeze a page are refused when saved, a repeated choice like `(a|a)+` and more than one open-ended repeat like `.*.*.*z` (one, as in `/moon+/` or `/\bcrypto\w*/`, is fine); `riskyPattern` in `src/site-edits/feed-match.ts` replaces `nestedQuantifier` and says which shape it found. A handle now means the post's author only: on Bluesky the feed item's own `feedItem-by-` name, and on other sites (Mastodon included) the first account link in a `header` or with `rel=author`, else the first account link, so a post that mentions, replies to or quotes an account is no longer hidden by a filter on it. Tests: `test/feed-filter.test.mjs`.
- An agent never opens the approval page at an alias address either: the `aliases` in `remote.json` are guarded like its `publicUrl`, and a bad entry in the file no longer leaves the good ones unguarded. Test: `cli/test/guarded-hosts.test.mjs`.
- The one-command install no longer stops when the GitHub CLI is installed but not signed in. `gh attestation verify` needs a token, so a signed-out gh can't check: `scripts/install.sh`, `scripts/install.ps1` and `local-studio-browser install --release` now ask `gh auth status --hostname github.com` first (its exit code only; `GH_TOKEN` or `GITHUB_TOKEN` counts as signed in) and, when it fails, check `SHA256SUMS` only and say gh is installed but not signed in and that `gh auth login` turns the check on. The scripts then run the release's program with `LOCAL_STUDIO_BROWSER_GH=none`, so an older release's program doesn't try the check either. A signed-in gh that refuses an artifact still refuses the whole install. `ReleaseCheck.attestation` gains `gh-signed-out`. Decision D61. Tests: `test/install-script.test.mjs`, `cli/test/release-install.test.mjs`.
- The bridge checks the socket folder itself before using it or changing its mode: it must be your own real directory, and a link in its place is refused. Test: `cli/test/legacy-socket.test.mjs`.
- ChatGPT sign-in, sign-out and the model list give up when OpenAI doesn't answer, instead of waiting on it. The discovery, signing-key and model requests stop after 15 seconds; sign-out's requests share one 10-second limit, and the sign-in on this computer is cleared either way. Test: `test/subscriptions-host.test.mjs`.
- Update settings (`update.json`), the staged update's record and the list of agent aliases are written whole or not at all, so a save that fails leaves the old file in place. Tests: `cli/test/update.test.mjs`, `cli/test/agent-migration.test.mjs`.

### Removed
- The waitlist and hosted-tunnel handling in `local-studio-browser remote setup`, `remote setup --json` (`state`, `step`, `waitlist` and `localStudio`; `remote status --json` keeps its own `localStudio`), the route record and the connector skill. Nothing in Local Studio has a waitlist or a hosted tunnel. A `local-studio` whose `tunnel setup` answers JSON and fails, including an old build that still gates it, is now a refusal with code `local_studio`: update Local Studio, or use the relay. A tailnet route such a build left to Local Studio stays its own. A route record may name `cloudflare` or `tailnet`. Tests: `cli/test/one-tunnel.test.mjs`.
- The skill router, its eval and the community skill catalog are gone; Local Studio serves skills now. Removed with them:
  `skill match`, `enable`, `sync`, `catalog`, `edit`, `apply`, `rollback`, `versions`, `write`, `test`, `submit` and `eval`, the
  community section in Settings > Skills, and the `router-worker.js` the helper shipped. `skill install`, `list`, `print`,
  `lint`, `revert`, `remove` and `refresh` stay, and a local edit you already have is still used. Tests:
  `cli/test/skill-platform.test.mjs`, `cli/test/skill-lint.test.mjs`.
- Computer use runs only its own helper, `local-studio-computer`; it no longer looks for another app's.

## [1.4.0] - 2026-11-21

### Added
- One tunnel per computer, shared with the Local Studio app. When the app runs the tunnel, `local-studio-browser remote setup` defers to it, and `remote join [--json]` reads its route record. `remote setup --tailnet` is a tailnet-only route through `tailscale serve`. Guide: `docs/remote.md`.
- Install Local Studio's helper with one command on macOS, Linux and Windows (#44). `curl -fsSL https://github.com/baney75/local-studio/releases/latest/download/install.sh | sh` in a terminal, or `irm https://github.com/baney75/local-studio/releases/latest/download/install.ps1 | iex` in PowerShell. `scripts/install.sh` (POSIX sh) and `scripts/install.ps1` fetch this computer's archive and `SHA256SUMS` from the latest release (or `LOCAL_STUDIO_BROWSER_VERSION`'s), stop on a SHA-256 mismatch, run `gh attestation verify` when the GitHub CLI is there and say so when it isn't, then run the release's own `local-studio-browser install --release`. No sudo; they refuse root or an elevated PowerShell unless given `--allow-root`. `release.yml` attests both scripts, lists them in `SHA256SUMS` and uploads them with every release (`scripts/package-release.mjs`). The command strings live in one module, `src/install-command.ts`; README.md and `store/listing.md` quote them, and `test/install-command.test.mjs` fails when a copy drifts. `test/install-script.test.mjs` runs both scripts against a local stand-in for the release pages (install.ps1 in the `cli-windows` job). CI's `clean-install` job now installs with the README's one command from a local copy of the just-built release (the scripts' test-only `LOCAL_STUDIO_BROWSER_INSTALL_BASE_URL`, loopback only), loads the extension and reads a page; it also runs the by-hand steps and shellchecks install.sh.
- The welcome screen shows the command that installs the helper, and turns to connected once it runs. When no helper answers, the first-run welcome shows the one command for this computer's OS with a Copy button (`helper-setup`, `src/components/HelperSetup.ts`, in the Connect tab's command box and online dot). The background worker writes whether a helper has talked to `chrome.storage.session` (`src/bridge/host-state.ts`), so the welcome changes to "Helper connected" with no reload. A store copy connects only once `STORE_EXTENSION_ID` in `cli/src/install.ts` holds its id; until then the helper's host manifest doesn't list it and the welcome keeps showing the command.
- Give any tab to Local Studio from its page menu or the toolbar icon's menu, and take it back with Continue. "Give this tab to Local Studio" opens a new panel chat on that tab; "Give this tab to <agent>" puts it in that agent's group and tells the agent in `tabs_context`. An agent that needs you (a sign-in, a code, a payment) calls `tabs_show` with `wait:true` and a reason: nothing takes focus, the page's pill and the panel show Continue, the toolbar badge counts it, and the call returns when you press Continue (10 minute limit). Decision D58. Tests: `test/handoff.test.mjs`, `test/handback.test.mjs`, the issue 45 cases in `cli/test/e2e-panel.test.mjs`.
- A Runs view in the side panel shows every agent run, live: running, waiting on you, done or failed. Each run lists its tab and its steps (tool, target, result, time), and a step opens to its change report. Bridge requests and the panel's page tools are recorded; the panel's own navigate and REPL tools are not yet. The log stays in extension storage (`runs_log`), capped at 25 runs, 80 steps each and 1 MB (src/runs/). Tests: `test/runs.test.mjs`.

### Changed
- Agents on frontier models now open any site without asking; small and unknown models still ask first. The new default site access mode, "Match the model" (`by_model`), is the first choice under Settings > Agents > Site access; a stored "Ask before opening a new site" or "Always allow" keeps working as before. `local-studio-browser mcp` reports its model's tier in the bridge hello: the model in `LOCAL_STUDIO_BROWSER_MODEL` classified by `cli/src/model-tier.ts`, else frontier for Claude Code and Codex, small on the small tool profile, and unknown for everyone else and for older CLIs. Frontier means about 75 or more on Vals.ai SWE-bench Verified; a model under 100B parameters is small. Local Studio's own pages, guarded hosts, the approval page, local services and upload questions are refused or asked as before in every mode. `local-studio-browser status` names the mode. Decision D60. Tests: `cli/test/model-tier.test.mjs` (the 45 names the app's Rust copy also gives), `test/site-access-by-model.test.mjs`.

## [1.3.0] - 2026-11-21

- The extension has its own ID, `igjafcggmahiboobmnhfkndodphjdnhg`, from a manifest `key` (public key only; the private key was deleted unread), and its own native host, `com.localstudio.browser`. The ID lives in `src/bridge/extension-id.json`, which the CLI and every test read.

The rest of 1.3.0 and older versions: the release pages at https://github.com/baney75/local-studio/releases.
