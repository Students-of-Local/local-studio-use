# Contributing to Local Studio's browser and computer use

Thanks for helping. Bug reports, fixes, docs and skills are all welcome. This page covers
setup, the checks a pull request must pass, and how skill contributions are reviewed.
Coding agents follow the same rules, written for them in [AGENTS.md](AGENTS.md).

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Set up

You need Node 20+, git and a Chromium 141+ browser. Clone into a folder of its own,
because the build puts two sibling repositories beside the clone:

```bash
mkdir local-studio-src && cd local-studio-src
git clone https://github.com/baney75/local-studio && cd local-studio/browser
./scripts/setup-siblings.sh               # clones pi-mono and mini-lit, pins and patches them, installs
(cd cli && npm install && npm run build && npm link)
local-studio-browser setup                    # builds the extension, registers the host, connects
```

`./dev.sh` starts the watchers. After a change in `src/`, rebuild and reload with
`npm run build && local-studio-browser reload`. Set `LOCAL_STUDIO_BROWSER_NO_BUMP=1` to stop a build from bumping
the version in `static/manifest.chrome.json`.

Upstream code lives in the siblings. A change to pi-mono that Local Studio needs goes in
`patches/pi-mono.patch`.

## Checks

CI runs these on every pull request. Run them before you push:

```bash
npx biome check .
npx tsc --noEmit
node --import tsx --test test/*.test.mjs
(cd cli && npx tsc --noEmit && npm test)
```

`./check.sh` runs the first three (formatting with `--write`), and the
pre-commit hook runs it for you. Don't skip the hook with `--no-verify`.

For changes to the bridge, the native host or the MCP server, also run the end-to-end
test, which isn't in CI:

```bash
cd cli && npx playwright-core install chromium   # first time only
npm run test:e2e
```

If your change affects what someone sees (the side panel, setup output, `--help`), say in
the pull request how you checked it by hand, or that you didn't.

## Pull requests

- Branch from `main` and open the pull request against `main`. The template asks for what
  changed, how you checked it, and whether a protected path is touched.
- Keep one change per pull request. A refactor and a feature are two pull requests.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Stage files by explicit path (`git add path/to/file`), never `git add -A` or `git add .`.
- Plain, direct English in code, comments and docs. No emojis. The voice is in
  [media/brand/BRAND.md](media/brand/BRAND.md).
- Side panel sign-in is API keys, plus the sign-ins a provider documents for other apps, under
  this app's own registration. A pull request that borrows another app's identity won't be merged
  ([docs/auth-policy.md](docs/auth-policy.md)).

## Contributing a skill

The app's skills are in `skills/`, and come with Local Studio. A skill is text
an agent follows with the user's sign-in, in every session that reads it. A bad one is a prompt
injection that never expires, so skills get the strictest review in this repository
([docs/skill-security.md](docs/skill-security.md)). To share one without adding it to the app, publish
a plugin.

1. **Write it.** A folder with a `SKILL.md`: `name` (the folder name) and a one-line `description`
   in its front matter, then when to use it, numbered steps and how to know it is done. Keep it under
   150 lines and 8,000 characters ([D12](docs/decisions.md)); split longer material into its own skill.
   `@create` in Local Studio's chat, or `local-studio skills create`, writes one for yourself first.
2. **Say how it is found.** `asks.txt` beside it holds what a person would type, one per line. A skill
   for certain sites or apps also has a `where.txt`.
3. **Check the store takes it.** `LOCAL_STUDIO_SKILLS_DIR=$PWD/skills local-studio skills list --shipped --json`
   from the repository root shows no `problem`, and `scripts/tests/skills-text-test.sh` and `scripts/tests/skills-recall-test.sh` pass.
4. **Try it on a small model.** Give the skill and two realistic tasks to the cheapest model
   you have, and fix every place it went wrong. Say in the pull request which model you used.
5. **Write original text.** Don't paste another project's skill. A source under a license
   that isn't compatible with AGPL-3.0 can't be used at all.

### Personal skills are never submitted

A skill that contains your own data (emails, phone numbers, addresses, account or student
IDs, home paths, names you mark as private, or anything from your signed-in sites) is
personal ([D6](docs/decisions.md)). Keep it on your machine.
Don't open a pull request with it, in any form. If you're not sure, it's personal.

## Reporting bugs

Use the bug report form. The fastest way to fill it: turn on bug reports in the side
panel (Settings > Privacy) and use **Review report**, or ask your agent for `/bug`. Both
scrub personal data first. Check the text yourself before you submit it.

## License

By contributing, you agree that your contribution is licensed under
[AGPL-3.0](LICENSE), the license of this project.
