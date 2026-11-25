/**
 * Waiting for a page to settle: no request the page is waiting on, no DOM mutation and no loading
 * marker (aria-busy, a skeleton or spinner) for a short quiet window, with a hard cap so a page
 * that never goes quiet (analytics pings, a websocket feed, a ticking clock, a long poll) still
 * returns. Input tools call it after the action; `wait {until:"settled"}` calls it on its own.
 *
 * Requests come from the debugger's Network events for the tab. Only the kinds a page waits on
 * to draw count (documents, scripts, stylesheets, fetch and XHR), only once they started after
 * the wait's origin, and only while they are younger than `longMs`: a long poll or a stream is
 * open for good and would hold every wait to its cap. DOM changes come from a MutationObserver
 * the first wait leaves in the document (in Local Studio's isolated world), which notes when the
 * page last changed; Local Studio's own veil element is left out.
 */

import { isGuardedUrl } from "../bridge/permissions.js";
import { cdpSend, keepDrawing, onDebuggerSessionEnd, openDialog } from "./cdp.js";
import { downloadBegun, watchDownloads } from "./downloads.js";
import { runInPage } from "./page.js";
import { veilTag } from "./veil-shared.js";

/** After an input tool: how long the page must stay quiet, and the most a call waits. */
export const ACTION_SETTLE = { quietMs: 300, capMs: 2500, longMs: 2000 };
/**
 * After a click or fill the page showed no sign of reacting to: no DOM change, request, navigation or loader since the
 * action began. Waiting out the whole quiet window then only adds its 300 ms to every such action (D50). A sign that
 * comes within this time keeps the quiet window. 60 ms until D56, which drains the page's queued tasks before it looks;
 * 20 ms until D62, which counts a navigation the page asks for and draws the tab while it acts, so the drained look's
 * answer is the answer: nothing the page queued is still to come, and what it sent is ordered before that reply.
 */
export const IDLE_MS = 0;
/**
 * The idle window when the settle's first probe was the first in its document (a tab the page opened, or one handed
 * over): the probe's click listener was not there for the action, so a download link's click went unseen. The old
 * 20 ms window covered a download beginning; this keeps it for that one settle (review r1 first-F2).
 */
export const FRESH_IDLE_MS = 20;
/**
 * After a navigation, once the load event has fired and nothing else holds the wait (no request, loader or pending
 * navigation): how long the page must stay quiet. ACTION_SETTLE's 300 ms until D56, 50 ms until D62: the drained look
 * runs what the load queued, and a navigation that queued work asks for is counted (Page.frameRequestedNavigation).
 */
export const LOADED_QUIET_MS = 0;
/** `wait {until:"settled"}` with no timeoutMs. */
export const WAIT_SETTLE = { quietMs: 500, capMs: 10000, longMs: 5000 };

/** Request kinds a page waits on before it draws. Images, media, fonts, pings and streams don't hold a wait. */
const COUNTED = new Set(["Document", "Stylesheet", "Script", "XHR", "Fetch"]);

interface Pending {
	type: string;
	at: number;
	frameId: string;
	loaderId: string;
}

const pending = new Map<number, Map<string, Pending>>();
/** When the last counted request on a tab finished. */
const lastEnd = new Map<number, number>();
/**
 * Each frame's committed document loader, per tab, from Page.frameNavigated. A document that
 * replaced another takes what the old one had in flight with it, and the browser does not always
 * say so. Set on commit, never on the request: a download or a 204 asks for a document that never
 * commits, and the old page goes on with its own loader.
 */
const loaders = new Map<number, Map<string, string>>();
/** Each tab's main document (its loaderId): a reload of the same URL is a new one. */
const mainDoc = new Map<number, string>();
/**
 * When a tab last opened another (a target=_blank link, window.open). The opening tab itself may not change at all, so
 * an idle settle (idleMs) counts this as the page reacting, and the full quiet window gives the new tab time to join the
 * session before the change report lists it.
 */
