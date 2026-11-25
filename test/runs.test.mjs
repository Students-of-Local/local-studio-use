// The Runs view's log (src/runs/log.ts): what a step records, how a run's status moves, and the caps that keep it small.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addStep,
	cap,
	clearWaits,
	EMPTY_LOG,
	endRun,
	isRunStep,
	MAX_RUNS,
	MAX_STEPS,
	panelRunName,
	parseLog,
	REPORT_MAX,
	RUNS_KEY,
	renameRun,
	runName,
	STATUS_LABEL,
	setWaiting,
	stepReport,
} from "../src/runs/log.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const step = (extra = {}) => ({ who: "Agent · claude", tool: "click", params: { ref: "e12" }, tabId: 7, ok: true, ms: 41.6, ...extra });

test("a step adds a running run, with its tool, target, result and time", () => {
	const log = addStep(EMPTY_LOG, "bridge-a", step({ tabTitle: "Sign in\nto GitHub", result: { ok: true } }), 1000);
	const [run] = log.runs;
	assert.equal(run.id, "bridge-a");
	assert.equal(run.status, "running");
	assert.equal(run.tabId, 7);
	assert.equal(run.tabTitle, "Sign in to GitHub");
	assert.equal(run.steps.length, 1);
	assert.equal(run.steps[0].tool, "click");
	assert.match(run.steps[0].target, /e12/);
	assert.equal(run.steps[0].ms, 42);
	assert.equal(run.steps[0].ok, true);
});

test("a failed step keeps its error as the result and has no report", () => {
	const log = addStep(EMPTY_LOG, "r", step({ ok: false, error: "Element not found", result: { changes: ["x"] } }), 1);
	assert.match(log.runs[0].steps[0].result, /Element not found/);
	assert.equal(log.runs[0].steps[0].report, undefined);
});

test("a run keeps its last steps and counts the ones it dropped", () => {
	let log = EMPTY_LOG;
	for (let i = 0; i < MAX_STEPS + 5; i++) log = addStep(log, "r", step({ params: { ref: `e${i}` } }), i);
	assert.equal(log.runs[0].steps.length, MAX_STEPS);
	assert.equal(log.runs[0].dropped, 5);
	assert.match(log.runs[0].steps.at(-1).target, new RegExp(`e${MAX_STEPS + 4}`));
});

test("the log keeps the newest runs", () => {
	let log = EMPTY_LOG;
	for (let i = 0; i < MAX_RUNS + 3; i++) log = addStep(log, `r${i}`, step(), i);
	log = cap(log);
	assert.equal(log.runs.length, MAX_RUNS);
	assert.equal(log.runs[0].id, `r${MAX_RUNS + 2}`);
	assert.ok(!log.runs.some((r) => r.id === "r0"));
});

test("waiting on the user and then going on, and a step while waiting keeps it waiting", () => {
	let log = addStep(EMPTY_LOG, "r", step(), 1);
	log = setWaiting(log, "r", true, 2);
	assert.equal(log.runs[0].status, "waiting");
	log = addStep(log, "r", step(), 3);
	assert.equal(log.runs[0].status, "waiting");
	log = setWaiting(log, "r", false, 4);
	assert.equal(log.runs[0].status, "running");
	assert.equal(setWaiting(log, "missing", true, 5), log, "no run, no change");
});

test("a run ends done, or failed when told so or when its last step failed, and stays ended", () => {
	const ok = endRun(addStep(EMPTY_LOG, "r", step(), 1), "r", 2);
	assert.equal(ok.runs[0].status, "done");
	const lastFailed = endRun(addStep(EMPTY_LOG, "r", step({ ok: false, error: "x" }), 1), "r", 2);
	assert.equal(lastFailed.runs[0].status, "failed");
	const told = endRun(addStep(EMPTY_LOG, "r", step(), 1), "r", 2, true);
	assert.equal(told.runs[0].status, "failed");
	assert.equal(endRun(ok, "r", 3, true), ok);
});

test("a call still open when its run ended is logged and doesn't start the run again; a later call does", () => {
	const ended = endRun(addStep(EMPTY_LOG, "r", step({ ms: 10 }), 100), "r", 1_000);
	const late = addStep(ended, "r", step({ tool: "handback", ok: false, ms: 500 }), 1_004, 1_000);
	assert.equal(late.runs[0].status, "done");
	assert.equal(late.runs[0].steps.length, 2);
	assert.equal(addStep(late, "r", step({ ms: 900 }), 1_200, 1_000).runs[0].status, "done", "a second one");
	assert.equal(addStep(late, "r", step({ ms: 2 }), 1_006, 1_000).runs[0].status, "running", "one begun right after the end");
	const failed = endRun(addStep(EMPTY_LOG, "r", step({ ok: false, error: "x" }), 100), "r", 1_000);
	assert.equal(addStep(failed, "r", step({ ms: 500 }), 1_004, 1_000).runs[0].status, "failed");
	// The agent left during its first call, so the log has no run yet.
	assert.equal(addStep(EMPTY_LOG, "r", step({ ms: 500 }), 1_004, 1_000).runs[0].status, "done");
	assert.equal(addStep(EMPTY_LOG, "r", step({ ok: false, error: "x", ms: 500 }), 1_004, 1_000).runs[0].status, "failed");
});

