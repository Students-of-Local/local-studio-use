// The market eval's floor check and ratchet (evals/market/check.mjs, README.md "Floors").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkScores, lowered, malformed, raise } from "../evals/market/check.mjs";

const floors = {
	scores: { tasks: { pass: 30, of: 30 }, domBench: { pass: 54, of: 54 } },
	ceilings_ms: { click: 90, fill: 90, firstText: 400 },
	localOnly: { rivals: "by hand" },
};
const run = (over = {}) => ({
	parts: ["tasks", "speed", "dom-bench"],
	scores: { tasks: { pass: 30, of: 30 }, domBench: { pass: 54, of: 54 } },
	speed_ms: { click: 80, fill: 70, firstText: 350 },
	domBenchRatchet: true,
	...over,
});
const dom = { passing: ["a", "b"], calls: { a: 3, b: 5 }, ms: { a: 2000, b: 2000 } };

test("a run at its floors passes, and one case or one slow verb fails it", () => {
	assert.deepEqual(checkScores(run(), floors), []);
	assert.match(checkScores(run({ scores: { tasks: { pass: 29, of: 30 }, domBench: { pass: 54, of: 54 } } }), floors).join(), /tasks: 29\/30 passed, under its floor of 30\/30/);
	assert.match(checkScores(run({ speed_ms: { click: 91, fill: 70, firstText: 350 } }), floors).join(), /speed click: median 91 ms, over its ceiling of 90 ms plus 0%/);
	// The tolerance: 10% over a 90 ms ceiling is 99 ms.
	const tol = { ...floors, tolerance_pct: 10 };
	assert.deepEqual(checkScores(run({ speed_ms: { click: 99, fill: 70, firstText: 350 } }), tol), []);
	assert.match(checkScores(run({ speed_ms: { click: 100, fill: 70, firstText: 350 } }), tol).join(), /plus 10% \(99 ms\)/);
	assert.match(checkScores(run({ domBenchRatchet: false }), floors).join(), /dom-bench\/floor.json/);
	// A run that left the flag out did not show dom-bench's floor held.
	assert.match(checkScores(run({ domBenchRatchet: undefined }), floors).join(), /dom-bench\/floor.json/);
	assert.match(checkScores(run({ speed_ms: { click: 80, fill: 70 } }), floors).join(), /firstText: not measured/);
});

test("only the parts that ran are checked", () => {
	assert.deepEqual(checkScores({ parts: ["tasks"], scores: { tasks: { pass: 30, of: 30 } } }, floors), []);
	assert.match(checkScores({ parts: ["dom-bench"], scores: {} }, floors).join(), /domBench: no score/);
});

test("the ratchet: no change passes, and every way down is named", () => {
	assert.deepEqual(lowered({ floors, dom }, { floors, dom }), []);
	const down = structuredClone(floors);
	down.scores.tasks.pass = 29;
	down.ceilings_ms.click = 91;
	delete down.ceilings_ms.fill;
	down.localOnly.speed = "too noisy";
	down.tolerance_pct = 25;
	const domDown = { passing: ["a"], calls: { a: 4 }, ms: { a: 2000 } };
	const drops = lowered({ floors, dom }, { floors: down, dom: domDown }).join("\n");
	assert.match(drops, /tasks floor went from 30 to 29/);
	assert.match(drops, /click went from 90 ms to 91 ms/);
	assert.match(drops, /fill was removed/);
	assert.match(drops, /speed was moved out of the CI gate/);
	assert.match(drops, /tolerance_pct went from 0 to 25/);
	assert.match(drops, /b left passing/);
	assert.match(drops, /a calls ceiling went from 3 to 4/);
});

test("going up is not lowering: more passes, tighter ceilings, a new dom-bench case", () => {
	const up = structuredClone(floors);
	up.scores.tasks = { pass: 33, of: 33 };
	up.ceilings_ms.click = 60;
	delete up.localOnly.rivals;
	const domUp = { passing: ["a", "b", "c"], calls: { a: 2, b: 5, c: 9 }, ms: { a: 2000, b: 2000, c: 2000 } };
	assert.deepEqual(lowered({ floors, dom }, { floors: up, dom: domUp }), []);
});