const lastOpened = new Map<number, number>();
/** The same, without a window.open the browser may have blocked (one with no click behind it). */
const lastNewTab = new Map<number, number>();
/** When the page in a tab last asked for a navigation (Page.frameRequestedNavigation). */
const lastAsked = new Map<number, number>();
let installed = false;

function install(): void {
	// A download an action starts is reported with its result (downloads.ts).
	watchDownloads();
	if (installed) return;
	installed = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		// Events from a child target (an out-of-process frame) carry its sessionId: not the tab's own.
		if (tabId === undefined || (source as { sessionId?: string }).sessionId) return;
		const p = (params ?? {}) as { requestId?: string; loaderId?: string; frameId?: string; type?: string };
		if (method === "Network.requestWillBeSent") {
			const type = String(p.type ?? "Other");
			if (!COUNTED.has(type)) return;
			const map = pending.get(tabId) ?? new Map<string, Pending>();
			pending.set(tabId, map);
			const id = String(p.requestId);
			const frameId = String(p.frameId ?? "");
			const loaderId = String(p.loaderId ?? "");
			// A request from a document that was already replaced: it is going away with that page.
			const current = loaders.get(tabId)?.get(frameId);
			if (current && loaderId && loaderId !== current && !(type === "Document" && id === loaderId)) return;
			// A redirect reuses the request id: it is the same wait, timed from its first hop.
			const at = map.get(id)?.at ?? Date.now();
			map.set(id, { type, at, frameId, loaderId });
			if (map.size > 500) map.delete(map.keys().next().value as string);
		} else if (method === "Page.frameNavigated") {
			const frame = (params as { frame?: { id?: string; loaderId?: string; parentId?: string } }).frame;
			if (!frame?.id || !frame.loaderId) return;
			if (!frame.parentId) mainDoc.set(tabId, frame.loaderId);
			const frames = loaders.get(tabId) ?? new Map<string, string>();
			loaders.set(tabId, frames);
			frames.set(frame.id, frame.loaderId);
			if (frames.size > 100) frames.delete(frames.keys().next().value as string);
			const map = pending.get(tabId);
			for (const [k, r] of map ?? []) if (r.frameId === frame.id && r.loaderId !== frame.loaderId) map?.delete(k);
		} else if (method === "Page.frameRequestedNavigation") {
			// The page asked to go somewhere (a link, a form, a script setting location): sent by the page's own process
			// as it asks, so it comes before the reply to a probe that drained the task that asked. The browser's
			// pendingUrl and the document request come on another path and can come after that reply (D62).
			lastAsked.set(tabId, Date.now());
		} else if (method === "Page.windowOpen") {
			// The page asked for a new window (a target=_blank link, window.open, a form): sent on the tab's own session
			// as the request is made, so it comes before the reply to any later probe there, well before the new tab's
			// own events (D56: those came after a 20 ms idle window on a loaded machine).
			lastOpened.set(tabId, Date.now());
			if ((params as { userGesture?: boolean }).userGesture) lastNewTab.set(tabId, Date.now());
		} else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
			const map = pending.get(tabId);
			if (map?.delete(String(p.requestId))) lastEnd.set(tabId, Date.now());
		}
	});
	const forget = (tabId: number) => {
		pending.delete(tabId);
		lastEnd.delete(tabId);
		loaders.delete(tabId);
		mainDoc.delete(tabId);
		lastOpened.delete(tabId);
		lastNewTab.delete(tabId);
		lastAsked.delete(tabId);
	};
	const opened = (tabId: number) => {
		lastOpened.set(tabId, Date.now());
		lastNewTab.set(tabId, Date.now());
	};
	chrome.tabs.onCreated.addListener((tab) => {
		if (tab.openerTabId !== undefined) opened(tab.openerTabId);
	});
	// target=_blank implies noopener, and then Chrome may not set openerTabId; this event still names the source tab.
	chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => opened(d.sourceTabId));
	chrome.debugger.onDetach.addListener((source) => {
		if (source.tabId !== undefined) forget(source.tabId);
	});
	// Local Studio's own detach and a silent one raise no onDetach event; cdp.ts says so instead.
	onDebuggerSessionEnd(forget);
	chrome.tabs.onRemoved.addListener(forget);
}

