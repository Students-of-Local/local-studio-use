/**
 * The runs log in the service worker (log.ts has what it holds). The bridge records each tool call of an outside
 * agent (src/bridge/native.ts) and each page tool call of the side panel (src/bridge/panel-calls.ts); hand-backs and
 * questions mark a run as waiting on the user; a client leaving, session_end or the panel's run ending ends it.
 * Writes are batched, one at a time, and only this worker writes the log.
 */

import {
	addStep,
	clearWaits,
	EMPTY_LOG,
	endRun,
	parseLog,
	RUNS_KEY,
	RUNS_MESSAGE,
	type RunsLog,
	renameRun,
	type StepInput,
	setWaiting,
} from "./log.js";

const SESSIONS_KEY = "browser_sessions";
/** session.ts records a rename here (a panel chat's first save gives its session its saved id). */
const RENAMES_KEY = "browser_session_renames";

let log: RunsLog | undefined;
let loading: Promise<RunsLog> | undefined;
let edits: Promise<unknown> = Promise.resolve();
/** When each session's run last ended, for the calls still open then; the newest MAX_ENDED of them. */
const ended = new Map<string, number>();
const MAX_ENDED = 50;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function load(): Promise<RunsLog> {
	if (log) return Promise.resolve(log);
	loading ??= chrome.storage.local
		.get(RUNS_KEY)
		.then((d) => parseLog(d[RUNS_KEY]))
		.catch(() => EMPTY_LOG)
		.then((l) => {
			log ??= l;
			return log;
		});
	return loading;
}

function flushSoon(): void {
	if (flushTimer !== undefined) return;
	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		if (log) chrome.storage.local.set({ [RUNS_KEY]: log }).catch(() => undefined);
	}, 200);
}

function edit(change: (l: RunsLog, now: number) => RunsLog | Promise<RunsLog>): void {
	edits = edits
		.then(async () => {
			const next = await change(await load(), Date.now());
			if (next === log) return;
			log = next;
			flushSoon();
		})
		.catch(() => undefined);
}

/** The tab's title, for the run's line; none for a tab that is gone. */
async function titleOf(tabId: number | undefined): Promise<string | undefined> {
	if (tabId === undefined) return undefined;
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	return tab?.title || tab?.url || undefined;
}

/** One step of a run, after it answered. */
export function recordStep(sessionId: string, step: StepInput): void {
	const at = Date.now();
	const endedAt = ended.get(sessionId);
	edit(async (l) => {
		const tabTitle = step.tabTitle ?? (await titleOf(step.tabId));
		return addStep(l, sessionId, { ...step, tabTitle }, at, endedAt);
	});
}

/** Open waits per run: a run can wait on two hand-backs, or a hand-back and a question, at once. */
const waits = new Map<string, number>();

/**
 * A wait on the user opened or closed. The run shows waiting from its first open wait until its last one closes. A wait
 * whose call began (`since`) before the run ended doesn't start it again.
 */
export function runWaiting(sessionId: string, on: boolean, since = Date.now()): void {
	const open = Math.max(0, (waits.get(sessionId) ?? 0) + (on ? 1 : -1));
	if (open) waits.set(sessionId, open);
	else waits.delete(sessionId);
	if (on && since <= (ended.get(sessionId) ?? -1)) return;
	if (on ? open === 1 : open === 0) edit((l, now) => setWaiting(l, sessionId, on, now));
}

export function runEnded(sessionId: string, failed?: boolean): void {
	ended.delete(sessionId);
	ended.set(sessionId, Date.now());
	if (ended.size > MAX_ENDED) ended.delete(ended.keys().next().value as string);
	edit((l, now) => endRun(l, sessionId, now, failed));
}

export function runRenamed(from: string, to: string): void {
	const at = ended.get(from);
	if (at !== undefined) ended.set(to, at);
	edit((l) => renameRun(l, from, to));
}

/** Only the side panel page itself (in the panel, or opened as a tab). */
function fromSidePanel(sender: chrome.runtime.MessageSender): boolean {
	return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL("sidepanel.html")) === true;
}

/**
 * Listen for the panel's run ends. A run left running whose session is gone (the browser restarted, the session was
 * pruned) has nobody running it; a worker restart alone ends nothing, since the agent may still be at work.
 */
export function startRuns(): void {
	void chrome.storage.local
		.get(SESSIONS_KEY)
		.then((d) => {
			const live = new Set(Object.keys((d[SESSIONS_KEY] as Record<string, unknown> | undefined) ?? {}));
			edit((l, now) => {
				// No wait outlives the worker: handback and ask_user start with nothing pending.
				let next = clearWaits(l, now);
				for (const run of next.runs)
					if ((run.status === "running" || run.status === "waiting") && !live.has(run.id))
						next = endRun(next, run.id, now);
				return next;
			});
		})
		.catch(() => undefined);
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local" || !(RENAMES_KEY in changes)) return;
		const before = (changes[RENAMES_KEY].oldValue ?? {}) as Record<string, { to?: unknown }>;
		const after = (changes[RENAMES_KEY].newValue ?? {}) as Record<string, { to?: unknown }>;
		for (const [from, r] of Object.entries(after))
			if (typeof r?.to === "string" && before[from]?.to !== r.to) runRenamed(from, r.to);
	});
	chrome.runtime.onMessage.addListener((message, sender) => {
		const m = message as { type?: unknown; action?: unknown; sessionId?: unknown; failed?: unknown } | null;
		if (m?.type !== RUNS_MESSAGE || !fromSidePanel(sender) || typeof m.sessionId !== "string") return undefined;
		if (m.action === "end") runEnded(m.sessionId, m.failed === true);
		return undefined;
	});
}
