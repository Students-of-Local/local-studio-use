# Market eval

The numbers behind "best on the market" (#30): Local Studio's scores and speeds, measured the same way on every pull
request and held by floors that only go up. Rival tools are measured by the same code, by hand.

| Part | What it measures | Score | Source |
|---|---|---|---|
| `tasks` | The study's ten browser tasks, solved by script through the MCP tools, checked by what each page received | passes out of 30 (10 tasks x 3 reps) | [`tasks/`](tasks/README.md) |
| `speed` | Median ms on t02's form over 9 runs: `click` (the Phone radio), `fill` (the Full name box), `firstText` (navigate plus the first `get_page_text`) | ms, lower is better | `tasks/loop.mjs`, `measureSpeed` |
| `dom-bench` | 54 hand-written hard pages (frames, shadow roots, stale refs, drag and drop, ...) | passes out of 54, plus its own per-case floor | [`cli/test/dom-bench`](../../cli/test/dom-bench) |
| `riskyActions` | Auto mode's rule list on labeled agent actions (#33, D67): of the risky ones, how many it asks about | risky actions caught; the floor is all of them | [`risky-actions/`](risky-actions/README.md) |

The e2e suites stay in CI's `e2e` job: they prove the bridge works, and score nothing.

## Run

Build first, as CI does: `LOCAL_STUDIO_BROWSER_NO_BUMP=1 npm run build` at the root, `npm run build` in `cli/`, and Playwright's
Chromium (`cd cli && npx playwright-core install chromium`). Node 22.

```sh
npm run evals:market                                  # everything, then the floor check; exits 1 below a floor
node evals/market/run.mjs --only tasks,speed          # some parts; only those are checked
node evals/market/check.mjs                           # check the last run (results/last.json) again
node evals/market/check.mjs --ratchet origin/main     # is any floor lower than on main?
```

A run writes `results/last.json` (gitignored): the scores, the speed medians and every row.

## Floors

[`floors.json`](floors.json) holds a pass count for each score and a ceiling in ms for each speed. The run fails when
a score is under its floor or a median is more than `tolerance_pct` (10%) over its ceiling: medians of 9 moved about
7% between GitHub runners, and a gate that flakes gets ignored. dom-bench also keeps its own per-case floor
(`cli/test/dom-bench/floor.json`: each passing case by id, within its tool-call ceiling), and the run fails when that
breaks too.

The ratchet: a floor only goes up and a ceiling only goes down. CI's `market-evals` job judges with the base
branch's `check.mjs`: it compares both floor files with the base branch, then checks the run with `--require-all`, so
every part `floors.json` scores must have run. The ratchet fails when a pull request lowers a score, raises a ceiling,
removes a case from dom-bench's `passing`, raises `tolerance_pct` or moves anything into `localOnly`. A drop that is right (a case was wrong,
not the tool) needs the reason written beside it and a maintainer's `floor-lowered` label.

The numbers come from CI's own runner, never a laptop: the `market-floors` workflow runs the eval 3 times on separate
runners and `check.mjs --raise` takes the worst of the 3, raising floors only. To raise them after a speedup:

```sh
gh workflow run browser-market-floors.yml --ref <branch>      # or push the branch as floors/<name>
gh run download <run id> -n market-floors             # floors.json and the 3 runs
```

then copy that `floors.json` over this one in a pull request.

`localOnly` lists what is kept out of the CI gate, with the reason: the rivals (below) and dom-bench's per-case wall
time (`--time`), because a shared runner's clock swings several fold per case.

## Rivals, by hand

[`rivals/`](rivals/) runs the same task set and speed check against Playwright MCP, agent-browser, browse and Chrome
DevTools MCP, at the versions `rivals/install.sh` pins. They never run in CI: CI scores Local Studio only. Each runs in a
throwaway profile, headless, on Playwright's Chromium.

```sh
evals/market/rivals/install.sh                                     # into evals/market/rivals/tools (gitignored)
node evals/market/rivals/run.mjs --tool playwright-mcp --repeat 3  # or agent-browser, browse, chrome-devtools-mcp, local-studio-browser
node evals/market/rivals/install-time.mjs                          # install time from nothing, and install steps
```

Each run writes `results/rival-<tool>.json` in the format above, plus `startMs`: from nothing running to the first page's
text (`t01-read`), in a session of its own, the same way for every tool (`detail.start.launchMs` is the tool's start
alone; agent-browser launches its browser on its first command, so start alone read 0). `--no-start` skips it. `env`
holds the tool's version, the machine, Node, Chromium and the 1-minute load average at the start and end.
`install-time.mjs` writes `results/install.json`: each tool installed 3 times into a new folder with an empty npm cache
(Local Studio by its release's one command, with a throwaway home folder), and the install steps each README gives.
`MARKET_RIVALS_DIR` points at another install, and `MARKET_CHROMIUM` at another Chromium. Model-driven runs (a local
model given each tool's own MCP tools), Browser Use's own agent and Stagehand are the weak-model track in #30 and have
no adapter here.

## Results page

[`docs/market.md`](../../docs/market.md) is the published comparison, built by `page.mjs` from the runs kept in
[`published/`](published/), one folder per date with one small file per tool and `install.json`. A kept run holds
numbers, versions and the machine; never task rows, page text or a host name.

```sh
node evals/market/page.mjs --add 2026-11-24 evals/market/results/rival-*.json evals/market/results/install.json
node evals/market/page.mjs --check                                  # exits 1 when the page and published/ disagree
```

`--add` keeps the runs and rewrites the page. Never edit the page by hand: `test/market-page.test.mjs` (in CI's extension
tests) fails when it is not exactly what `published/` gives.

## Risky actions

[`risky-actions/`](risky-actions/README.md) scores Auto mode's rule list (`src/bridge/risk-rules.ts`, #33) on 86
labeled agent actions, 59 of them risky. The floor is recall at 100%: every risky case must be caught. It needs no
browser, so it runs in seconds.
