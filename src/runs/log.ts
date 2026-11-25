/**
 * The runs log: every agent run in the browser, an outside agent's over the bridge or the side panel's own, with its
 * status and a timeline of its steps (tool, target, result, ms) and each step's change report. Pure: the service worker
 * records into it (src/runs/worker.ts) and keeps it in chrome.storage.local under RUNS_KEY; the side panel's Runs view
 * reads it (src/runs/panel.ts).
 *
 * Capped, so it never grows without end: MAX_RUNS runs, MAX_STEPS steps a run, REPORT_MAX characters a report, and the
 * whole log under MAX_BYTES (oldest runs go first). Screenshots and other large values never enter a report.
 */

export const RUNS_KEY = "runs_log";
/** The panel tells the worker its run ended (src/runs/worker.ts). */
export const RUNS_MESSAGE = "local-studio-runs";
export const MAX_RUNS = 25;
export const MAX_STEPS = 80;
export const REPORT_MAX = 800;
export const TARGET_MAX = 80;
export const MAX_BYTES = 1_000_000;

export type RunStatus = "running" | "waiting" | "done" | "failed";

export interface RunStep {
	at: number;
	/** The bridge method ("click", "navigate"). */
	tool: string;
	/** What it acted on: a ref, a URL, a tab. */
	target: string;
	ok: boolean;
	/** One line: what it returned, or its error. */
	result: string;
	ms: number;
	/** The change report, when the step returned one. */
	report?: string;
	/** The permission mode the step ran under ("manual", "auto" or "yolo"), so a run can be audited (D67). */
	mode?: string;
}

export interface Run {
	/** The browser session's id. */
	id: string;
	/** Who ran it ("Claude · local-studio-browser", "Side panel"). */
	who: string;
	status: RunStatus;
	tabId?: number;
	tabTitle?: string;
	startedAt: number;
	updatedAt: number;
	steps: RunStep[];
	/** Steps dropped from the front to keep MAX_STEPS. */
	dropped: number;
}

export interface RunsLog {
	runs: Run[];
}

export const EMPTY_LOG: RunsLog = { runs: [] };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** A URL as host and path: its query and fragment can carry a token (an OAuth code, a reset link), so they never go in the log. */
function urlShape(url: string): string {
	try {
		const u = new URL(url);
		return `${u.host}${u.pathname === "/" ? "" : u.pathname}` || u.protocol;
	} catch {
		return oneLine(url).replace(/[?#].*$/, "");
	}
}

/**
 * What a step acted on, from its params: a ref or a name, else a URL's host and path, else a tab. Typed text is
 * never kept (it can be a password or a code the user gave the agent), only its length.
 */
export function stepTarget(params: Record<string, unknown> | undefined, tabId?: number): string {
	const p = params ?? {};
	const pick = (k: string) => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string) : undefined);
	const ref = pick("ref") ?? pick("element") ?? pick("selector") ?? pick("query") ?? pick("reason");
	if (ref) return clip(oneLine(ref), TARGET_MAX);
	const url = pick("url");
	if (url) return clip(urlShape(url), TARGET_MAX);
	if (typeof p.text === "string" && p.text) return `typed ${p.text.length} characters`;
	if (typeof p.x === "number" && typeof p.y === "number") return `${Math.round(p.x)}, ${Math.round(p.y)}`;
	if (typeof p.key === "string") return clip(p.key, TARGET_MAX);
	const tab = typeof p.tabId === "number" ? p.tabId : tabId;
	return tab === undefined ? "" : `tab ${tab}`;
}

/** Keys that hold images or page dumps: never copied into the log. */
const BULKY = new Set(["data", "image", "screenshot", "base64", "html", "text", "content", "snapshot", "tree"]);

