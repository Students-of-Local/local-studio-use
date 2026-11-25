# Why click and fill were slow, and what fixed them

The 2026-11-17 study measured Tychicus at a median of 808 ms per click and 532 ms per fill on its form page
(`evals/market/tasks/site/t02-form`), where the rival tools took under 100 ms. This is the trace behind D50.

## How it was measured

`evals/market/tasks/speed.mjs` runs the study's latency script against this repo's build: a throwaway headless Chromium
with the built extension, the native host and the MCP server (`cli/test/e2e-harness.mjs`). Each of 5 runs opens the
form, reads it, fills Full name and clicks the Phone radio; the median of the 5 is reported. To find where the time
went, timestamps were logged temporarily in `fillElement`, `click` (cdp.ts) and `settleAfter` (tools.ts) and read from
the extension's service worker; that logging is not in the commit.

## The trace on fa4bf63

| Call | Phase | ms |
|---|---|---|
| fill | resolve the ref, focus | 2 |
| fill | set the value in the page (`fillElement`) | 206 |
| fill | settle until the page is quiet | 515 |
| click | locate and point (`locate`) | 205 |
| click | mouse input (move, press, release) | 235 |
| click | settle until the page is quiet | 540 |

Medians over 5 runs on fa4bf63 with `speed.mjs`: click 552 ms, fill 518 ms, navigate 333 ms, read_page 6 ms (an earlier
run gave 564 and 516).

## Causes

1. **A fixed two-frame wait after `scrollIntoView`.** `locate` and `fillElement` waited for two animation frames
   (capped at 200 ms) every time, so a scroll could finish. The agent's tab is hidden, and a hidden tab in headless
   Chromium draws about one frame a second, and only when one is asked for, so the wait ran out at 200 ms every time,
   even when the element was already in view and nothing moved. Timers in a hidden tab run normally (20 per second
   measured), so only frames are slow.
2. **The whole quiet window on a page that never reacts.** D41's settle returns after 300 ms with no mutation, request
   or navigation. A radio or a text box on a plain form changes nothing the settle watches, so every such action paid
   the full 300 ms, plus a 100 ms polling step.
3. **The `mouseMoved` reply waits for a frame.** With the first wait gone, click rose to about 1 s: Chrome aligns
   continuous input (mouse moves) to frames, and the reply to `Input.dispatchMouseEvent` for a move comes after the
   hidden tab's next frame (moved at 973 ms, pressed at 980 ms in the trace). A press is discrete input: Chrome flushes
   queued moves before it, so the move still lands first without waiting for its reply.

Frame rate did not change with `--enable-gpu` or the background-throttling flags (about 2 frames a second in every
case), so a flag was not the fix. A 1x1 `Page.captureScreenshot` to force a frame took about 1 s and then timed out.

## Fixes (D50)

- The box is measured before `scrollIntoView`; the two-frame wait runs only if it moved.
- Click and fill settle with `idleMs` 60: when nothing in the first 60 ms shows the page reacting, the action returns.
  Any sign of a reaction (a mutation, a request, a pending navigation, a document still parsing, a refused look, a
  tab opened from the page) keeps the full settle, so a page that reacts is still waited for.
- The `mouseMoved` is sent without awaiting its reply; the press and release are awaited, then the move's reply. A
  click with `on_dialog` still awaits the move before it arms its answer, so a box the page opens on its own in that
  time never takes it.
- `scroll` waits up to 1.1 s for the frame the page owes after its last mutation, so an IntersectionObserver sees
  appended content. This fixed dom-bench infinite-scroll; it adds time only when the page changed and no frame has
  drawn since.

After the fixes, one click: resolve 2 ms, point 3 ms, input 6 ms, settle 60 ms.

## Results

`node evals/market/tasks/speed.mjs 5`, same machine, same build steps, 2026-11-17 (runs: click 72, 73, 70, 73, 75; fill 81,
76, 71, 75, 76):

| Verb | fa4bf63 median | This branch median | Limit |
|---|---|---|---|
| click | 552 ms | 73 ms | under 150 ms |
| fill | 518 ms | 76 ms | under 100 ms |
| navigate | 333 ms | 335 ms | none |
| read_page | 6 ms | 5 ms | none |

## Left as is

