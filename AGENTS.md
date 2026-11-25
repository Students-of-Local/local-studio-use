# Development Rules

This file is the source of truth for coding agents in this repository. `CLAUDE.md` points
here. Human contributors: see `CONTRIBUTING.md`, which follows the same rules.

## First Message
If the user did not give you a concrete task, read README.md first.

## Commands
- After code changes: run `./check.sh`. Fix all errors and warnings before committing.
- The user runs `./dev.sh` in a separate tmux session. Don't start `npm run dev`. Run `npm run build` only for bridge work, as "Bridge development" below says, or as `LOCAL_STUDIO_BROWSER_NO_BUMP=1 LOCAL_STUDIO_BROWSER_OUT_DIR=<dir> npm run build` to build elsewhere without bumping the version in the checkout.
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

## Names
The product is Local Studio. The extension and this helper are its browser use, `local-studio-computer` its computer use. No file here, its name
or the built output holds an earlier product's name, in any case; `test/product-name.test.mjs` scans them all and has no allowlist.

- The helper is `local-studio-browser` (`COMMAND_NAME` in `cli/src/self.ts`), its npm package and `User-Agent` the same. Every command the CLI prints
  (`doctor`, `status`, errors, usage, services, the setup prompts) is built from `COMMAND_NAME`. Write these strings as template literals;
  `cli/test/rendered-names.test.mjs` fails on a quoted string that holds `${COMMAND_NAME}`. The extension's commands for this computer come from
  `hostCommand()` (`src/bridge/host-command.ts`). A prompt for another device (`deviceSetupPrompt`) tries `local-studio-browser`, then the release program.
- The MCP server agents see is `local-studio` (`MCP_NAME`, `DEFAULT_MCP_NAME`), so Claude Code's qualified names are `mcp__local-studio__*`. Tool names don't change.
- The native host is `com.localstudio.browser` (`NATIVE_HOST_NAME`), the socket folder `/tmp/local-studio-browser-<user>` (`LOCAL_STUDIO_BROWSER_SOCKET_DIR`
  replaces it), the hub headers `x-local-studio-hub-scopes` and `x-local-studio-hub-caller`, the services `com.localstudio.browser.*`.
- The config folder is `browser` in Local Studio's data folder (`~/.local-studio/browser`; `LOCAL_STUDIO_BROWSER_DIR` replaces it, `LOCAL_STUDIO_DATA_DIR` moves
  Local Studio's). The helper's data and cache folders are `~/.local/share/local-studio-browser` and `~/.cache/local-studio-browser`.
- Read variables through `envVar("NAME")` (`cli/src/env.ts`): `LOCAL_STUDIO_BROWSER_NAME`. The computer-use helper's are `LOCAL_STUDIO_COMPUTER_NAME`.
- The manifest `key` fixes the extension id, `igjafcggmahiboobmnhfkndodphjdnhg`, which `src/bridge/extension-id.json` holds for the CLI and every
  test (`cli/test/release-install.test.mjs` checks the key gives it). Never change the key: every installed host manifest allows only this id.
- The extension's stored data keeps its keys. Data a build under an earlier name left is found by shape, never by name (`src/storage/adopt.ts`).

## The single executable
`cli/scripts/compile.mjs` builds `local-studio-browser` (Bun, bytecode) from the esbuild bundle with `LOCAL_STUDIO_BROWSER_CLI_COMPILED=1`;
`cli/src/self.ts` is the one place that knows whether the program is compiled. In that mode launchers and the native host
manifest run the executable itself, the extension is read from `extension/` beside it and the computer-use helper from its own folder. The
Local Studio app ships these programs, so there `local-studio-browser update` changes nothing. A copy is a release only when `build-info.json` is beside
it (`RELEASE_BUILD`); the app copies the program without that file. Run
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
- Changes to pi-mono that Local Studio depends on go in `patches/pi-mono.patch`, which `scripts/setup-siblings.sh` applies at the pinned commit

## Skills
The app's skills are in `skills/` (docs/decisions.md, D71). Local Studio ships them, and
agents find them through `skill_search` and `skill_read`, which this server passes to `local-studio skills mcp`. Nothing in
`browser/` keeps a list, a lint or a copy of them; the one exception is the side panel's "/" menu, which `scripts/build.mjs`
makes from that folder. They run with the user's sign-in in every agent that reads them, so treat a skill change like a
security change (`docs/skill-security.md`).

- A skill is a folder: `SKILL.md` with `name` (same as the folder) and a one-line `description` in its front matter, and
  beside it `asks.txt` (the words a person would use, one per line), `where.txt` (the sites and apps it is for) and
  `names.txt` (other names), each optional.
- Keep `SKILL.md` to 150 lines and 8,000 characters (D12). Split longer material into its own skill.
- After a change, from the repository root, with the built `local-studio`: `LOCAL_STUDIO_SKILLS_DIR=$PWD/skills local-studio
  skills list --shipped --json` shows no row with a `problem`, and `scripts/tests/skills-text-test.sh` and
  `scripts/tests/skills-recall-test.sh` pass.
