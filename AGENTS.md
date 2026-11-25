# Development Rules

This file is the source of truth for coding agents in this repository. `CLAUDE.md` points
here. Human contributors: see `CONTRIBUTING.md`, which follows the same rules.

## First Message
If the user did not give you a concrete task, read README.md first.

## Commands
- After code changes: run `./check.sh`. Fix all errors and warnings before committing.
- The user runs `./dev.sh` in a separate tmux session. Don't start `npm run dev`. Run `npm run build` only for bridge work, as "Bridge development" below says, or as `TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=<dir> npm run build` to build elsewhere without bumping the version in the checkout.
- NEVER commit unless the user asks.

## Testing
CI runs exactly these on every pull request (`.github/workflows/browser-ci.yml`). Run the ones
your change touches before you say it works:

```bash
npx biome check .                       # format and lint (./check.sh runs it with --write)
npx tsc --noEmit                        # extension types
node scripts/check-theme.mjs            # no hard-coded colors outside tokens and its allowlist
node --import tsx --test test/*.test.mjs  # extension tests
(cd cli && npx tsc --noEmit && npm test)  # CLI build and tests (npm test rebuilds cli/dist first)
node cli/dist/index.js skill lint skills  # the skill gate
(cd cli && node --test test/skill-lint.test.mjs)  # red-team tests for the lint
```

`(cd cli && npm run test:e2e)` drives the extension, native host and MCP server in a
throwaway headless Chromium, and `(cd cli && npm run test:e2e:panel)` draws the side panel in one. Both
run in CI as the `browser-e2e` job (with `bench:dom` below); run them after bridge, MCP or panel changes
(first time: `cd cli && npx playwright-core install chromium`).

`(cd cli && npm run bench:dom)` is the DOM benchmark: 44 hand-written pages (`cli/test/dom-bench/pages/`), each with a task an
agent would get, a `solve(t)` that uses only the MCP tools and finds every target by meaning (the `find` tool or a `read_page`
snapshot searched by role and label, never a selector or id, never `run_js` to act), and a `check(page)` that reads the app's
own state back through CDP. It shares its Chromium setup with the e2e test (`cli/test/e2e-harness.mjs`), runs in the `browser-e2e` CI job without `--time`, and writes `cli/test/dom-bench/last-run.json`. `floor.json` is the ratchet: `passing` ids must keep passing within
their `calls` ceiling (tool calls in `solve`; fewer tightens it), or the run exits 1. Wall time is reported; it gates only with
`--time` (ceiling max of 2000 ms and 3x the measured time), on a quiet machine, because load swings it several fold. `failing` holds each case the tools cannot do yet,
with the real reason; those are the tool improvements to make. A fix moves its case to `passing` (`node test/dom-bench/run.mjs
--update`, which refuses to drop a passing case), and nothing moves back. Do not simplify a page or switch a case to a selector
to make it pass.

A test that passed proves the logic, not what the user sees. Say which one you ran.

## Names that keep the old name
The product is Local Studio: the manifest name, toolbar title, side panel, settings, onboarding, debug page, model text and the extension's tool text say so.
The helper's output and tool descriptions still say Tychicus (issue #104), and `tychicus <command>` is the command the text gives. `test/product-name.test.mjs` fails
when "Tabkyra" appears in a user-visible string, when "Polycarp" does outside text about the Polycarp app or a legacy name (its `KEPT` list, or a line marked `product-name allowlist`; a `KEPT` rule or `POLYCARP_ALLOW` file that excuses no line fails it too), and when a renamed
identifier below comes back anywhere but its named fallback.

Renamed, with a fallback for installs made before the rename. The fallbacks stay until no supported helper, extension or hub
build predates the rename; then remove them in one change and lower the counts in `RENAMED_ALLOWED` (product-name test):
- the native host is `com.tychicus.browser` (`NATIVE_HOST_NAME`), Tychicus's own. Polycarp's names (`com.polycarp.browser`,
  `ai.tabkyra.bridge`) belong to Polycarp's helper: Tychicus never writes or asks for them (`test/native-host-name.test.mjs`).
- the socket folder is `/tmp/tychicus-bridge-<user>`, Tychicus's own. Hosts listen and clients look only there, never in
  Polycarp's `polycarp-bridge` or `tabkyra-bridge` (`cli/test/legacy-socket.test.mjs`). `TYCHICUS_SOCKET_DIR` replaces it.
- the hub headers are `x-polycarp-hub-scopes` and `x-polycarp-hub-caller`. A hub sends them under the old `x-tabkyra-hub-*`
  names too, because an older device reads only those and without a scopes header gives the caller its link token's whole cap;
  a device reads either, the new one first.