Drag awaits each of its 12 mouse moves, because a drop target may need the frames between them, so a drag in a
hidden tab takes about a second per move (dom-bench pointer-sortable takes about 15 s). It predates this branch.

## 2026-11-21: first page text, fill and click (D56)

The market eval's floors (D55, medians of 9 on CI's runner) were firstText 361 ms, fill 80 ms and click 79 ms. The
targets were firstText under 120 ms, fill under 40 ms and click under 50 ms, with dom-bench at 54/54 and tasks at 30/30.

### How it was measured

A temporary branch (`floors/speed-trace`, not for merge) added a `_trace` of timestamps to the navigate, click and fill
results, and each settle probe returned page-clock times for its own phases. `evals/market/tasks/loop.mjs` kept the traces,
and the `market-floors` workflow ran it on 3 runners (runs 44876033610 and 44876541177). Medians of 27 calls, in ms from
the start of the handler:

| Call | Hop | ms |
|---|---|---|
| navigate | check the URL, resolve the tab, action start | 1.3 |
| navigate | the navigation reaches DOMContentLoaded | 23 |
| navigate | tab summary | 24.8 |
| navigate | first probe answers (`readyState` complete, nothing in flight) | 27.7 |
| navigate | second probe, after the 50 ms loaded window | 78.6 |
| navigate | end | 78.9 |
| get_page_text | the whole call, through MCP, socket, host and native messaging | about 3 |
| fill | resolve, look before, action start | 2.3 |
| fill | set the value (`fillElement`) | 5.2 |
| fill | probes, then the 20 ms idle window | 26.5 |
| fill | change report | 30 |
| click | resolve, look before, point, action start | 4.3 |
| click | press, move reply, release | 6.1 |
| click | first probe answers | 56.6 |
| click | change report | 58.5 |

Before this branch, navigate settled with D41's 300 ms quiet window, counted from the first probe after
DOMContentLoaded and polled in 100 ms steps: about 330 of the 361 ms. The transport hops cost about 3 ms in all.

### What changed

- **A short quiet window after a loaded navigation.** Once a probe sees `readyState` complete, no request, loader or
  pending navigation, and no data request that ended recently, navigate waits 50 ms of quiet (`LOADED_QUIET_MS`)
  instead of 300 ms.
- **The full window after data requests.** The probe reads Resource Timing in the page's own clock: a fetch or XHR,
  or a script, style or frame that ended after DOMContentLoaded, counts as activity at its end time. A page that
  draws 150 ms after its fetch (e2e `/nav-fetched`), or opens an alert 200 ms after one, keeps the 300 ms window.
- **A drained idle look.** The idle and loaded probes answer after one MessageChannel turn and a `setTimeout(0)`, so
  a reaction the page posts as a task or a timer is seen before the action returns. `IDLE_MS` dropped from 60 to 20.
- **The loop wakes when the quiet window would end,** not on the next 100 ms step.
- **`Page.windowOpen` counts as the page reacting.** On a loaded machine the new tab's own events came after the 20 ms
  idle window and the change report listed no new tab; the opener's `Page.windowOpen` comes on its own session first.

Races covered by tests: `cli/test/e2e-bridge.test.mjs` "D56: navigate then get_page_text at once reads the new page
as its scripts drew it, never the old one" (pages that redraw at DOMContentLoaded, on load, after a fetch, and that
redirect after load) and "D56: a click or fill whose page answers a task later reports that change, and the next read
sees it"; `test/settle.test.mjs` "D56: Page.windowOpen before the probe's reply holds an idle settle, with no tab event
yet". Removing the Resource Timing rule failed `/nav-fetched` and the existing "Welcome back" alert test; removing
the `Page.windowOpen` handling failed its unit test (`{"settled":true,"ms":25,"idle":true}`).

### Results

`market-floors` on CI, medians of 9 per runner:

| Commit | firstText | fill | click | tasks | dom-bench |
|---|---|---|---|---|---|
| ed35a6e (runs 1, 2, 3) | 84, 84, 85 | 32, 32, 32 | 61, 61, 61 | 30/30 | 54/54 |
| 26cc90d (runs 1, 2, 3) | 85, 89, 87 | 29, 32, 33 | 59, 61, 62 | 30/30 | 54/54 |
| f5525b1, final head on main 97c6304 (runs 1, 2, 3; run 44880929842) | 92, 88, 82 | 35, 33, 32 | 63, 63, 60 | 30/30 | 54/54 |