test("a base with no market floors compares dom-bench's floor alone", () => {
	assert.deepEqual(lowered({ floors: undefined, dom }, { floors, dom }), []);
	assert.match(lowered({ floors: undefined, dom }, { floors, dom: { ...dom, passing: ["a"] } }).join(), /b left passing/);
});

test("raise takes the worst of the runs and never lowers a floor", () => {
	const runs = [run(), run({ speed_ms: { click: 85, fill: 60, firstText: 380 } }), run({ scores: { tasks: { pass: 30, of: 30 }, domBench: { pass: 55, of: 55 } } })];
	const next = raise(floors, runs);
	assert.deepEqual(next.ceilings_ms, { click: 85, fill: 70, firstText: 380 });
	// No run failed a case, so the floor is all 55.
	assert.deepEqual(next.scores.domBench, { pass: 55, of: 55 });
	// A slow set of runs leaves the ceilings where they were.
	assert.deepEqual(raise(floors, [run({ speed_ms: { click: 200, fill: 200, firstText: 900 } })]).ceilings_ms, floors.ceilings_ms);
	assert.deepEqual(lowered({ floors, dom }, { floors: next, dom }), []);
});

test("the committed floors are whole and hold every part the eval runs", () => {
	const f = JSON.parse(readFileSync(new URL("../evals/market/floors.json", import.meta.url), "utf8"));
	assert.deepEqual(Object.keys(f.scores).sort(), ["domBench", "riskyActions", "tasks"]);
	// #33: Auto's rule list catches every action labeled risky.
	assert.equal(f.scores.riskyActions.pass, f.scores.riskyActions.of, "risky-action recall stays at 100%");
	assert.deepEqual(Object.keys(f.ceilings_ms).sort(), ["click", "fill", "firstText"]);
	// #30's targets: the ceilings never sit above them.
	assert.ok(f.ceilings_ms.click * (1 + f.tolerance_pct / 100) < 150);
	assert.ok(f.ceilings_ms.fill * (1 + f.tolerance_pct / 100) < 100);
	assert.ok(f.tolerance_pct <= 10, "the tolerance stays at or under 10%");
	for (const [k, why] of Object.entries(f.localOnly ?? {})) assert.ok(String(why).length > 20, `localOnly ${k} needs its reason`);
});

test("CI requires every part the floors score: a run that skipped one fails", () => {
	const skipped = run({ parts: ["tasks", "dom-bench"] });
	assert.deepEqual(checkScores(skipped, floors), []);
	assert.match(checkScores(skipped, floors, { requireAll: true }).join(), /speed: did not run, and floors.json scores it/);
	assert.deepEqual(checkScores(run(), floors, { requireAll: true }), []);
});

test("a floor that is not a number is lowered and fails the check, instead of comparing false", () => {
	for (const bad of [{ scores: { ...floors.scores, tasks: {} } }, { ceilings_ms: { ...floors.ceilings_ms, click: "x" } }, { tolerance_pct: "x" }]) {
		const head = { ...structuredClone(floors), ...bad };
		assert.ok(malformed(head).length, JSON.stringify(bad));
		assert.ok(lowered({ floors, dom }, { floors: head, dom }).length, JSON.stringify(bad));
		assert.ok(checkScores(run(), head).length, JSON.stringify(bad));
	}
	assert.deepEqual(malformed(floors), []);
});

test("new cases can't hide a broken old one: failures are held as well as passes", () => {
	const more = run({ scores: { tasks: { pass: 33, of: 36 }, domBench: { pass: 54, of: 54 } } });
	assert.match(checkScores(more, floors).join(), /tasks: 3 failed of 36, more than its floor's 0 \(30\/30\)/);
	assert.deepEqual(checkScores(run({ scores: { tasks: { pass: 36, of: 36 }, domBench: { pass: 54, of: 54 } } }), floors), []);
	// raise never grows the failure allowance: those runs give a floor they fail.
	assert.deepEqual(raise(floors, [more]).scores.tasks, { pass: 36, of: 36 });
});