test("the worker knows when a run ended: an open call's answer and a wait it began leave it ended", async () => {
	installFakeChrome();
	const worker = await import("../src/runs/worker.ts?ctx=runs-ended");
	const status = async (want) => {
		let runs = [];
		for (let i = 0; i < 100 && !want(runs); i++) {
			await new Promise((r) => setTimeout(r, 20));
			runs = (await chrome.storage.local.get(RUNS_KEY))[RUNS_KEY]?.runs ?? [];
		}
		return Object.fromEntries(runs.map((r) => [r.id, r.status]));
	};
	// One agent leaves during its first call, another during a later one that goes on to wait on the user.
	worker.recordStep("b", step({ ms: 1 }));
	const began = Date.now();
	worker.runEnded("a");
	worker.runEnded("b");
	worker.recordStep("a", step({ ms: Date.now() - began + 50 }));
	worker.runWaiting("b", true, began - 50);
	worker.runWaiting("b", false);
	worker.recordStep("b", step({ tool: "handback", ok: false, ms: Date.now() - began + 50 }));
	assert.deepEqual(await status((runs) => runs.length === 2), { a: "done", b: "done" });
	// A new call starts it again.
	await new Promise((r) => setTimeout(r, 30));
	worker.recordStep("b", step({ ms: 1 }));
	assert.deepEqual(await status((runs) => runs.some((r) => r.status === "running")), { a: "done", b: "running" });
});

test("a panel chat's run follows its session to the saved id", () => {
	let log = addStep(EMPTY_LOG, "tab-4", step(), 1);
	log = renameRun(log, "tab-4", "saved-1");
	assert.deepEqual(
		log.runs.map((r) => r.id),
		["saved-1"],
	);
	log = addStep(log, "tab-9", step({ params: { ref: "first" } }), 2);
	log = addStep(log, "saved-2", step({ params: { ref: "second" } }), 3);
	log = renameRun(log, "tab-9", "saved-2");
	const merged = log.runs.find((r) => r.id === "saved-2");
	assert.equal(merged.steps.length, 2);
	assert.match(merged.steps[0].target, /first/);
	assert.ok(!log.runs.some((r) => r.id === "tab-9"));
});

test("a step's change report is cut to its cap", () => {
	const report = stepReport({ changes: Array.from({ length: 400 }, (_, i) => `changed field ${i}`) });
	assert.ok(report === undefined || report.length <= REPORT_MAX + 1);
	assert.equal(stepReport(undefined), undefined);
});

test("bookkeeping calls are not steps", () => {
	for (const m of ["status", "tabs.context", "session.info", "sessions.list", "edits.list", "bridge.ping"]) {
		assert.equal(isRunStep(m), false, m);
	}
	for (const m of ["navigate", "click", "read_page", "handback"]) assert.equal(isRunStep(m), true, m);
});

test("a stored log that is not a log reads as empty", () => {
	assert.deepEqual(parseLog(undefined), EMPTY_LOG);
	assert.deepEqual(parseLog({ runs: "x" }), EMPTY_LOG);
	const log = addStep(EMPTY_LOG, "r", step(), 1);
	assert.deepEqual(parseLog(JSON.parse(JSON.stringify(log))), log);
});

test("names and labels have no em or en dashes", () => {
	const text = [
		runName({ agent: "claude", detail: "repo" }),
		panelRunName(""),
		panelRunName("Book a table"),
		...Object.values(STATUS_LABEL),
	];
	for (const t of text) assert.doesNotMatch(t, /[–—]/);
	assert.equal(panelRunName(""), "Side panel");
});

test("typed text and a URL's query or fragment never reach the log", () => {
	let log = addStep(EMPTY_LOG, "s", step({ tool: "type", params: { text: "hunter2-secret" }, result: { ok: true } }), 1);
	log = addStep(log, "s", step({ tool: "navigate", params: { url: "https://id.example/cb?code=abc123#t=xyz" }, result: { url: "https://app.example/reset?token=s3cr3t#frag" } }), 2);
	log = addStep(log, "s", step({ tool: "tabs_create", params: {}, result: { url: "https://signed.example/f?X-Amz-Signature=deadbeef" } }), 3);
	const text = JSON.stringify(log);
	for (const secret of ["hunter2", "abc123", "xyz", "s3cr3t", "frag", "deadbeef"]) assert.ok(!text.includes(secret), `${secret} in ${text}`);
	const [run] = log.runs;
	assert.equal(run.steps[0].target, "typed 14 characters");
	assert.equal(run.steps[1].target, "id.example/cb");
	assert.equal(run.steps[1].result, "app.example/reset");
	assert.equal(run.steps[2].result, "signed.example/f");
});

test("a worker restart leaves no run waiting on the user", () => {
	let log = addStep(EMPTY_LOG, "a", step(), 1);
	log = addStep(log, "b", step(), 2);
	log = setWaiting(log, "a", true, 3);
	log = clearWaits(log, 4);
	assert.deepEqual(
		log.runs.map((r) => [r.id, r.status]).sort(),
		[
			["a", "running"],
			["b", "running"],
		],
	);
});