- Skills describe attacks; they never quote them, not even in a code fence.
- Personal skills (anything with the user's own data) are never committed, pushed or submitted (D6).

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
  person using Local Studio, in their words: "Settings tabs no longer leave one tab alone on a line."
  Details, file names, decisions (D12) and tests come after it. The side panel's "What's new" card
  shows only that first sentence (`digestReleaseNotes` in `src/update/logic.ts`), and a longer one is
  cut at its first colon, semicolon or parenthesis.

## Decisions
- `docs/decisions.md` records design defaults and the owner's answers (D1, D2, ...). Add
  an entry when you choose a default that changes the outcome; never rewrite an old one.

## Releasing
Nothing here releases on its own: the Local Studio app ships the programs and the extension, built from this folder at the app's commit.
`scripts/package-release.mjs` builds the same parts as an archive `local-studio-browser install --release` can install, for a test machine.

## Local Studio plugins
`plugins/browser-use` and `plugins/computer-use` are Local Studio v0 plugins: `plugin.toml` with
`capabilities = []` (any capability fails Local Studio's loader), a skill, and a slash command. Their tools come from the
`local-studio` entry `install --local-studio` writes to Eukhe's `mcpServers`. A new file in a plugin must be added to `PLUGINS`
in `cli/src/local-studio.ts`, which embeds them. The skills carry `version:` in frontmatter for Local Studio.
Run `scripts/validate-local-studio-plugins.sh` after changing a `plugin.toml`: it compiles Local Studio's own loader
(`core/src/plugins.rs`) from a checkout (`LOCAL_STUDIO_CHECKOUT`, default `~/Projects/local-studio`) and loads both.
Tests that run `install` must give it a throwaway HOME and unset `XDG_CONFIG_HOME` and `XDG_DATA_HOME`: with those set,
it writes the real launchers and host manifests whatever HOME says.

## Brand
The extension wears Local Studio's mark and colors (`docs/brand` at the top of this repository). `media/brand/build.mjs` copies
the mark and renders the icons; `media/brand/BRAND.md` has the palette, and `test/local-studio-logo.test.mjs` checks the copies
match. Never edit those outputs by hand.

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
- Every change goes through a pull request against `main`. CI must pass.
- A change to `skills/`, CI, the CLI's build and package files, the setup prompt or
  `docs/skill-security.md` needs the maintainer's review.
- Never weaken a check or CI in a change that also does something else, and never without the
  maintainer's review.
- Stacked pull requests merge in order (D8).
- Agents don't merge unless the maintainer asked for it in the task.

## Sign-in policy
API keys, plus subscription sign-ins only on a route the provider documents for third-party
apps, with Local Studio's own registration: Sign in with ChatGPT (open-source path) and GitHub
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
  dialogs/              # Settings sections and dialogs
  tools/                # Agent tools (navigate, REPL, extract-image, skills, debugger)
  messages/             # Custom message types (navigation, welcome)
  storage/              # IndexedDB storage (sessions, skills, costs)
  prompts/              # System prompt and token counting
  components/           # UI components (Toast, TabPill, LocalStudioMark, local-studio-svg, AgentSetupPrompt)
  composer/             # The chat input's "/" skill menu and "@" tab menu, and how references reach the model
  transcript/           # The transcript as a log: grouping (group.ts) and drawing (render.ts) through pi-web-ui's hook
  artifacts/            # Artifact previews (pptx, spreadsheets, CSV, media, notebooks, ODF, RTF); viewers.ts plugs them into pi-web-ui
test/                   # Extension tests (node --test): auth policy, privacy, setup prompt, custom elements
cli/
  src/
    index.ts            # `local-studio-browser` command dispatch and --help
    mcp.ts              # MCP server: browser and library tools, safety instructions
    host.ts, client.ts  # Native host and the Unix-socket client
    setup.ts, doctor.ts, install.ts, harness.ts  # Setup, checks, host registration, harness configs
    skills.ts           # skill_search and skill_read, passed through to `local-studio skills mcp`
    library.ts          # Source library: DOI and arXiv, retraction checks, cite, export
    remote.ts           # `local-studio-browser serve` (MCP over HTTP, loopback) and scoped tokens
    tunnel.ts           # Tailscale and Cloudflare tunnels for serve
    update.ts, minisign.ts  # Signed release updates
  test/                 # CLI tests, including the e2e bridge test
docs/
  decisions.md          # Design decisions and the owner's answers
media/brand/            # Palette, voice and build.mjs, which copies the mark and renders the icons
static/
  manifest.chrome.json  # Extension manifest (version lives here)
.github/                # CI, release workflow, CODEOWNERS, issue and PR templates
```

## Bridge development
- After changing `src/`, rebuild and reload with `npm run build && local-studio-browser reload` (always `&&`: a reload after a failed build unloads the extension until it is reloaded from the extensions page).
- `local-studio-browser debug` prints the extension's bridge state, request timings, and a Chrome API benchmark.
- The CLI is a separate package: `cd cli && npm run check`.
