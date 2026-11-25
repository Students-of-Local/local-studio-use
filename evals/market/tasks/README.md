# Task set

Ten browser tasks on a local site, solved by a fixed script through Local Studio's own MCP tools, and checked by what
the page itself received. Not a model eval: every run takes the same steps, so a failure is the tool's.

## Origin

Copied on 2026-11-17 from the Local Studio study (`_work/2026-11-17-local-studio-study/tasks/` in the owner's workspace,
not a repository):

| Here | There | Changes |
|---|---|---|
| `site/`, `fixtures/`, `server.mjs`, `tasks.mjs` | same paths | none |
| `solves.mjs` | `solves.mjs` | none |
| `lib.mjs` | `adapters/local-studio-browser.mjs`, `lib/drivers.mjs` | runs this repo's e2e harness (`cli/test/e2e-harness.mjs`) instead of an installed copy; `clickNewTab` takes the tab from the click's `newTabs` (D50) instead of `tabs_context` |
| `run.mjs`, `loop.mjs` | `run.mjs` | scripted mode; the loop is shared with `../rivals/run.mjs` |
| `speed.mjs`, `loop.mjs` | `lib/latency.mjs` | the same verbs and page, plus the first page text; `../floors.json` holds the ceilings |

## Tasks

| id | Kind | Pass when |
|---|---|---|
| t01-read | Read a table with a decoy row | answer is the K7 battery (not K7 Lite) |
| t02-form | Text, email, select, radio, checkbox, submit | the page posts every value |
| t03-multitab | Code on a `target=_blank` page, redeem on the first | the posted code matches this run's voucher |
| t04-checkout | Duplicate "Add to cart" buttons, cart, checkout form | 2 Blue Mugs, 1 Tea Tin, the address, Express |
| t05-iframe | Payment form in a cross-site frame (`localhost` vs `127.0.0.1`) | the frame posts the card holder |
| t06-shadow | Field and button inside nested open shadow roots | the new name is posted |
| t07-upload | File input | the posted file's first line is `RECEIPT-0091` |
| t08-stale | The list re-renders after Refresh; refs read before it go stale | invoice 3307 approved and no other |
| t09-long | 400 sections; the phrase is in section 371, a decoy in section 12 | this run's phrase is posted |
| t10-dialog | `confirm()` then `prompt()` asking for DELETE | deleted with `DELETE` typed |

Secrets (voucher, phrase) are new on every reset, so an answer cannot be memorized.

## Run

Build first: `LOCAL_STUDIO_BROWSER_NO_BUMP=1 npm run build` at the root and `npm run build` in `cli/`, and have Playwright's
Chromium (`cd cli && npx playwright-core install chromium`).

```sh
node evals/market/tasks/run.mjs --repeat 3        # all ten, three times; exits 1 unless every run passes
node evals/market/tasks/run.mjs --only t08-stale  # one task
node evals/market/tasks/speed.mjs 5               # median ms per verb on t02's form, as JSON
node evals/market/tasks/server.mjs                # just the site, to look at it
```

CI runs the task set and the speed check through the market eval (`../README.md`), gated on `../floors.json`, in
the `market-evals` job of `.github/workflows/browser-ci.yml`. The task loop and the speed loop are `loop.mjs`, shared with the
rival runner (`../rivals/`), so every tool is measured by the same code.
