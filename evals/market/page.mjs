// The published market results (README.md, "Results page"): docs/market.md, built only from evals/market/published/.
//   node evals/market/page.mjs                 write docs/market.md from the published runs
//   node evals/market/page.mjs --check         exit 1 when docs/market.md is not what the published runs give
//   node evals/market/page.mjs --add <date> results/rival-*.json results/install.json
//                                              keep those runs in published/<date>/ (numbers only), then write the page
// A published run holds the scores, the medians, the versions and the machine: no rows, no page text, no host name.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const publishedDir = join(here, "published");
export const pagePath = join(here, "..", "..", "docs", "market.md");

/** This product's tool name in the runs. */
const OURS = "local-studio-browser";
const NAMES = { [OURS]: "Local Studio", "agent-browser": "agent-browser", browse: "browse", "chrome-devtools-mcp": "Chrome DevTools MCP", "playwright-mcp": "Playwright MCP" };
const name = (tool) => NAMES[tool] ?? tool;
const short = (e) => (e ? String(e).split("\n")[0].slice(0, 120) : undefined);

/** One run of rivals/run.mjs, trimmed to what the page shows. */
export function trimRun(r) {
	const failed = {};
	for (const row of r.detail?.tasks ?? []) if (!row.pass) failed[row.task] = (failed[row.task] ?? 0) + 1;
	const errors = Object.fromEntries(["start", "tasks", "speed"].map((p) => [p, short(r.detail?.[`${p}Error`])]).filter(([, v]) => v));
	return { tool: r.tool, at: r.at, ...r.env, tasks: r.scores?.tasks ? { ...r.scores.tasks, failed } : undefined, startMs: r.startMs, speed_ms: r.speed_ms, errors };
}

/** Every published batch, newest first: { date, runs: { tool: run }, install }. */
export function loadPublished(dir = publishedDir) {
	const read = (p) => JSON.parse(readFileSync(p, "utf8"));
	return readdirSync(dir)
		.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
		.sort()
		.reverse()
		.map((date) => {
			const files = readdirSync(join(dir, date)).filter((f) => f.endsWith(".json")).sort();
			const runs = Object.fromEntries(files.filter((f) => f !== "install.json").map((f) => [basename(f, ".json"), read(join(dir, date, f))]));
			return { date, runs, install: files.includes("install.json") ? read(join(dir, date, "install.json")) : undefined };
		});
}

/** The page's rows: label, how to read a run, and which way is better. */
const METRICS = [
	{ key: "tasks", label: "Task success", get: (r) => r.tasks && r.tasks.pass / r.tasks.of, show: (r) => r.tasks && `${r.tasks.pass}/${r.tasks.of}`, better: "high" },
	{ key: "startMs", label: "Cold start to first page text, ms", get: (r) => r.startMs, better: "low" },
	{ key: "firstText", label: "First page text, ms (navigate plus read, median)", get: (r) => r.speed_ms?.firstText, better: "low" },
	{ key: "click", label: "Click, ms (median)", get: (r) => r.speed_ms?.click, better: "low" },
	{ key: "fill", label: "Fill, ms (median)", get: (r) => r.speed_ms?.fill, better: "low" },
	{ key: "installMs", label: "Install from nothing, s (median)", get: (r, i) => i?.ms, show: (r, i) => i && (i.ms / 1000).toFixed(1), better: "low" },
	{ key: "installSteps", label: "Install steps", get: (r, i) => i?.steps, better: "low" },
];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const beats = (m, a, b) => (m.better === "high" ? a > b : a < b);

/** Each metric where a rival is better than Local Studio: { metric, ours, best: { tool, value } }. */
export function losses(batch) {
	const t = batch.runs[OURS];
	if (!t) return [];
	const out = [];
	for (const m of METRICS) {
		const mine = m.get(t, batch.install?.tools?.[OURS]);
		if (!isNum(mine)) continue;
		let best;
		for (const [tool, r] of Object.entries(batch.runs)) {
			const v = m.get(r, batch.install?.tools?.[tool]);
			if (tool !== OURS && isNum(v) && beats(m, v, mine) && (!best || beats(m, v, best.v))) best = { tool, v, shown: (m.show ?? m.get)(r, batch.install?.tools?.[tool]) };
		}
		if (best) out.push({ metric: m.label, ours: (m.show ?? m.get)(t, batch.install?.tools?.[OURS]), best: { tool: name(best.tool), value: best.shown } });
	}
	return out;
}

const range = (xs) => {
	const v = xs.filter(isNum);
	return v.length ? `${Math.min(...v)} to ${Math.max(...v)}` : "not recorded";
};

