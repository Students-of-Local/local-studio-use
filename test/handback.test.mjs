// Hand-back with Continue (src/handback/state.ts): an agent waits for the user on one of its tabs. What the veil does
// while it waits (src/browser/veil-state.ts), what the agent reads when the wait ends, and the copy the user sees. The
// whole flow, panel and pill, runs in cli/test/e2e-panel.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VEIL_CSS } from "../src/browser/veil-page.ts";
import { EMPTY_VEIL, nextWake, VEIL_IDLE_MS, veilStep } from "../src/browser/veil-state.ts";
import { cleanReason, HANDBACK_TIMEOUT_MS, handbackOutcome, openHandbacks, REASON_MAX } from "../src/handback/state.ts";

const view = { agent: "Claude", detail: "demo-shop", color: "blue" };
const S = "bridge-claude-demo";

function run(events, start = EMPTY_VEIL) {
	let state = start;
	const effects = [];
	let wakeAt;
	for (const e of events) {
		const step = veilStep(state, e);
		state = step.state;
		effects.push(...step.effects);
		wakeAt = step.wakeAt;
	}
	return { state, effects, wakeAt };
}

const wait = (at, reason) => ({ type: "wait", tabId: 1, sessionId: S, view, reason, at });
const end = (at) => ({ type: "end", tabId: 1, sessionId: S, view, input: false, at });

test("a wait on a tab with no veil draws one with Continue, and it never fades while the user has the tab", () => {
	const r = run([wait(0, "Sign in")]);
	assert.deepEqual(r.effects, [
		{ kind: "show", tabId: 1, view, interactive: true, concealed: false, waiting: "Sign in" },
	]);
	assert.equal(r.state.tabs[1].waiting, "Sign in");
	assert.equal(r.wakeAt, undefined, "no fade is scheduled");
	const later = veilStep(r.state, { type: "tick", at: VEIL_IDLE_MS * 40 });
	assert.deepEqual(later.effects, [], "an hour later it still shows");
	assert.ok(later.state.tabs[1]);
});

test("a wait on a veiled tab only adds Continue, and ending it removes Continue and fades later", () => {
	const r = run([end(0), wait(10, "Enter the code we sent you")]);
	assert.deepEqual(r.effects.at(-1), { kind: "waiting", tabId: 1, reason: "Enter the code we sent you" });
	assert.equal(nextWake(r.state), undefined);
	const done = run([wait(5000)], r.state);
	assert.deepEqual(done.effects, [{ kind: "waiting", tabId: 1 }]);
	assert.equal(done.state.tabs[1].waiting, undefined);
	assert.equal(done.wakeAt, 5000 + VEIL_IDLE_MS, "the quiet time starts when the wait ends");
	assert.deepEqual(run([wait(6000)], done.state).effects, [], "ending twice does nothing");
	assert.deepEqual(run([wait(0)]).effects, [], "ending a wait that never began draws nothing");
});

test("a new document and a change of agent name keep Continue on the pill", () => {
	const r = run([wait(0, "Sign in"), { type: "navigated", tabId: 1 }]);
	assert.equal(r.effects.at(-1).waiting, "Sign in");
	const renamed = run([{ type: "begin", tabId: 1, sessionId: S, view: { ...view, detail: "other" }, input: false, at: 5 }], r.state);
	assert.equal(renamed.effects[0].kind, "show");
	assert.equal(renamed.effects[0].waiting, "Sign in");
});

test("taking the tab back drops the veil and its Continue at once", () => {
	const r = run([wait(0, "Sign in"), { type: "drop", tabId: 1 }]);
	assert.deepEqual(r.effects.at(-1), { kind: "hide", tabId: 1, fade: false });
	assert.equal(r.state.tabs[1], undefined);
});

test("the pill's Continue is styled only while waiting, and takes no clicks while the agent's input runs", () => {
	assert.match(VEIL_CSS, /\.go \{\s*display: none;/);
	assert.match(VEIL_CSS, /\.veil\.waiting \.go \{ display: inline-block; \}/);
	assert.match(VEIL_CSS, /\.veil\.locked \.go, \.veil\.leaving \.go, \.veil\.concealed \.go \{ pointer-events: none; \}/);
	const page = readFileSync(new URL("../src/browser/veil-page.ts", import.meta.url), "utf8");
	assert.match(page, /if \(!e\.isTrusted \|\| !box\.classList\.contains\("waiting"\)\) return;/, "only a real click while waiting");
	const worker = readFileSync(new URL("../src/browser/veil.ts", import.meta.url), "utf8");
	assert.match(worker, /if \(state\.tabs\[tabId\]\.waiting === undefined\) return;/, "the worker checks the wait too");
});

test("the reason is one short plain line", () => {
	assert.equal(cleanReason("  Sign\nin\tto   GitHub  "), "Sign in to GitHub");
	assert.equal(cleanReason(""), "Your turn");
	assert.equal(cleanReason(undefined), "Your turn");
	assert.equal(cleanReason(42), "Your turn");
	assert.equal(cleanReason(`a${String.fromCharCode(0)}b`), "a b");
	const long = cleanReason("x".repeat(500));
	assert.equal(long.length, REASON_MAX);
	assert.ok(long.endsWith("..."));
});

test("the agent reads how the wait ended, and only Continue says to go on", () => {
	const continued = handbackOutcome("continued", 7, "Sign in");
	assert.equal(continued.status, "continued");
	assert.match(continued.text, /^The user pressed Continue on tab 7 \(Sign in\)\. The tab is still yours/);
	assert.match(handbackOutcome("taken", 7, "Sign in").text, /took tab 7 back.*can't use it/);
	assert.match(handbackOutcome("closed", 7, "Sign in").text, /closed tab 7/);
	assert.match(handbackOutcome("timeout", 7, "Sign in", HANDBACK_TIMEOUT_MS).text, /No Continue after 10 minutes/);
	assert.match(handbackOutcome("disconnected", 7, "x").text, /connection closed/);
	assert.match(handbackOutcome("aborted", 7, "x").text, /You stopped waiting/);
	for (const end of ["taken", "closed", "timeout", "disconnected", "aborted"])
		assert.doesNotMatch(handbackOutcome(end, 7, "x").text, /then go on\.$/, end);
});

test("only open, well-formed waits are listed, oldest first", () => {
	const now = 1000;
	const p = (id, createdAt, expiresAt, tabId = 3) => ({ id, tabId, createdAt, expiresAt });
	const list = openHandbacks([p("b", 20, 2000), p("a", 10, 2000), p("old", 5, 999), p("bad", 1, 2000, "3"), null], now);
	assert.deepEqual(
		list.map((x) => x.id),
		["a", "b"],
	);
	assert.deepEqual(openHandbacks(undefined, now), []);
	assert.deepEqual(openHandbacks({}, now), []);
});

test("the hand-back copy has no em or en dashes", () => {
	for (const file of ["../src/handback/state.ts", "../src/handback/panel.ts", "../src/handback/worker.ts", "../cli/src/handback.ts"]) {
		const text = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.doesNotMatch(text, /[–—]/, file);
	}
});