- `User-Agent` is `tychicus/<version>` (`USER_AGENT` in `cli/src/version.ts`).
- the npm package installs only `tychicus`. `polycarp` and `polycarp-browser` are Polycarp's commands; Tychicus never puts
  them on PATH (`cli/test/polycarp-coexist.test.mjs`).

These stay as they are on purpose, because agents, hooks or stored data depend on them, and no person reads them:
- every MCP tool name. The agent entry `setup` writes is `tychicus` (`MCP_NAME`), so Claude Code's qualified names are `mcp__tychicus__*`. A `polycarp` or `tabkyra` entry, and the permission rules that name it, are Polycarp's: never read, moved or removed
- the manifest `key`: it fixes the extension id, `igjafcggmahiboobmnhfkndodphjdnhg`, which `src/bridge/extension-id.json`
  holds for the CLI and every test (`cli/test/release-install.test.mjs` checks the key gives it). Never change the key: every
  installed host manifest allows only this id
- the helper's folders are `~/.config/tychicus`, `~/.local/share/tychicus` and `~/.cache/tychicus`, its launchers
  `tychicus` and `tychicus-host`, its services `com.tychicus.*`. Nothing writes under Polycarp's folders
  (`~/.config/polycarp`, `~/.local/share/polycarp`, `~/.cache/polycarp`) or the `tabkyra` ones Polycarp moves itself; the
  only migration is `remote import-polycarp` (`cli/src/import-polycarp.ts`), which reads them and copies the remote connector's files. Read variables through `envVar("NAME")` (`cli/src/env.ts`): `TYCHICUS_NAME` wins, then the inherited
  `POLYCARP_NAME` and `TABKYRA_NAME`. The config folder override is `TYCHICUS_CONFIG_DIR` (the inherited
  `POLYCARP_BROWSER_CONFIG_DIR` and `TABKYRA_CONFIG_DIR` still work, and test fixtures set them), never `POLYCARP_CONFIG_DIR`,
  which is the Polycarp app's.
- the extension's stored data: storage keys, database names and the `TabkyraAppStorage` class
- the names OpenAI lists for ChatGPT sign-ins made before a rename: those saved clients stay registered as "Polycarp" or "Tabkyra", so the unconfirmed-revoke note names them
- the tab group titles "Tychicus · ..." and "Tabkyra · ..." that earlier versions made, which are still recognized and tidied; new groups say "Local Studio · ...", and "Polycarp · ..." groups are left to Polycarp's extension
- the theme preset `tabkyra`, the npm package name `tabkyra` (`checkout.ts` finds a checkout by it), the bearer realm `tabkyra` and the keepalive alarm's name
Every command the CLI prints (`doctor`, `status`, errors, usage, services, the setup prompts) is built from `COMMAND_NAME` in `cli/src/self.ts`: `tychicus` for a release, an npm link or a plain checkout, `polycarp browser` when built into the Polycarp app's helper, and `polycarp-browser` or `tabkyra` when an older link starts it under that name. The extension's commands for this computer come from `hostCommand()` (`src/bridge/host-command.ts`), which reads the name from the helper's update status; build them when shown, never in a module-level constant. A prompt for another device (`deviceSetupPrompt`) carries no name: the agent there tries `tychicus`, then the release program. Write these strings as template literals; `cli/test/rendered-names.test.mjs` fails on a quoted string that holds `${COMMAND_NAME}`.
Skills under `skills/`, the docs and the README say Tychicus, and the browser skill is still `polycarp-browser` (install retires the `tabkyra` copy it wrote, and the router reads Tychicus, Polycarp and tabkyra as that skill); `docs/decisions.md` and `CHANGELOG.md` keep the names of their time.

## Inside Polycarp (single executable)
`cli/scripts/compile.mjs` builds `polycarp-browser` (Bun, bytecode) from the esbuild bundle with `TABKYRA_CLI_COMPILED=1`;
`cli/src/self.ts` is the one place that knows whether the program is compiled. In that mode launchers and the native host
manifest run the executable itself, the extension is read from `extension/` beside it, and inside the Polycarp app `polycarp update` updates it.
`spaces/scripts/build-browser.sh` builds both pieces and `bundle.sh` seals them in `Contents/Resources/browser`. Run
`cd cli && node --test test/compiled.test.mjs` after touching launchers, `install.ts`, `paths.ts` or the entry point.

## Code Quality
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- NEVER use inline imports (no `await import(...)`, no `import("pkg").Type`)
- Always ask before removing functionality or code that appears intentional