| Verb | Ceiling before | Worst of 3 after | Target |
|---|---|---|---|
| firstText | 361 ms | 92 ms | under 120 ms, met |
| fill | 80 ms | 35 ms | under 40 ms, met |
| click | 79 ms | 63 ms | under 50 ms, not met |

### Left as is

Click under 50 ms was not reached. The 50 ms is the page's task queue held after the click, not Tychicus's own work:
in the CI trace the move reply came back at 6.3 ms, and the probe began in the page 0.8 ms after it was sent, but its
MessageChannel message was delivered at 50.2 ms (fill and navigate probes: about 1 ms). Chromium's
`DeferRendererTasksAfterInput` holds a page's ordinary tasks after a discrete input until the next frame. In a visible
headless tab that took 2 to 12 ms, and with `--disable-features=DeferRendererTasksAfterInput` it was 0 ms. The page's own
`setTimeout(0)` reaction to the click was held for the same time, so returning earlier would miss it. The agent's tab is
hidden and draws no frame on its own, which matches the 50 ms seen on CI. A flag in the user's own Chrome is not ours to
set, so click stays at about 60 ms.

## 2026-11-22: beating agent-browser on click, fill and first text (D62)

The goal: Tychicus's click, fill and firstText medians under agent-browser's in the market eval's rivals harness
(`evals/market/rivals/run.mjs --repeat 3`), same machine and session, with startMs no worse than any rival once every tool
is timed the same way, tasks at 30/30 and dom-bench at 54/54. The machine is a shared 32-core host whose load swung from
16 to 50 during the work, from other people's jobs; every comparison below pairs the two tools in one session.

### How it was measured

`TYCHICUS_TRACE` (off by default; `cli/src/hop-trace.ts`) adds a mark at every hop: the MCP server, the client, the native
host in both directions, the service worker, and named steps inside the handlers. Set to a file, each tool call appends one
JSON line. `evals/market/tasks/speed.mjs N` drove the calls; the table gives medians in ms from the MCP server receiving the
call. Before: 18 calls per tool on the branch point (b5df132). After: 15 on 9149b13, load 20.

| Call | Hop | Before | After |
|---|---|---|---|
| click | MCP, socket, host, native messaging to the handler | 1.9 | 1.3 |
| click | resolve the tab, look before, locate | 7.9 | 5.4 |
| click | action start, mouse input | 3.3 | 3.7 |
| click | settle: input to a drained look | 50.3 | 15.2 |
| click | change report, back to the MCP server | 4.3 | 4.3 |
| click | total | 67.7 | 29.9 |
| fill | to the handler | 1.9 | 1.3 |
| fill | resolve, look before, action start | 4.3 | 6.2 |
| fill | set the value (`fillElement`) | 5.0 | 2.5 |
| fill | settle | 22.1 | 2.4 |
| fill | change report, back | 7.8 | 3.0 |
| fill | total | 41.1 | 15.4 |
| navigate | to the handler, resolve, start | 3.2 | 3.8 |
| navigate | the load (DOMContentLoaded and load) | 33.4 | 38.2 |
| navigate | settle after the load | 55.1 | 3.5 |
| navigate | total | 93.3 | 46.3 |
| get_page_text | total | 4.7 | 5.7 |

The transport (MCP stdio, the Unix socket, the native host and native messaging) is 1 to 2 ms in and about 1 ms back, before and
after. The cost was in the browser and in fixed waits.

### What the trace found

1. **A hidden tab holds the page's tasks for 50 ms after a click or key.** Chromium's `DeferRendererTasksAfterInput`
   defers a page's tasks after discrete input until the next frame, at most `kDiscreteInputResponseDeadline` (50 ms). An
   agent's tab is out of sight and draws no frames, so every click waited the deadline before the settle's drained look
   could run. The experiment: a headless Chromium, a background tab (`Target.createTarget` with `background: true`), a
   radio button whose click handler records when its `setTimeout(0)`, `MessageChannel` and `requestAnimationFrame` run,
   a CDP click, then a drained probe. With nothing else, the timer ran 50 ms after the click on 7 of 9 clicks (the first
   two came while the page still drew its load frames). With a 16x16 screencast started once and its frames never
   acknowledged, it ran 6 to 13 ms after on 9 of 9. An earlier run gave 8 of 9
   held and 5 to 12 ms with the cast. Focus emulation,
   an overlay, an extra `Runtime.evaluate`, a mouse move and `Page.setWebLifecycleState` did not end the hold.