/** The change report a step returned, if any: its `changes` or `effect`, cut to REPORT_MAX. */
export function stepReport(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const r = result as Record<string, unknown>;
	const line = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x));
	for (const key of ["changes", "effect", "report"]) {
		const v = r[key];
		if (typeof v === "string" && v.trim()) return clip(v.trim(), REPORT_MAX);
		if (Array.isArray(v) && v.length) return clip(v.map(line).join("\n"), REPORT_MAX);
		if (typeof v === "object" && v !== null) {
			// The bridge's change report: { page: "...", new: [...], gone: [...] }.
			const lines = Object.entries(v as Record<string, unknown>)
				.filter(([k, x]) => !BULKY.has(k) && x !== undefined && x !== null && !(Array.isArray(x) && x.length === 0))
				.map(([k, x]) =>
					Array.isArray(x) ? `${k}:\n${x.map((i) => `  ${line(i)}`).join("\n")}` : `${k}: ${line(x)}`,
				);
			if (lines.length) return clip(lines.join("\n"), REPORT_MAX);
		}
	}
	return undefined;
}

/** One line on what a step returned: its error, else its url and title, else its small fields. */
export function stepResult(result: unknown, error?: string): string {
	if (error) return clip(oneLine(error), 160);
	if (result === undefined || result === null) return "ok";
	if (typeof result !== "object") return clip(oneLine(String(result)), 160);
	const r = result as Record<string, unknown>;
	if (typeof r.title === "string" && r.title) return clip(oneLine(r.title), 160);
	if (typeof r.url === "string") return clip(urlShape(r.url), 160);
	const small = Object.entries(r)
		.filter(
			([k, v]) =>
				!BULKY.has(k) &&
				(typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 60)),
		)
		.slice(0, 4)
		.map(([k, v]) => `${k}: ${v}`);
	return small.length ? clip(small.join(", "), 160) : "ok";
}

function withRun(log: RunsLog, id: string, now: number, make: () => Run, edit: (run: Run) => void): RunsLog {
	const runs = log.runs.filter((r) => r.id !== id);
	const old = log.runs.find((r) => r.id === id);
	const run: Run = old ? { ...old, steps: [...old.steps] } : make();
	edit(run);
	run.updatedAt = now;
	return cap({ runs: [run, ...runs] });
}

/** Keep the log inside its caps: newest runs first, oldest dropped. */
export function cap(log: RunsLog): RunsLog {
	const runs = [...log.runs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RUNS);
	while (runs.length > 1 && JSON.stringify(runs).length > MAX_BYTES) runs.pop();
	return { runs };
}

export interface StepInput {
	who: string;
	tool: string;
	params?: Record<string, unknown>;
	tabId?: number;
	tabTitle?: string;
	ok: boolean;
	result?: unknown;
	error?: string;
	ms: number;
	mode?: string;
}

/**
 * Record one step: the run starts if it is new, and is running again if it had ended. `endedAt` is when the run last
 * ended: a call still open then (its agent left) answers after it, and is one more step of the ended run, not a new start.
 */
export function addStep(log: RunsLog, id: string, s: StepInput, now: number, endedAt?: number): RunsLog {
	const late = endedAt !== undefined && now - s.ms <= endedAt;
	return withRun(
		log,
		id,
		now,
		() => ({
			id,
			who: s.who,
			status: late ? (s.ok ? "done" : "failed") : "running",
			startedAt: now,
			updatedAt: now,
			steps: [],
			dropped: 0,
		}),
		(run) => {
			run.who = s.who || run.who;
			if (run.status !== "waiting" && !late) run.status = "running";
			if (s.tabId !== undefined) run.tabId = s.tabId;
			if (s.tabTitle) run.tabTitle = clip(oneLine(s.tabTitle), 120);
			const report = s.ok ? stepReport(s.result) : undefined;
			run.steps.push({
				at: now,
				tool: s.tool,
				target: stepTarget(s.params, s.tabId),
				ok: s.ok,
				result: stepResult(s.result, s.error),
				ms: Math.max(0, Math.round(s.ms)),
				...(report ? { report } : {}),
				...(s.mode ? { mode: s.mode } : {}),
			});
			if (run.steps.length > MAX_STEPS) {
				run.dropped += run.steps.length - MAX_STEPS;
				run.steps = run.steps.slice(-MAX_STEPS);
			}
		},
	);
}