## Dependencies
- `@mariozechner/mini-lit`, `@mariozechner/pi-ai`, `@mariozechner/pi-web-ui`, `@mariozechner/pi-agent-core` are linked via `file:` to pinned upstream checkouts in `vendor/mini-lit` and `vendor/pi-mono` (gitignored)
- Changes to those packages require rebuilding them (the dev watcher handles this)
- If you need to modify upstream code, edit it in `vendor/pi-mono` or `vendor/mini-lit` directly and rebuild
- Changes to pi-mono that Tychicus depends on go in `patches/pi-mono.patch`, which `scripts/setup-siblings.sh` applies at the pinned commit

## Skills
Bundled skills in `skills/` run with the user's sign-in in every agent that loads them.
Treat a skill change like a security change.

- Write skills to the `kyraskillmaker` standard (`skills/kyraskillmaker/SKILL.md`):
  frontmatter with `name` (same as the folder), a one-line `description` that includes
  "Use when", then `## When to use`, numbered `## Steps` and `## Done when`.
- A skill folder holds `SKILL.md` and an optional license, nothing else. No scripts, no
  extra files, no symbolic links.
- Keep each skill to 150 lines and 8,000 characters (docs/decisions.md, D12; enforced by
  `tychicus skill lint`). Split longer material into its own skill.
- Every skill must pass `node cli/dist/index.js skill lint skills`. Fix the skill, never
  the lint, to make it pass. The rules are in `docs/skill-security.md`.
- Register a new skill in `cli/src/skills-catalog.ts` (import and map entry). A test fails
  when a folder under `skills/` is missing there.
