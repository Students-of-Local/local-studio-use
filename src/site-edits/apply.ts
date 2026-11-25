/**
 * Makes the browser follow the site edits (site-edits/store.ts). Runs in the service worker:
 * - hide and style: a stylesheet put into each matching page as it commits, and into open tabs when an edit changes;
 * - block: dynamic network rules, ids SITE_RULE_BASE and up (2000-2999 are removed at each worker start, utils/provider-cors.ts);
 * - script: user scripts registered for the site, only when the person turned them on and user scripts are allowed;
 * - filter: the extension's own content script (feed-filter.js) registered for every site with a filter on, and put into
 *   tabs already open there. It asks for its page's filters, and every tab is sent its filters again after a change
 *   (site-edits/feed-filter.ts);
 * - ad blocking: the "ads" ruleset on or off.
 */

import { userScriptsApi } from "../browser/userscripts-status.js";
import { FEED_FILTER_GET, FEED_FILTER_SET } from "./common.js";
import { filtersFor } from "./feed-match.js";
import { blockRules, load, onHost, pageCss, putsCss, type SiteEditsState, STORAGE_KEY } from "./store.js";

export const SITE_RULE_BASE = 50_000;
const SITE_RULE_MAX = 50_999;
const SCRIPT_PREFIX = "site-edit-";
export const FILTER_SCRIPT_ID = "tk-feed-filter";
const FILTER_SCRIPT_FILE = "feed-filter.js";
const AD_RULESET = "ads";

/**
 * What each tab's frames got last, so a change can take the old sheet back out. Kept in session storage too: the service
 * worker stops when idle, and a new one must still know what it put into pages that stayed open.
 */
const applied = new Map<string, string>();
const APPLIED_KEY = "tk-site-edits-applied";
let restored: Promise<void> | undefined;

function restoreApplied(): Promise<void> {
	restored ??= (async () => {
		try {
			const data = await chrome.storage?.session?.get(APPLIED_KEY);
			for (const [k, v] of Object.entries((data?.[APPLIED_KEY] as Record<string, string>) ?? {})) {
				if (!applied.has(k)) applied.set(k, v);
			}
		} catch {
			/* nothing saved, or no session storage here */
		}
	})();
	return restored;
}

function persistApplied(): void {
	void chrome.storage?.session?.set({ [APPLIED_KEY]: Object.fromEntries(applied) })?.catch(() => undefined);
}

async function injectCss(
	tabId: number,
	frameId: number,
	url: string | undefined,
	state: SiteEditsState,
): Promise<void> {
	await restoreApplied();
	const key = `${tabId}:${frameId}`;
	const css = pageCss(state, url);
	const old = applied.get(key);
	if (old === css) return;
	try {
		if (old) await chrome.scripting.removeCSS({ target: { tabId, frameIds: [frameId] }, css: old, origin: "USER" });
		if (css) await chrome.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: "USER" });
		if (css) applied.set(key, css);
		else applied.delete(key);
	} catch {
		// A page the extension may not touch (the Web Store, a browser page) or a tab that closed.
		applied.delete(key);
	}
	persistApplied();
}

async function syncBlocks(state: SiteEditsState): Promise<void> {
	const dnr = chrome.declarativeNetRequest;
	if (!dnr?.updateDynamicRules) return;
	const existing = await dnr.getDynamicRules();
	const removeRuleIds = existing.map((r) => r.id).filter((id) => id >= SITE_RULE_BASE && id <= SITE_RULE_MAX);
	const addRules = blockRules(state, SITE_RULE_BASE).slice(0, SITE_RULE_MAX - SITE_RULE_BASE + 1);
	await dnr.updateDynamicRules({ removeRuleIds, addRules: addRules as chrome.declarativeNetRequest.Rule[] });
}

async function syncAdBlock(state: SiteEditsState): Promise<void> {
	const dnr = chrome.declarativeNetRequest;
	if (!dnr?.updateEnabledRulesets) return;
	const enabled = await dnr.getEnabledRulesets();
	if (state.adBlock && !enabled.includes(AD_RULESET))
		await dnr.updateEnabledRulesets({ enableRulesetIds: [AD_RULESET] });
	if (!state.adBlock && enabled.includes(AD_RULESET))
		await dnr.updateEnabledRulesets({ disableRulesetIds: [AD_RULESET] });
}

