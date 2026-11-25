// Run the scripted task set against Local Studio. Exits 1 unless every run passes.
//   node evals/market/tasks/run.mjs [--only t01-read,t02-form] [--repeat 3] [--out file.jsonl]
// The market eval (../run.mjs) runs the same loop and gates it on ../floors.json; this is the task set alone.
import { driver, startLocalStudio } from "./lib.mjs";
import { runTasks } from "./loop.mjs";
import { startSite } from "./server.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const repeat = Number(opt("--repeat", 1));

const site = await startSite();
const t0 = Date.now();
const ctx = await startLocalStudio();
console.error(`local-studio-browser: started in ${Date.now() - t0} ms; site ${site.origin}`);
let rows = [];
try {
	rows = await runTasks({
		site,
		makeDriver: () => driver(ctx),
		repeat,
		only: opt("--only")?.split(","),
		out: opt("--out"),
		// A dialog left open would freeze the next task's navigation.
		between: () => ctx.call("handle_dialog", { accept: false }).catch(() => {}),
	});
} finally {
	await ctx.h.stop();
	await site.stop();
}
const passed = rows.filter((r) => r.pass).length;
console.log(`task set: ${passed}/${rows.length} passed over ${repeat} rep(s), ${rows.reduce((a, r) => a + r.steps, 0)} tool calls, ${rows.reduce((a, r) => a + r.ms, 0)} ms`);
process.exit(passed === rows.length && rows.length > 0 ? 0 : 1);
