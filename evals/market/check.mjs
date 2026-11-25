// The floor check and the ratchet for the market eval (README.md, "Floors"). Imports nothing outside Node, so CI
// can run the base branch's copy of this file against a pull request's floors.
//   node evals/market/check.mjs [--require-all] [results.json]
//                                                        scores vs floors.json; exits 1 below a floor. With
//                                                        --require-all (CI), a part floors.json scores that the run
//                                                        left out fails too
//   node evals/market/check.mjs --ratchet <base-ref>     exits 1 when floors.json or cli/test/dom-bench/floor.json
//                                                        is lower than at <base-ref>, unless FLOOR_LOWERED=1 (CI sets
//                                                        it when the pull request has the floor-lowered label)
//   node evals/market/check.mjs --raise a.json b.json c.json [--write]
//                                                        the floors those runs support (worst of them), raised only
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const floorsPath = join(here, "floors.json");
const SCORE_PART = { tasks: "tasks", domBench: "dom-bench" };

const isCount = (v) => Number.isInteger(v) && v >= 0;
const isMs = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Every floor is a number: a floor that isn't one would compare false and pass anything. */
export function malformed(floors) {
	const out = [];
	for (const [k, f] of Object.entries(floors?.scores ?? {})) if (!isCount(f?.pass) || !isCount(f?.of)) out.push(`floors.json: score ${k} needs whole-number pass and of`);
	for (const [k, c] of Object.entries(floors?.ceilings_ms ?? {})) if (!isMs(c)) out.push(`floors.json: speed ceiling ${k} is not a number of ms`);
	if (floors && "tolerance_pct" in floors && !isMs(floors.tolerance_pct)) out.push("floors.json: tolerance_pct is not a number");
	return out;
}

/** The parts run.mjs must run for `floors` to be checked whole. */
export const requiredParts = (floors) => [...Object.keys(floors.scores ?? {}).map((k) => SCORE_PART[k] ?? k), ...(Object.keys(floors.ceilings_ms ?? {}).length ? ["speed"] : [])];

/**
 * What in `results` (from run.mjs) is below `floors`. Only the parts that ran are checked, unless `requireAll`: then a
 * part the floors score that the run left out fails too (CI, so a changed default part list can't skip a floor).
 */
export function checkScores(results, floors, { requireAll = false } = {}) {
	const problems = malformed(floors);
	const ran = new Set(results.parts ?? []);
	if (requireAll) for (const part of requiredParts(floors)) if (!ran.has(part)) problems.push(`${part}: did not run, and floors.json scores it`);
	for (const [k, f] of Object.entries(floors.scores ?? {})) {
		if (!ran.has(SCORE_PART[k] ?? k)) continue;
		const s = results.scores?.[k];
		if (!s || !isCount(s.pass)) problems.push(`${k}: no score in the results`);
		else if (s.pass < f.pass) problems.push(`${k}: ${s.pass}/${s.of} passed, under its floor of ${f.pass}/${f.of}`);
		// Failures are held too, so new cases can't hide a broken old one: 33/36 is over a 30/30 floor's 0 failures.
		else if (s.of - s.pass > f.of - f.pass) problems.push(`${k}: ${s.of - s.pass} failed of ${s.of}, more than its floor's ${f.of - f.pass} (${f.pass}/${f.of})`);
	}
	// Exactly true: a run that left the flag out did not show dom-bench's own floor held.
	if (ran.has("dom-bench") && results.domBenchRatchet !== true) {
		problems.push("domBench: a case in cli/test/dom-bench/floor.json failed or went over its tool-call ceiling (its table is above)");
	}
	if (ran.has("speed")) {
		const tol = floors.tolerance_pct ?? 0;
		for (const [k, ceiling] of Object.entries(floors.ceilings_ms ?? {})) {
			const v = results.speed_ms?.[k];
			const limit = ceiling * (1 + tol / 100);
			if (!isMs(v)) problems.push(`speed ${k}: not measured`);
			else if (v > limit) problems.push(`speed ${k}: median ${v} ms, over its ceiling of ${ceiling} ms plus ${tol}% (${Math.round(limit)} ms)`);
		}
	}
	return problems;
}

/** Each way `head` is lower than `base`. Both are { floors, dom } (floors.json and dom-bench's floor.json). */
export function lowered(base, head) {
	const out = malformed(head.floors);
	for (const [k, f] of Object.entries(base.floors?.scores ?? {})) {
		const h = head.floors?.scores?.[k];
		if (!h) out.push(`floors.json: score ${k} was removed`);
		else if (isCount(h.pass) && h.pass < f.pass) out.push(`floors.json: ${k} floor went from ${f.pass} to ${h.pass}`);
	}
	for (const [k, c] of Object.entries(base.floors?.ceilings_ms ?? {})) {
		const h = head.floors?.ceilings_ms?.[k];
		if (h === undefined) out.push(`floors.json: speed ceiling ${k} was removed`);
		else if (isMs(h) && h > c) out.push(`floors.json: speed ceiling ${k} went from ${c} ms to ${h} ms`);
	}
	if (base.floors && isMs(head.floors?.tolerance_pct ?? 0) && (head.floors?.tolerance_pct ?? 0) > (base.floors.tolerance_pct ?? 0)) {
		out.push(`floors.json: tolerance_pct went from ${base.floors.tolerance_pct ?? 0} to ${head.floors.tolerance_pct}`);
	}
	// A first floors.json lowers nothing; after that, a new localOnly entry takes a part out of the gate.
	for (const k of base.floors ? Object.keys(head.floors?.localOnly ?? {}) : []) {
		if (!(k in (base.floors.localOnly ?? {}))) out.push(`floors.json: ${k} was moved out of the CI gate (localOnly)`);
	}
	const headPassing = new Set(head.dom?.passing ?? []);
	for (const id of base.dom?.passing ?? []) if (!headPassing.has(id)) out.push(`dom-bench floor.json: ${id} left passing`);
	for (const field of ["calls", "ms"]) {
		for (const [id, v] of Object.entries(base.dom?.[field] ?? {})) {
			const h = head.dom?.[field]?.[id];
			if (headPassing.has(id) && (typeof h !== "number" || h > v)) out.push(`dom-bench floor.json: ${id} ${field} ceiling went from ${v} to ${h ?? "none"}`);
		}
	}
	return out;
}