2. **Fixed windows after the drained look.** The settle waited `IDLE_MS` (20 ms) after a click or fill that showed no
   reaction and `LOADED_QUIET_MS` (50 ms) after a navigation's load event, though D56's drained look had already run
   what the page queued.
3. **The veil's page call ran before every input handler,** 1 to 2.5 ms.
4. **Each large page script was compiled on every call.** The look, fill and locate scripts are 15 to 25 KB, and each
   call's text held its arguments, so V8 compiled each anew: about 4 ms of a 5 ms evaluate.

### What changed

The four fixes in D62: a 1x1 screencast while an agent acts (`keepDrawing`, ends 3 s after the last action); `IDLE_MS`
and `LOADED_QUIET_MS` at 0, with `Page.frameRequestedNavigation` counted as a reaction; the page library (functions
installed once per document, called by a salted key); and the veil's call overlapped with the look before.

The e2e gate then caught two regressions, both fixed before the pull request. A click on an `<a download>` link
returned before the browser began the download, which the old 20 ms window had covered: the probe now notes such a
click and settle waits up to `FILE_START_MS` (1 s) for `Page.downloadWillBegin` (e2e "a click on a download link
reports the file it started (D49)"). A recording started while the keeper's cast ran failed with "Screencast is
already active": it now takes the cast over (e2e "capture: a recording of a background tab is a WebM that plays").

Tried and left out: folding the look before into the fill's call and the look after into the settle's first probe
removed two page calls from a fill and saved 0.6 ms (22.0 against 22.6 ms, 25 calls each), inside the noise.

### Results

The rivals harness, 3 reps each, medians in ms. startMs is timed the same way for every tool since the fairness fix
(start, open t01-read, first text); the baseline row for agent-browser predates it and reads 0.

| Run | Load | Tool | click | fill | firstText | startMs | tasks |
|---|---|---|---|---|---|---|---|
| baseline, b5df132 | | tychicus | 71 | 43 | 112 | 2253 | 30/30 |
| baseline | | agent-browser | 24 | 9 | 41 | 0 (unmeasured) | 30/30 |
| after, 9149b13 (run 1) | 29 | tychicus | 40 | 21 | 61 | 2285 | 30/30 |
| same session | 25 | agent-browser | 32 | 20 | 135 | 3894 | 30/30 |
| after, 9149b13 (run 2) | 16 | tychicus | 27 | 16 | 48 | 1769 | 30/30 |
| same session | 15 | agent-browser | 20 | 9 | 43 | 2049 | 30/30 |

On the quieter pair, startMs is under agent-browser's, and click, fill and firstText are 7, 7 and 5 ms over it.
`npm run evals:market` passes its floors (tasks 30/30, dom-bench 54/54).

### What still blocks click, fill and firstText

agent-browser's driver runs its CLI once per call against a CDP daemon and returns when the input is acknowledged: no
settle and no change report. Tychicus's results say what each action changed, which needs a look before, a drained look
after and a settle that waits for what the page queued. From the after trace:

- **click (27 against 20).** 15.2 ms go from the input to the drained look. About 2.5 ms of it is the probe's round
  trip; the rest is the page's tasks waiting for the next frame (`DeferRendererTasksAfterInput`), which comes on the
  60 Hz frame clock, up to 16.7 ms after the input. The page's own reaction to the click (its `setTimeout(0)`) is held
  for the same frame, so returning before it would report "nothing changed" for a click that changed the page (D56).
  Without the frame wait the click would be about 18 ms. A browser flag can lift the hold, and the person's own Chrome
  is not ours to set.
- **fill (16 against 9).** The two looks and the settle probe are 8.5 ms of the 15.4; the transport, resolve and the
  fill itself are about 7.
- **firstText (48 against 43).** The page load is 38 ms of Tychicus's navigate, which no change here touches; Tychicus adds the
  settle's drained look after the load (3.5 ms), which D56 needs for pages that draw at DOMContentLoaded or load, and
  about 2 ms of transport each for navigate and get_page_text.
