// The published market results page (evals/market/page.mjs, evals/market/README.md "Results page"): docs/market.md is
// built from evals/market/published/ and never edited by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadPublished, losses, pagePath, render, trimRun } from "../evals/market/page.mjs";

test("docs/market.md is exactly what evals/market/published/ gives (node evals/market/page.mjs rewrites it)", () => {
	assert.equal(readFileSync(pagePath, "utf8"), render(loadPublished()));
});

const machine = { os: "macOS 1", arch: "arm64", cpu: "M", cores: 8, memGB: 16 };
const run = (tool, over = {}) => ({
	tool,
	version: "1",
	machine,
	node: "v22",
	chromium: "Chromium 1",
	load1: { start: 1, end: 2 },
	repeat: 3,
	speedN: 9,
	tasks: { pass: 30, of: 30, failed: {} },
	startMs: 1000,
	speed_ms: { click: 50, fill: 50, firstText: 200 },
	errors: {},
	...over,
});
const batch = (rival) => ({ date: "2026-01-01", runs: { "local-studio-browser": run("local-studio-browser"), rival }, install: undefined });

test("a changed number changes the page, so the check above can fail", () => {
	const a = render([batch(run("rival"))]);
	const b = render([batch(run("rival", { speed_ms: { click: 51, fill: 50, firstText: 200 } }))]);
	assert.notEqual(a, b);
});

test("each metric a rival wins is listed as a loss, with both numbers", () => {
	assert.deepEqual(losses(batch(run("rival"))), []);
	const lost = losses(batch(run("rival", { speed_ms: { click: 20, fill: 60, firstText: 200 }, tasks: { pass: 29, of: 30, failed: {} } })));
	assert.deepEqual(lost, [{ metric: "Click, ms (median)", ours: 50, best: { tool: "rival", value: 20 } }]);
	assert.match(render([batch(run("rival", { speed_ms: { click: 20, fill: 60, firstText: 200 } }))]), /- Click, ms \(median\): Local Studio 50, rival 20\./);
});

test("a published run keeps numbers and failed task ids, never rows or page text", () => {
	const raw = {
		tool: "rival",
		at: "2026-01-01T00:00:00Z",
		env: { version: "1", machine },
		scores: { tasks: { pass: 1, of: 2 } },
		speed_ms: { click: 1, fill: 2, firstText: 3 },
		startMs: 9,
		detail: { tasks: [{ task: "t01-read", pass: false, why: "answer=\"secret page text\"" }, { task: "t02-form", pass: true }], speedError: "timed out\nstack" },
	};
	const kept = trimRun(raw);
	assert.deepEqual(kept.tasks, { pass: 1, of: 2, failed: { "t01-read": 1 } });
	assert.deepEqual(kept.errors, { speed: "timed out" });
	assert.equal(JSON.stringify(kept).includes("secret page text"), false);
	assert.equal("detail" in kept, false);
});