/** Scripts that are on, registered once each; everything else of ours unregistered. Without user scripts, nothing runs. */
async function syncScripts(state: SiteEditsState): Promise<void> {
	const api = userScriptsApi() as unknown as
		| {
				getScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string }>>;
				register(scripts: unknown[]): Promise<void>;
				unregister(filter?: { ids?: string[] }): Promise<void>;
		  }
		| undefined;
	if (!api?.getScripts || !api.register || !api.unregister) return;
	const wanted = state.edits.filter((e) => e.on && e.kind === "script");
	const ours = (await api.getScripts()).map((s) => s.id).filter((id) => id.startsWith(SCRIPT_PREFIX));
	if (ours.length) await api.unregister({ ids: ours });
	if (!wanted.length) return;
	await api.register(
		wanted.map((e) => ({
			id: `${SCRIPT_PREFIX}${e.id}`,
			matches: [`*://${e.host}/*`, `*://*.${e.host}/*`],
			js: [{ code: e.value }],
			runAt: "document_idle",
			world: "USER_SCRIPT",
		})),
	);
}

/** Match patterns for a filter's site and its subdomains. An IP address has no subdomains, and "*.1.2.3.4" is no pattern. */
export function filterMatches(hosts: string[]): string[] {
	return hosts.flatMap((h) => (/^[\d.]+$/.test(h) ? [`*://${h}/*`] : [`*://${h}/*`, `*://*.${h}/*`]));
}

/** The feed filter's content script on every site with a filter on, at document start so nothing it hides is drawn first. */
async function syncFilters(state: SiteEditsState): Promise<void> {
	const scripting = chrome.scripting;
	if (!scripting?.registerContentScripts) return;
	const hosts = [...new Set(state.edits.filter((e) => e.on && e.kind === "filter").map((e) => e.host))].sort();
	const existing = await scripting.getRegisteredContentScripts({ ids: [FILTER_SCRIPT_ID] });
	if (!hosts.length) {
		if (existing.length) await scripting.unregisterContentScripts({ ids: [FILTER_SCRIPT_ID] });
		return;
	}
	const script: chrome.scripting.RegisteredContentScript = {
		id: FILTER_SCRIPT_ID,
		matches: filterMatches(hosts),
		js: [FILTER_SCRIPT_FILE],
		runAt: "document_start",
		allFrames: false,
		persistAcrossSessions: true,
	};
	if (existing.length) await scripting.updateContentScripts([script]);
	else await scripting.registerContentScripts([script]);
	// Pages already open on those sites get it now. It starts once per page, so a second injection does nothing.
	const tabs = await chrome.tabs.query({});
	await Promise.all(
		tabs
			.filter((t) => t.id !== undefined && hosts.some((h) => onHost(t.url, h)))
			.map((t) =>
				scripting
					.executeScript({ target: { tabId: t.id as number }, files: [FILTER_SCRIPT_FILE] })
					.catch(() => undefined),
			),
	);
}

/**
 * Every web page's top frame is sent its filters as they are now. A page whose filter was just removed or turned off is sent
 * none and shows everything; a tab with no feed filter running has no listener, and its send fails quietly.
 */
async function pushFilters(state: SiteEditsState): Promise<void> {
	const tabs = await chrome.tabs.query({});
	await Promise.all(
		tabs
			.filter((t) => t.id !== undefined && /^https?:/.test(t.url ?? ""))
			.map((t) =>
				chrome.tabs
					.sendMessage(
						t.id as number,
						{ type: FEED_FILTER_SET, filters: filtersFor(state, t.url) },
						{ frameId: 0 },
					)
					.catch(() => undefined),
			),
	);
}