/**
 * Start counting requests on a tab. Sent before every action, not remembered: a debugging session
 * can end with no event (a worker restart, a silent detach) and take Network with it, and enabling
 * it again is one cheap round trip. Best effort: a page the debugger can't reach is judged by its
 * DOM alone.
 */
async function watchNetwork(tabId: number): Promise<void> {
	install();
	await Promise.race([
		// The tab draws while the action runs, so the page's answer to an input is not held 50 ms (cdp.ts, D62).
		Promise.all([cdpSend(tabId, "Network.enable").catch(() => undefined), keepDrawing(tabId)]),
		new Promise((r) => setTimeout(r, ENABLE_MS)),
	]);
}

/** The most turning Network on may take; a stuck debugger is not worth more. */
const ENABLE_MS = 500;

/**
 * Call just before an action: start listening (and counting the tab's requests) so a request the
 * action sends at once is seen, and return the wait's origin. With no tab yet, only the listener.
 */
export async function settleStart(tabId?: number): Promise<number> {
	install();
	if (tabId !== undefined) await watchNetwork(tabId);
	return Date.now();
}

/** The most a settled action waits for the tab it opened to join the session. */
const NEW_TAB_MS = 2000;

/**
 * After the settle: when `tabId` opened a tab since `since`, wait until `joined` says the session has it. Joining takes
 * the foreground guard several browser calls, which on a loaded machine outlast the quiet window: the report then said
 * nothing happened (#75). Ends early when a download began instead (its tab closes again) or `stop` says so.
 */
export async function newTabJoins(
	tabId: number,
	since: number,
	joined: () => boolean,
	stop: () => boolean,
): Promise<void> {
	const at = lastNewTab.get(tabId) ?? 0;
	if (at < since) return;
	while (!joined() && !stop() && !openDialog(tabId) && Date.now() - at < NEW_TAB_MS)
		if (await downloadBegun(tabId, since, 20)) return;
}

/** Requests the page is still waiting on that started at or after `since` and are younger than `longMs`. */
function inFlight(tabId: number, since: number, longMs: number, now: number): number {
	let n = 0;
	for (const r of pending.get(tabId)?.values() ?? []) if (r.at >= since && now - r.at < longMs) n++;
	return n;
}

/**
 * What settleProbe leaves on the page: when it last changed, and whether a frame has drawn since (`owed`: when the
 * first change after the last drawn frame came; `drawn` settles once the next frame has drawn). awaitDrawn in page.ts
 * reads it.
 */
export interface SettleMark {
	last: number;
	doc: Document;
	owed: number;
	drawn: Promise<void> | null;
	/** The last click on a download link in this document, and when it came (fileAgo). */
	file?: Event;
	fileAt?: number;
}

/** What settleProbe says about the page: ms since it last changed, still parsing, a loader on screen, load fired. */
interface ProbeReport {
	since: number;
	parsing: boolean;
	busy: string;
	complete: boolean;
	/**
	 * Ms since the page's last data request ended (a fetch or XHR, or a script, stylesheet or frame that finished after
	 * DOMContentLoaded), by its own Resource Timing; null when it made none. What such a request brings is often drawn
	 * a task or a timer later, so a short window counts only once that end is a full quiet window old (D56).
	 */
	lateAgo: number | null;
	/**
	 * Ms since a click on a download link (an `a` or `area` with `download` and `href`) the page did not cancel; null
	 * when none. The browser fetches the file and only then begins the download, after the page has gone quiet, so
	 * settle waits for it (FILE_START_MS).
	 */
	fileAgo: number | null;
	/** This probe was the first in its document, so it saw nothing of the action (FRESH_IDLE_MS). */
	fresh: boolean;
}
type ProbeResult = ProbeReport | { guarded: true };

