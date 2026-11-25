// The speed check alone: median ms per verb on the t02 form page (loop.mjs, measureSpeed). Prints the medians and
// the runs as JSON. It gates nothing by itself: ../run.mjs compares the medians with ../floors.json.
//   node evals/market/tasks/speed.mjs [N=5]
import { driver, startLocalStudio } from "./lib.mjs";
import { measureSpeed } from "./loop.mjs";
import { startSite } from "./server.mjs";

const N = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 5);
const site = await startSite();
const ctx = await startLocalStudio();
try {
	console.log(JSON.stringify(await measureSpeed({ site, makeDriver: () => driver(ctx), N })));
} finally {
	await ctx.h.stop();
	await site.stop();
}
