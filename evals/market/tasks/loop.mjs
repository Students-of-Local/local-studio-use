// The two measurements every tool gets, written once so Local Studio (run.mjs, speed.mjs, ../run.mjs) and the rivals
// (../rivals/run.mjs) are measured the same way: the scripted task set, and the per-verb speed on t02's form.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { solves } from "./solves.mjs";
import { tasks } from "./tasks.mjs";

export const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms))]);

/**
 * Run the task set `repeat` times. Each task: fresh site state, start page loaded, solve, then the check reads what
 * the page posted. `makeDriver()` gives a fresh driver (verbs in lib.mjs); `between()` runs after each task.
 * Returns one row per run: { task, rep, pass, steps, ms, error, why }.
 */
export async function runTasks({ site, makeDriver, repeat = 1, only, out, between, log = console.error }) {
	if (out) mkdirSync(dirname(out), { recursive: true });
	const rows = [];
	for (let rep = 0; rep < repeat; rep++) {
		for (const task of tasks.filter((t) => !only || only.includes(t.id))) {
			site.reset();
			const start = Date.now();
			let answer;
			let error;
			const d = makeDriver();
			try {
				await withTimeout(d.open(`${site.origin}${task.start}`), 30_000);
				answer = await withTimeout(solves[task.id](d, { fixtures, site }), 90_000);
			} catch (e) {
				error = String(e.message ?? e).split("\n")[0].slice(0, 300);
			} finally {
				d.s.cancel();
			}
			let verdict = { pass: false, why: "" };
			const end = Date.now() + 3000;
			for (;;) {
				verdict = task.check({ state: site.state(task.id), answer, site });
				if (verdict.pass || Date.now() > end) break;
				await new Promise((r) => setTimeout(r, 200));
			}
			const row = { task: task.id, rep, pass: verdict.pass, steps: d.s.calls, ms: Date.now() - start, error, why: verdict.pass ? undefined : verdict.why };
			rows.push(row);
			if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
			log(`${verdict.pass ? "ok  " : "FAIL"} rep ${rep} ${task.id} steps=${row.steps} ${row.ms}ms${error ? ` err=${error}` : ""}${verdict.pass ? "" : ` why=${verdict.why.slice(0, 160)}`}`);
			await between?.();
		}
	}
	return rows;
}

const median = (a) => Math.round([...a].sort((x, y) => x - y)[a.length >> 1]);

/**
 * Median ms per verb on t02's form, the study's way (lib/latency.mjs there): navigate, the first page text
 * (get_page_text right after the load), read_page, fill the Full name box, click the Phone radio. `firstText` is
 * navigate plus that first text: how long an agent waits from a URL to words it can read.
 */
export async function measureSpeed({ site, makeDriver, N = 5 }) {
	const t = {};
	const time = async (k, f) => {
		const s = performance.now();
		const r = await f();
		t[k] ??= [];
		t[k].push(performance.now() - s);
		return r;
	};
	for (let i = 0; i < N; i++) {
		site.reset();
		const d = makeDriver();
		const s0 = performance.now();
		await time("navigate", () => d.open(`${site.origin}/t02-form/`));
		const text = await time("pageText", () => d.text());
		(t.firstText ??= []).push(performance.now() - s0);
		if (!/full name/i.test(String(text))) throw new Error("the first page text does not hold the form's labels");
		const n = await time("snapshot", () => d.nodes());
		const name = n.find((x) => /textbox/i.test(x.role) && /full name/i.test(x.name) && x.ref);
		await time("fill", () => d.fill(name, `Ada ${i}`));
		const radio = n.find((x) => /radio/i.test(x.role) && /phone/i.test(x.name));
		await time("click", () => d.check(radio));
	}
	return {
		N,
		median_ms: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, median(v)])),
		runs_ms: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.map((x) => Math.round(x))])),
	};
}