/**
 * Page side: leave a MutationObserver in the document once, and say how long ago the page last
 * changed, whether it is still parsing, whether a loading marker is on screen, whether the load
 * event has fired and when its last data request ended. Self-contained.
 * On a guarded page (the approval address, #94) it touches nothing and says so: a navigation can
 * commit there after the loop last read the tab's URL.
 * `drain`: look only after the page has run what is already queued (a MessageChannel turn, then a zero-delay timer),
 * so a change an event handler or a load handler scheduled for its next task is seen, not missed by a look that ran
 * first. The observer is in place before the drain, so a change made during it counts.
 */
function settleProbe(
	veil: string,
	hosts: readonly string[],
	guarded: (url: string, hosts: readonly string[]) => boolean,
	drain: boolean,
): ProbeResult | Promise<ProbeResult> {
	if (guarded(location.href, hosts)) return { guarded: true };
	const w = window as unknown as { __localStudioSettle?: SettleMark };
	let s = w.__localStudioSettle;
	const fresh = !s || s.doc !== document;
	if (!s || s.doc !== document) {
		s = { last: performance.now(), doc: document, owed: 0, drawn: null };
		w.__localStudioSettle = s;
		const mark = s;
		const inVeil = (n: Node | null) => {
			for (let p: Node | null = n; p && veil; p = p.parentNode)
				if (p.nodeType === 1 && (p as Element).localName === veil) return true;
			return false;
		};
		// The veil coming or going is not the page changing: a childList record's target is its parent.
		const veilOnly = (r: MutationRecord) => {
			if (inVeil(r.target)) return true;
			const nodes = r.type === "childList" ? [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)] : [];
			return nodes.length > 0 && nodes.every((n) => inVeil(n));
		};
		new MutationObserver((records) => {
			if (!records.some((r) => !veilOnly(r))) return;
			mark.last = performance.now();
			// The page owes a frame until one draws: observers (IntersectionObserver) only look then.
			if (mark.owed) return;
			mark.owed = mark.last;
			mark.drawn = new Promise((done) =>
				requestAnimationFrame(() =>
					setTimeout(() => {
						mark.owed = 0;
						mark.drawn = null;
						done();
					}, 0),
				),
			);
		}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		// First in the capture phase, so the page can't hide the click; whether it canceled it is read at report time.
		addEventListener(
			"click",
			(e) => {
				for (const n of e.composedPath() as Element[]) {
					if (n.nodeType !== 1 || (n.localName !== "a" && n.localName !== "area")) continue;
					if (n.hasAttribute("download") && n.hasAttribute("href")) {
						mark.file = e;
						mark.fileAt = performance.now();
					}
					return;
				}
			},
			true,
		);
	}
	const seen = s;
	const report = (): ProbeReport => {
		const now = performance.now();
		// A loading marker a person would read as "not ready": aria-busy, or a skeleton, shimmer or
		// spinner class on something shown in the window.
		const token = /(^|[-_])(skeleton|shimmer|spinner)([-_]|$)|^(is-)?loading$/i;
		let busy = "";
		const marked = document.querySelectorAll(
			"[aria-busy=true],[class*=skeleton i],[class*=shimmer i],[class*=spinner i],[class*=loading i]",
		);
		for (let i = 0; i < marked.length && i < 200 && !busy; i++) {
			const el = marked[i];
			if (el.getAttribute("aria-busy") !== "true" && !Array.from(el.classList).some((c) => token.test(c))) continue;
			const r = el.getBoundingClientRect();
			if (
				r.width === 0 ||
				r.height === 0 ||
				r.bottom < 0 ||
				r.top > innerHeight ||
				r.right < 0 ||
				r.left > innerWidth
			)
				continue;
			// Seen means seen: a loader faded out (opacity 0 on an ancestor) or hidden by one stays in the
			// page after many transitions, and must not hold every wait.
			const check = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
			if (check) {
				if (!check.call(el, { opacityProperty: true, visibilityProperty: true })) continue;
			} else {
				const st = getComputedStyle(el);
				if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
			}
			busy = el.getAttribute("aria-busy") === "true" ? "aria-busy" : "loading placeholder";
		}
		const complete = document.readyState === "complete";
		let lateAgo: number | null = null;
		if (complete && drain) {
			const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
			const dcl = nav?.domContentLoadedEventStart ?? 0;
			let end = -1;
			for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
				const data = e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest";
				const late = /^(script|link|css|iframe|frame)$/.test(e.initiatorType) && e.responseEnd >= dcl;
				if ((data || late) && e.responseEnd > end) end = e.responseEnd;
			}
			if (end >= 0) lateAgo = Math.max(0, Math.round(now - end));
		}
		return {
			since: Math.round(now - seen.last),
			parsing: document.readyState === "loading",
			busy,
			complete,
			lateAgo,
			fileAgo:
				seen.file && seen.fileAt !== undefined && !seen.file.defaultPrevented
					? Math.round(now - seen.fileAt)
					: null,
			fresh,
		};
	};
	if (!drain) return report();
	return new Promise<ProbeResult>((done) => {
		const c = new MessageChannel();
		c.port1.onmessage = () => setTimeout(() => done(report()), 0);
		c.port2.postMessage(0);
	});
}