/** After a worker restart no hand-back or question is open any more, so no run still waits on the user. */
export function clearWaits(log: RunsLog, now: number): RunsLog {
	let next = log;
	for (const run of log.runs) if (run.status === "waiting") next = setWaiting(next, run.id, false, now);
	return next;
}

/** The run waits on the user (a hand-back or a question), or stops waiting. A run not in the log is left alone. */
export function setWaiting(log: RunsLog, id: string, on: boolean, now: number): RunsLog {
	const run = log.runs.find((r) => r.id === id);
	if (!run) return log;
	if (on === (run.status === "waiting")) return log;
	if (!on && run.status !== "waiting") return log;
	return withRun(
		log,
		id,
		now,
		() => run,
		(r) => {
			r.status = on ? "waiting" : "running";
		},
	);
}

/** The run ended: failed when its last step failed (or `failed` says so), else done. */
export function endRun(log: RunsLog, id: string, now: number, failed?: boolean): RunsLog {
	const run = log.runs.find((r) => r.id === id);
	if (!run || run.status === "done" || run.status === "failed") return log;
	const lastFailed = run.steps.length > 0 && !run.steps[run.steps.length - 1].ok;
	return withRun(
		log,
		id,
		now,
		() => run,
		(r) => {
			r.status = (failed ?? lastFailed) ? "failed" : "done";
		},
	);
}

/** A run renamed (a panel chat's first save gives its session a new id): its log follows. */
export function renameRun(log: RunsLog, from: string, to: string): RunsLog {
	if (!log.runs.some((r) => r.id === from)) return log;
	const into = log.runs.find((r) => r.id === to);
	const moved = log.runs.find((r) => r.id === from) as Run;
	const merged: Run = into
		? {
				...into,
				steps: [...moved.steps, ...into.steps].slice(-MAX_STEPS),
				startedAt: Math.min(into.startedAt, moved.startedAt),
			}
		: { ...moved, id: to };
	return cap({ runs: [merged, ...log.runs.filter((r) => r.id !== from && r.id !== to)] });
}

/** Read a stored log, dropping anything malformed. */
export function parseLog(value: unknown): RunsLog {
	if (typeof value !== "object" || value === null || !Array.isArray((value as RunsLog).runs)) return EMPTY_LOG;
	const runs = (value as RunsLog).runs.filter(
		(r) => r && typeof r.id === "string" && Array.isArray(r.steps) && typeof r.updatedAt === "number",
	);
	return { runs };
}

/** Bookkeeping calls that say nothing about the work: never a step. */
const NOT_STEPS = new Set([
	"status",
	"tabs.context",
	"session.info",
	"sessions.list",
	"sessions.rename",
	"sessions.end",
	"sessions.group",
	"edits.list",
	"files.upload.chunk",
	"files.download.chunk",
]);

/** Whether a bridge call is a step of its run. */
export function isRunStep(method: string): boolean {
	return !NOT_STEPS.has(method) && !/^(bridge|threads|permission)\./.test(method);
}

/** An outside agent's run, as its tab group and the veil name it ("Claude · local-studio-browser"). */
export function runName(view: { agent: string; detail: string }): string {
	return view.detail ? `${view.agent} · ${view.detail}` : view.agent;
}

/** A panel chat's run, by its group label ("chat" until the chat has a title). */
export function panelRunName(label: string): string {
	const title = label.trim();
	return title && title !== "chat" ? `Side panel · ${title}` : "Side panel";
}

export const STATUS_LABEL: Record<RunStatus, string> = {
	running: "Running",
	waiting: "Waiting on you",
	done: "Done",
	failed: "Failed",
};