/** The floors a set of runs supports: each score's worst pass count, each speed's worst median, never lower. */
export function raise(floors, runs) {
	const next = structuredClone(floors);
	next.scores ??= {};
	next.ceilings_ms ??= {};
	for (const k of new Set(runs.flatMap((r) => Object.keys(r.scores ?? {})))) {
		const got = runs.map((r) => r.scores?.[k]);
		if (got.some((s) => !s)) continue;
		const of = Math.max(...got.map((s) => s.of));
		const cur = next.scores[k];
		// The worst run's failures, and the failure allowance (of - pass) never grows.
		const worstFailed = Math.max(...got.map((s) => s.of - s.pass));
		const failed = cur ? Math.min(worstFailed, cur.of - cur.pass) : worstFailed;
		const pass = Math.max(cur?.pass ?? 0, of - failed);
		if (!cur || pass !== cur.pass || of !== cur.of) next.scores[k] = { pass, of };
	}
	for (const k of new Set(runs.flatMap((r) => Object.keys(r.speed_ms ?? {})))) {
		const got = runs.map((r) => r.speed_ms?.[k]);
		if (got.some((v) => typeof v !== "number")) continue;
		const worst = Math.max(...got);
		const cur = next.ceilings_ms[k];
		if (typeof cur !== "number" || worst < cur) next.ceilings_ms[k] = worst;
	}
	return next;
}

export const formatProblems = (p) => p.map((x) => `  ${x}`).join("\n");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// The checkout being judged: browser/ in the git root of the working directory, not this file's folder, because CI runs
// the base branch's copy of this file from outside the checkout.
const root = () => join(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), "browser");

function atRef(ref, path) {
	try {
		return JSON.parse(execFileSync("git", ["show", `${ref}:./${path}`], { cwd: root(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
	} catch {
		return undefined;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	if (argv[0] === "--ratchet") {
		const ref = argv[1];
		if (!ref) {
			console.error("--ratchet needs a base ref");
			process.exit(2);
		}
		const base = { floors: atRef(ref, "evals/market/floors.json"), dom: atRef(ref, "cli/test/dom-bench/floor.json") };
		const head = { floors: readJson(join(root(), "evals", "market", "floors.json")), dom: readJson(join(root(), "cli", "test", "dom-bench", "floor.json")) };
		if (!base.floors) console.log(`${ref} has no evals/market/floors.json yet: only dom-bench's floor is compared`);
		const drops = lowered(base, head);
		if (!drops.length) {
			console.log(`no floor is lower than at ${ref}`);
			process.exit(0);
		}
		if (process.env.FLOOR_LOWERED === "1") {
			console.log(`floors lowered, accepted by the floor-lowered label:\n${formatProblems(drops)}`);
			process.exit(0);
		}
		console.error(`this change lowers a floor, and a floor only goes up:\n${formatProblems(drops)}\nIf the drop is right (a case was wrong, not the tool), write why in floors.json or floor.json and have a maintainer add the floor-lowered label.`);
		process.exit(1);
	}
	if (argv[0] === "--raise") {
		const files = argv.slice(1).filter((a) => !a.startsWith("--"));
		if (!files.length) {
			console.error("--raise needs one or more results files");
			process.exit(2);
		}
		const runs = files.map(readJson);
		const next = raise(readJson(floorsPath), runs);
		next.measured = {
			rule: `worst of ${runs.length} runs; a score only goes up and a ceiling only goes down`,
			runs: runs.map((r) => ({ at: r.at, commit: r.commit, runner: r.runner, scores: r.scores, speed_ms: r.speed_ms })),
		};
		const text = `${JSON.stringify(next, null, "\t")}\n`;
		if (argv.includes("--write")) writeFileSync(floorsPath, text);
		process.stdout.write(text);
		process.exit(0);
	}
	const requireAll = argv.includes("--require-all");
	const file = argv.find((a) => !a.startsWith("--"));
	// The checkout's floors, not this file's folder's: CI runs the base branch's copy from outside the checkout.
	const results = readJson(file ?? join(root(), "evals", "market", "results", "last.json"));
	const problems = checkScores(results, readJson(join(root(), "evals", "market", "floors.json")), { requireAll });
	if (problems.length) {
		console.error(`below the floor:\n${formatProblems(problems)}`);
		process.exit(1);
	}
	console.log("every score is at or above its floor and every speed at or under its ceiling");
}