- Skills describe attacks; they never quote them, not even in a code fence.
- Personal skills (anything with the user's own data) are never committed, pushed or
  submitted (D6).

## Changelog
Location: `CHANGELOG.md`

### Format
Use these sections under `## [Unreleased]`:
- `### Breaking Changes`
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

### Rules
- New entries ALWAYS go under `## [Unreleased]`
- Add to the existing subsection, never a duplicate one. Put the entry users most need to see
  first: the "What's new" card shows the first two entries of each section.
- NEVER modify already-released version sections
- Start each entry with one short sentence (under 110 characters) that says what changed for the
  person using Tychicus, in their words: "Settings tabs no longer leave one tab alone on a line."
  Details, file names, decisions (D12) and tests come after it. The side panel's "What's new" card
  shows only that first sentence (`digestReleaseNotes` in `src/update/logic.ts`), and a longer one is
  cut at its first colon, semicolon or parenthesis.

## Decisions
- `docs/decisions.md` records design defaults and the owner's answers (D1, D2, ...). Add
  an entry when you choose a default that changes the outcome; never rewrite an old one.

## Releasing
When the user asks to do a release:
1. Ask: major, minor, or patch?
2. Ensure `CHANGELOG.md` has entries under `## [Unreleased]`
3. Run `./release.sh <major|minor|patch>`

The script bumps the version in `static/manifest.chrome.json` and in `plugins/` (`scripts/plugin-version.mjs`), finalizes the changelog, commits, tags, and pushes. The tag starts `.github/workflows/release.yml`, which builds the `tychicus` program per OS (`scripts/package-release.mjs`), the extension zip and `SHA256SUMS`, attests each artifact and uploads them to the GitHub release; `tychicus install --release` checks both. minisign signing is not wired into it yet (the one-time key setup is in `docs/updates.md`).

## Local Studio plugins
`plugins/tychicus-browser` and `plugins/tychicus-computer` are Local Studio v0 plugins: `plugin.toml` with
`capabilities = []` (any capability fails Local Studio's loader), a skill, and a slash command. Their tools come from the
`tychicus` entry `install --local-studio` writes to Eukhe's `mcpServers`. A new file in a plugin must be added to `PLUGINS`
in `cli/src/local-studio.ts`, which embeds them. The skills carry `version:` in frontmatter for Local Studio; the skill lint
allows only name, description and license, so `cli/test/local-studio-plugins.test.mjs` lints a copy without that line.
Run `scripts/validate-local-studio-plugins.sh` after changing a `plugin.toml`: it compiles Local Studio's own loader
(`core/src/plugins.rs`) from a checkout (`LOCAL_STUDIO_CHECKOUT`, default `~/Projects/local-studio`) and loads both.
Tests that run `install` must give it a throwaway HOME and unset `XDG_CONFIG_HOME` and `XDG_DATA_HOME`: with those set,
it writes the real launchers and host manifests whatever HOME says.

## Brand
The mark is a pointer cut from a disc, in Local Studio's blue. `media/brand/build.mjs` draws every icon, mark, hero and
social card from one polygon and one palette; `media/brand/BRAND.md` lists what it writes and the palette's contrast
numbers, and `test/tychicus-logo.test.mjs` checks the copies match. Edit the script, run it, and look at the PNGs it
writes. Never edit those outputs by hand.

## Style
- No emojis in commits, code, or comments
- No fluff or cheerful filler text
- Technical prose only, direct and concise

## Git Rules
- NEVER use `git add -A` or `git add .`
- ALWAYS use `git add <specific-file-paths>`
- NEVER use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`
- NEVER use `git commit --no-verify`
- Include `fixes #<number>` or `closes #<number>` in commit messages when applicable

## Review and merge
- Every change goes through a pull request against `main`. CI must pass both jobs
  (`skills` and `check`).
- `.github/CODEOWNERS` requires the maintainer's review for `skills/`, the skill lint and
  its tests, the skills catalog, `.github/` (CI and CODEOWNERS), the CLI's build and
  package files, the setup prompt and `docs/skill-security.md`.
- Never weaken the lint, its red-team tests, CI or CODEOWNERS in a change that also does
  something else, and never without the maintainer's review. CI also lints with the base
  branch's lint, so a weakened lint fails anyway.
- Stacked pull requests merge in order (D8).
- Agents don't merge unless the maintainer asked for it in the task.

## Sign-in policy
API keys, plus subscription sign-ins only on a route the provider documents for third-party
apps, with Tychicus's own registration: Sign in with ChatGPT (open-source path) and GitHub
Copilot through the Copilot SDK (D28). Tokens stay in the native host, never in browser
storage. Never add a sign-in that sends another app's OAuth client id, originator, user agent
or headers, never spawn a provider's CLI to borrow its sign-in, and never add a Claude or
Google subscription sign-in (their terms forbid it). `test/auth-policy.test.mjs` fails if the
removed flows come back. Rules and sources: `docs/auth-policy.md`.

## Project Structure
```
src/
  sidepanel.ts          # Main entry point, agent setup, settings, rendering
  background.ts         # Service worker (sidepanel toggle, session locks, bridge, foreground guard)
  agent-setup-prompt.ts # The "Copy setup prompt for your agent" text
  browser/              # Tab sessions (tab group per agent), CDP screenshots/input, page primitives
  bridge/               # Native-messaging bridge for external harnesses, site permissions
  models/               # Runtime model discovery per provider
  auth/                 # Sign-in policy (docs/auth-policy.md)
  subscriptions/        # Sign in with ChatGPT and Copilot: settings, relay, streaming (tokens stay in cli/src/subscriptions)
  privacy/              # Private mode and opt-in, scrubbed bug reports
  dialogs/              # Settings tabs, API key dialogs, welcome setup
  tools/                # Agent tools (navigate, REPL, extract-image, skills, debugger)
  messages/             # Custom message types (navigation, welcome)
  storage/              # IndexedDB storage (sessions, skills, costs)
  prompts/              # System prompt and token counting
  components/           # UI components (Toast, TabPill, HelmMark, helm-svg, AgentSetupPrompt)
  composer/             # The chat input's "/" skill menu and "@" tab menu, and how references reach the model
  transcript/           # The transcript as a log: grouping (group.ts) and drawing (render.ts) through pi-web-ui's hook
  artifacts/            # Artifact previews (pptx, spreadsheets, CSV, media, notebooks, ODF, RTF); viewers.ts plugs them into pi-web-ui
test/                   # Extension tests (node --test): auth policy, privacy, setup prompt, custom elements
skills/                 # Bundled agent skills, one SKILL.md per folder, compiled into the CLI
cli/
  src/
    index.ts            # `tychicus` command dispatch and --help
    mcp.ts              # MCP server: browser and library tools, safety instructions
    host.ts, client.ts  # Native host and the Unix-socket client
    setup.ts, doctor.ts, install.ts, harness.ts  # Setup, checks, host registration, harness configs
    skill.ts            # skill install, list, print, revert
    skill-lint.ts       # The skill lint (docs/skill-security.md)
    skills-catalog.ts   # Every bundled skill, imported at build time
    library.ts          # Source library: DOI and arXiv, retraction checks, cite, export
    remote.ts           # `tychicus serve` (MCP over HTTP, loopback) and scoped tokens
    tunnel.ts           # Tailscale and Cloudflare tunnels for serve
    update.ts, minisign.ts  # Signed release updates
  test/                 # CLI tests, including the lint red team and the e2e bridge test
docs/
  decisions.md          # Design decisions and the owner's answers
media/brand/            # Mark, palette and build.mjs, which generates every brand asset
static/
  manifest.chrome.json  # Extension manifest (version lives here)
.github/                # CI, release workflow, CODEOWNERS, issue and PR templates
```

## Bridge development
- After changing `src/`, rebuild and reload with `npm run build && tychicus reload` (always `&&`: a reload after a failed build unloads the extension until it is reloaded from the extensions page).
- `tychicus debug` prints the extension's bridge state, request timings, and a Chrome API benchmark.
- The CLI is a separate package: `cd cli && npm run check`.