export interface SettleResult {
	settled: boolean;
	ms: number;
	/** What was still going on when the cap ran out. */
	waitingOn?: "network" | "dom" | "loading" | "navigation";
	/** Cut short by the caller or a dialog: the call reports that instead. */
	stopped?: boolean;
	/** Stopped because the tab is on, or going to, a page no tool may touch (#94). */
	guarded?: boolean;
	/** Returned after `idleMs`: nothing on the page reacted to the action. */
	idle?: boolean;
}

/**
 * Wait until the tab's page has been quiet for `quietMs`, at most `capMs`, which is a hard limit:
 * the result comes at the cap whatever the page or the debugger does. `since` is when the action
 * began: requests started earlier don't hold the wait (0 counts every request in flight).
 * Stops at once, unsettled, when `stop()` says so, a dialog opens (the page is frozen then) or the
 * tab lands on a page no tool may touch (`skip`). `watched`: settleStart already turned Network on.
 */
export async function settle(
	tabId: number,
	options: {
		quietMs?: number;
		capMs?: number;
		longMs?: number;
		since?: number;
		stop?: () => boolean;
		skip?: (url: string) => boolean;
		/** The hosts behind `skip`: the probe checks them itself before it touches the page. */
		guardedHosts?: readonly string[];
		watched?: boolean;
		/**
		 * Return after this many ms when nothing has reacted since `since`: no DOM change at or after it, no counted
		 * request started or finished after it, no navigation, no loader, and every probe answered. Any of those
		 * keeps the full quiet window.
		 */
		idleMs?: number;
		/**
		 * The quiet window once the page's load event has fired (the probe reads readyState "complete"), when nothing
		 * else holds the wait: a navigation's settle (D56). A page still loading, or one the probe can't read, keeps
		 * `quietMs`.
		 */
		loadedQuietMs?: number;
	} = {},
): Promise<SettleResult> {
	const { quietMs = ACTION_SETTLE.quietMs, capMs = ACTION_SETTLE.capMs, longMs = ACTION_SETTLE.longMs } = options;
	const start = Date.now();
	const since = options.since ?? start;
	const deadline = start + capMs;
	let over = false;
	let waitingOn: SettleResult["waitingOn"];
	/** The reason the last full pass found, for a cap that lands in the middle of a pass. */
	let lastReason: SettleResult["waitingOn"];
	const run = async (): Promise<SettleResult> => {
		if (!options.watched) await watchNetwork(tabId);
		const veil = (await within(veilTag(tabId), 300)) ?? "";
		// The short windows look only after the page has run what is already queued (settleProbe's drain).
		let drain = options.idleMs !== undefined || options.loadedQuietMs !== undefined;
		const probeCode = (d: boolean) =>
			`(${settleProbe.toString()})(${JSON.stringify(veil)}, ${JSON.stringify(options.guardedHosts ?? [])}, ${isGuardedUrl.toString()}, ${d})`;
		let code = probeCode(drain);
		let lastActivity = start;
		/** Something on the page answered the action (idleMs): never reset once set. */
		let reacted = options.idleMs === undefined;
		/** The idle window: FRESH_IDLE_MS once a probe was the first in its document. */
		let idleMs = options.idleMs ?? 0;
		/** Probes refused in a row. A page the extension may not script (a store page, a viewer) is judged by its requests alone. */
		let refused = 0;
		/** The document the refusals were counted on: a new one may be scriptable. */
		let refusedOn = "";
		for (;;) {
			if (over) return { settled: false, ms: Date.now() - start };
			if (options.stop?.() || openDialog(tabId)) return { settled: false, ms: Date.now() - start, stopped: true };
			const before = waitingOn;
			waitingOn = undefined;
			/** This pass's probe saw the load event fired (loadedQuietMs). */
			let loaded = false;
			/** When this pass's probe says a download link was clicked, by this clock; 0 when none. */
			let fileAsked = 0;
			const tab = await chrome.tabs.get(tabId).catch(() => undefined);
			// The cap came while the tab was read: no probe goes out after it.
			if (over) return { settled: false, ms: Date.now() - start };
			if (!tab) return { settled: false, ms: Date.now() - start, stopped: true };
			if (options.skip?.(tab.pendingUrl || tab.url || ""))
				return { settled: false, ms: Date.now() - start, stopped: true, guarded: true };
			const t0 = Date.now();
			// Per document, not per URL: a reload is a new document, a hash change is not.
			const doc = mainDoc.get(tabId) ?? tab.url ?? "";
			if (tab.pendingUrl || doc !== refusedOn) {
				refused = 0;
				refusedOn = doc;
			}
			if (tab.pendingUrl) {
				waitingOn = "navigation";
				lastActivity = t0;
				reacted = true;
			} else if (refused < 2) {
				// Never let one probe hold the loop, or run past the cap.
				const budget = Math.max(0, Math.min(PROBE_MS, deadline - t0));
				const page = await within(
					runInPage<ProbeResult>(tabId, code).then(
						(v) => v ?? "refused",
						() => "refused" as const,
					),
					budget,
				);
				if (page === undefined && drain && budget >= PROBE_MS) {
					// The drain waits on a page timer, and a browser may hold the timers of a tab out of sight past the
					// budget (review r2 first-F1). Look undrained for the rest of this settle. Without a drained look the
					// short windows are not safe, so the page counts as reacting and gets the full window; this pass
					// says nothing about the page, so it is not counted as busy.
					drain = false;
					code = probeCode(false);
					reacted = true;
					continue;
				}
				// A drained probe measured "since" after its drain, so its answer, not the call, is the time it is relative to;
				// the later time can only move a change later, which waits longer, never less.
				const at = drain ? Date.now() : t0;
				if (page && page !== "refused" && "guarded" in page)
					return { settled: false, ms: Date.now() - start, stopped: true, guarded: true };
				if (page === "refused") refused++;
				else if (page !== undefined) refused = 0;
				// A page that can't be looked at, or is too busy to answer, may be reacting: no shortcut.
				if (page === undefined || page === "refused") reacted = true;
				else if (!("guarded" in page) && (page.parsing || page.busy || at - page.since >= since)) reacted = true;
				if (page === undefined) {
					// No answer in time: the page's main thread is busy (a long task, hydration). Cut
					// short by the cap instead, it says nothing new about the page.
					waitingOn = budget < PROBE_MS ? (before ?? "dom") : "loading";
					lastActivity = Date.now();
				} else if (page !== "refused" && !("guarded" in page)) {
					// The probe's clock is the page's: its "since" is measured at the page, about when the call went out.
					lastActivity = Math.max(lastActivity, at - page.since);
					// The short window is for a page done loading whose data requests, if any, ended a full window ago.
					const lateAgo = typeof page.lateAgo === "number" && Number.isFinite(page.lateAgo) ? page.lateAgo : null;
					if (lateAgo !== null) lastActivity = Math.max(lastActivity, at - lateAgo);
					// Only a drained probe reads Resource Timing, so only its answer can show the data requests ended.
					loaded = drain && page.complete === true && (lateAgo === null || lateAgo >= quietMs);
					if (typeof page.fileAgo === "number" && Number.isFinite(page.fileAgo)) fileAsked = at - page.fileAgo;
					if (page.fresh === true) idleMs = Math.max(idleMs, FRESH_IDLE_MS);
					if (page.parsing || page.busy) {
						waitingOn = "loading";
						lastActivity = Date.now();
					}
				} else if (refused < 2) lastActivity = Date.now(); // once may be a document being swapped
			}
			const now = Date.now();
			if (inFlight(tabId, since, longMs, now) > 0) {
				waitingOn = "network";
				lastActivity = now;
				reacted = true;
			} else lastActivity = Math.max(lastActivity, Math.min(now, lastEnd.get(tabId) ?? 0));
			if ((lastEnd.get(tabId) ?? 0) >= since) reacted = true;
			if ((lastOpened.get(tabId) ?? 0) >= since) reacted = true;
			// A navigation the page asked for since the action began: the browser may not show it pending yet, so the
			// quiet window runs from the ask and the next pass reads the tab again.
			const asked = lastAsked.get(tabId) ?? 0;
			if (asked >= since) {
				reacted = true;
				lastActivity = Math.max(lastActivity, asked);
			}
			// A download link clicked since the action began: the file is fetched before the download begins, often after
			// the page went quiet. Wait for it to begin (downloads.ts), then look again; a download that never begins
			// holds the wait FILE_START_MS at most.
			if (fileAsked >= since && now - fileAsked < FILE_START_MS && now < deadline) {
				const left = Math.min(FILE_START_MS - (now - fileAsked), deadline - now);
				if (!(await downloadBegun(tabId, since, 0))) {
					await downloadBegun(tabId, since, left);
					continue;
				}
			}
			lastReason = waitingOn;
			const quiet =
				loaded && options.loadedQuietMs !== undefined ? Math.min(quietMs, options.loadedQuietMs) : quietMs;
			if (!waitingOn && now - lastActivity >= quiet) return { settled: true, ms: now - start };
			const idleLeft = reacted ? Number.POSITIVE_INFINITY : idleMs - (now - start);
			if (!waitingOn && idleLeft <= 0) return { settled: true, ms: now - start, idle: true };
			if (now >= deadline) return { settled: false, ms: now - start, waitingOn: waitingOn ?? "dom" };
			// The next look comes when the quiet window would end (or the idle one, or the cap), and at least every 100 ms.
			const quietLeft = waitingOn ? quiet : quiet - (now - lastActivity);
			await new Promise((r) => setTimeout(r, Math.max(10, Math.min(100, deadline - now, idleLeft, quietLeft))));
		}
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const capped = new Promise<SettleResult>((r) => {
		timer = setTimeout(() => {
			over = true;
			r({ settled: false, ms: Date.now() - start, waitingOn: waitingOn ?? lastReason ?? "dom" });
		}, capMs);
	});
	try {
		return await Promise.race([run(), capped]);
	} finally {
		clearTimeout(timer);
	}
}

/** The longest settle waits for a download to begin after the page says a download link was clicked. */
export const FILE_START_MS = 1000;

/** The longest one DOM probe may take before the page counts as busy. */
const PROBE_MS = 400;

/** A promise's value, or undefined once `ms` have passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

/** What an action's result carries when the page did not settle in time; nothing when it did. */
export function unsettledNote(r: SettleResult): { settled: false; waitingOn: string } | Record<string, never> {
	return r.settled || r.stopped ? {} : { settled: false, waitingOn: r.waitingOn ?? "dom" };
}