async function syncOpenTabs(state: SiteEditsState): Promise<void> {
	const tabs = await chrome.tabs.query({});
	await Promise.all(
		tabs
			.filter((t) => t.id !== undefined)
			.map(async (t) => {
				const frames = (await chrome.webNavigation.getAllFrames({ tabId: t.id as number }).catch(() => null)) ?? [];
				await Promise.all(frames.map((f) => injectCss(t.id as number, f.frameId, f.url, state)));
			}),
	);
}

let running: Promise<void> | undefined;
let again = false;

/**
 * Everything at once: at start-up and after every change. One run at a time, and a change during a run starts one more, from
 * storage as it is then: two runs side by side could register a script the person had just turned off. Each part fails on its own.
 */
export function syncSiteEdits(): Promise<void> {
	if (running) {
		again = true;
		return running;
	}
	running = (async () => {
		do {
			again = false;
			const state = await load();
			await Promise.allSettled([
				syncBlocks(state),
				syncAdBlock(state),
				syncScripts(state),
				syncFilters(state),
				pushFilters(state),
				syncOpenTabs(state),
			]);
		} while (again);
	})().finally(() => {
		running = undefined;
	});
	return running;
}

/** Same host: a page that only rewrote its own address (history.replaceState at load) is still the page that committed. */
function sameHost(a: string, b: string): boolean {
	try {
		return new URL(a).host === new URL(b).host;
	} catch {
		return false;
	}
}

let started = false;

/**
 * Whether a message came from a page's top document. A prerendered page (Chrome prerenders a confident address-bar
 * suggestion) or a page in the back/forward cache is a top document too, but not frame 0, so the frame number alone would
 * leave it unfiltered once it is shown.
 */
function topDocument(sender: chrome.runtime.MessageSender): boolean {
	const frameType = (sender as { frameType?: string }).frameType;
	if (frameType !== undefined) return frameType === "outermost_frame";
	return sender.frameId === 0;
}

export function startSiteEdits(): void {
	if (started) return;
	started = true;
	chrome.webNavigation?.onCommitted?.addListener((d) => {
		void Promise.all([load(), restoreApplied()]).then(async ([state]) => {
			// The frame may have moved on while storage answered: a sheet for the old site never goes into the new one.
			const now = await chrome.webNavigation.getFrame?.({ tabId: d.tabId, frameId: d.frameId }).catch(() => null);
			if (now && !sameHost(now.url, d.url)) return;
			if (
				state.edits.some((e) => putsCss(e) && e.on && onHost(d.url, e.host)) ||
				applied.has(`${d.tabId}:${d.frameId}`)
			) {
				// A new document starts with no sheet of ours.
				applied.delete(`${d.tabId}:${d.frameId}`);
				await injectCss(d.tabId, d.frameId, d.url, state);
				// The frame can still move on while the sheet goes in: then it comes back out.
				const after = await chrome.webNavigation
					.getFrame?.({ tabId: d.tabId, frameId: d.frameId })
					.catch(() => null);
				if (after && !sameHost(after.url, d.url)) await injectCss(d.tabId, d.frameId, after.url, state);
			}
		});
	});
	// The feed filter's question: its own page's filters, for this extension's content script in a page's top frame only.
	chrome.runtime?.onMessage?.addListener((message: unknown, sender, sendResponse: (filters: unknown) => void) => {
		if ((message as { type?: unknown } | null)?.type !== FEED_FILTER_GET) return undefined;
		if (sender.id !== chrome.runtime.id || !topDocument(sender) || !/^https?:/.test(sender.url ?? "")) {
			sendResponse([]);
			return undefined;
		}
		void load()
			.then((state) => sendResponse(filtersFor(state, sender.url)))
			.catch(() => sendResponse([]));
		return true;
	});
	chrome.tabs?.onRemoved?.addListener((tabId) => {
		for (const key of [...applied.keys()]) if (key.startsWith(`${tabId}:`)) applied.delete(key);
		persistApplied();
	});
	chrome.storage?.onChanged?.addListener((changes, area) => {
		if (area === "local" && changes[STORAGE_KEY]) void syncSiteEdits();
	});
	// User scripts allowed later: register what is waiting.
	chrome.permissions?.onAdded?.addListener(() => void syncSiteEdits());
	void syncSiteEdits().catch(() => undefined);
}