function renderBatch({ date, runs, install }) {
	const tools = Object.keys(runs).sort((a, b) => (a === OURS ? -1 : b === OURS ? 1 : name(a).localeCompare(name(b))));
	const any = runs[OURS] ?? runs[tools[0]];
	const m = any.machine ?? {};
	const lines = [`## ${date}`, ""];
	lines.push(
		`Machine: ${m.os}, ${m.arch}, ${m.cpu} (${m.cores} cores, ${m.memGB} GB). Node ${any.node}. Browser for every tool: ${any.chromium}, headless, in a throwaway profile. ` +
			`Each tool ran the task set ${any.repeat} times and the speed check ${any.speedN} times, one tool after another. ` +
			`The 1-minute load average during the runs was ${range(tools.flatMap((t) => [runs[t].load1?.start, runs[t].load1?.end]))}, so read the times against each other, not as absolutes.`,
		"",
	);
	lines.push(`| | ${tools.map(name).join(" | ")} |`, `|---|${tools.map(() => "---").join("|")}|`);
	lines.push(`| Version | ${tools.map((t) => runs[t].version ?? "unknown").join(" | ")} |`);
	lines.push(`| Load average (1 min), start and end of its run | ${tools.map((t) => `${runs[t].load1?.start ?? "?"}, ${runs[t].load1?.end ?? "?"}`).join(" | ")} |`);
	for (const met of METRICS) {
		const vals = tools.map((t) => met.get(runs[t], install?.tools?.[t]));
		const best = vals.filter(isNum).reduce((b, v) => (b === undefined || beats(met, v, b) ? v : b), undefined);
		const cells = tools.map((t, i) => {
			const shown = (met.show ?? met.get)(runs[t], install?.tools?.[t]);
			if (!isNum(vals[i])) return "not measured";
			return vals[i] === best ? `**${shown}**` : String(shown);
		});
		lines.push(`| ${met.label} | ${cells.join(" | ")} |`);
	}
	lines.push("", "The best value in each row is in bold.", "");
	const lost = losses({ runs, install });
	lines.push("### Where Local Studio is behind", "");
	if (!lost.length) lines.push("Nowhere: Local Studio is best or tied on every metric.");
	for (const l of lost) lines.push(`- ${l.metric}: Local Studio ${l.ours}, ${l.best.tool} ${l.best.value}.`);
	lines.push("", "### Failed task runs", "");
	for (const t of tools) {
		const f = Object.entries(runs[t].tasks?.failed ?? {}).sort(([a], [b]) => a.localeCompare(b));
		const errs = Object.entries(runs[t].errors ?? {}).map(([p, e]) => `${p} stopped: ${e}`);
		lines.push(`- ${name(t)}: ${f.length ? f.map(([id, n]) => `${id} (${n})`).join(", ") : "none"}${errs.length ? `. ${errs.join("; ")}` : ""}`);
	}
	if (install) {
		lines.push("", "### Install", "");
		for (const t of tools.filter((x) => install.tools?.[x])) {
			const i = install.tools[t];
			lines.push(`- ${name(t)}: \`${i.installed}\`${i.release ? ` (release ${i.release})` : ""}, ${i.steps} step${i.steps === 1 ? "" : "s"} (${i.stepList.join("; ")}). Source: ${i.source}`);
		}
	}
	lines.push("");
	return lines;
}

const METHOD = `## Method

Every tool runs the same code: \`evals/market/tasks/solves.mjs\` solves the ten tasks in \`evals/market/tasks/\` through
each tool's own verbs (\`evals/market/rivals/drivers.mjs\`), finding every target by role and accessible name in that
tool's snapshot, and each task passes only on what the local test site received. No model is involved, so a failure is
the tool's.

- Task success: passes out of 10 tasks times the repeat count.
- Cold start to first page text: from nothing running to the first page's text, in a session of its own.
- First page text, click and fill: medians on t02's form (\`measureSpeed\` in \`evals/market/tasks/loop.mjs\`).
- Install from nothing: \`evals/market/rivals/install-time.mjs\`, each rep in a new folder with an empty npm cache.
  No browser download is timed. Local Studio's browser tools come with its app, so there is no install of their own to
  time; a run from before that shows the time of the installer it had.
- Install steps: the steps from nothing to an agent driving a page, as each tool's README writes them.

To add a run: \`evals/market/rivals/install.sh\`, \`node evals/market/rivals/run.mjs --tool <tool> --repeat 3\` for each
tool, \`node evals/market/rivals/install-time.mjs\`, then \`node evals/market/page.mjs --add <date> evals/market/results/*.json\`.
`;

export function render(batches) {
	const lines = [
		"# Market results",
		"",
		"<!-- Generated by node evals/market/page.mjs from evals/market/published/. Do not edit by hand: test/market-page.test.mjs fails when this page and those files disagree. -->",
		"",
		"Local Studio against the browser tools agents use today, measured by the market eval (`evals/market`) on one machine,",
		"newest run first.",
		"",
	];
	for (const b of batches) lines.push(...renderBatch(b));
	return `${lines.join("\n")}\n${METHOD}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	if (argv[0] === "--add") {
		const date = argv[1];
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
			console.error("--add needs a date (YYYY-MM-DD) and the results files");
			process.exit(2);
		}
		mkdirSync(join(publishedDir, date), { recursive: true });
		for (const file of argv.slice(2)) {
			const r = JSON.parse(readFileSync(file, "utf8"));
			if (!r.tool && !r.tools) {
				console.error(`skipped ${file}: not a rivals/run.mjs or install-time.mjs result`);
				continue;
			}
			const [outName, data] = r.tools ? ["install", { at: r.at, reps: r.reps, tools: r.tools }] : [r.tool, trimRun(r)];
			writeFileSync(join(publishedDir, date, `${outName}.json`), `${JSON.stringify(data, null, "\t")}\n`);
			console.log(`kept ${file} as published/${date}/${outName}.json`);
		}
	}
	const text = render(loadPublished());
	if (argv[0] === "--check") {
		const now = readFileSync(pagePath, "utf8");
		if (now !== text) {
			console.error("docs/market.md does not match evals/market/published/: run node evals/market/page.mjs and commit the page");
			process.exit(1);
		}
		console.log("docs/market.md matches evals/market/published/");
	} else {
		writeFileSync(pagePath, text);
		console.log(`wrote ${pagePath}`);
	}
}
