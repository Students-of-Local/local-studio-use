/**
 * The feed filter's content script: the extension's own code, registered by site-edits/apply.ts for the sites that have a
 * filter on, so it needs no user-scripts switch. It asks the service worker for this page's filters, hides what they match
 * (site-edits/feed-filter-core.ts), and takes the new filters the worker sends after every change the person or an agent
 * makes. It never reads extension storage: the page's renderer gets this page's filters and nothing else kept there.
 *
 * It can be injected more than once into one page (registered, then put into tabs already open), so it starts only once.
 */

import { FEED_FILTER_GET, FEED_FILTER_SET } from "./common.js";
import { type FeedFilter, startFeedFilter } from "./feed-filter-core.js";
import type { FeedFilterSpec } from "./feed-match.js";

const STARTED = "__localStudioFeedFilter";

/** What a running copy leaves on the page: whether its extension is still there, and how to stop it. */
interface Running {
	alive(): boolean;
	stop(): void;
}
const scope = globalThis as typeof globalThis & { [STARTED]?: Running };

/** False once the extension reloads or updates: this copy can no longer reach the worker. */
const reachable = () => {
	try {
		return !!chrome.runtime?.id;
	} catch {
		return false;
	}
};

const previous = scope[STARTED];
// A copy orphaned by an extension update or reload can't hear new filters: it steps aside for this one.
if (previous && !previous.alive()) {
	previous.stop();
	scope[STARTED] = undefined;
}

if (!scope[STARTED] && typeof chrome !== "undefined" && reachable() && typeof document !== "undefined") {
	let filter: FeedFilter | undefined;
	const listening = new AbortController();
	let onSet: ((message: unknown) => undefined) | undefined;
	// Set first, so a second injection into this page (every site-edit change injects into open tabs) does nothing.
	scope[STARTED] = {
		alive: reachable,
		stop: () => {
			filter?.stop();
			filter = undefined;
			listening.abort();
			try {
				if (onSet) chrome.runtime.onMessage.removeListener(onSet);
			} catch {
				// An orphaned copy can no longer reach its runtime: nothing more to remove.
			}
		},
	};
	/** Set once the worker has sent filters: an answer to the first question can't be newer, so it is dropped. */
	let pushed = false;
	const apply = (specs: unknown) => {
		if (!Array.isArray(specs)) return;
		const list = specs as FeedFilterSpec[];
		if (filter) filter.update(list);
		else if (list.length) filter = startFeedFilter(document, list, { hostname: location.hostname });
	};
	onSet = (message: unknown) => {
		const m = message as { type?: unknown; filters?: unknown } | null;
		if (m?.type !== FEED_FILTER_SET) return undefined;
		pushed = true;
		apply(m.filters);
		return undefined;
	};
	chrome.runtime.onMessage.addListener(onSet);
	const ask = () => {
		const asked = pushed;
		chrome.runtime
			.sendMessage({ type: FEED_FILTER_GET })
			.then((specs: unknown) => {
				// An answer older than a pushed change is dropped.
				if (pushed === asked) apply(specs);
			})
			.catch(() => undefined);
	};
	ask();
	// A prerendered page or one restored from the back/forward cache missed changes sent while it was hidden: ask again.
	document.addEventListener(
		"prerenderingchange",
		() => {
			pushed = false;
			ask();
		},
		{ signal: listening.signal },
	);
	window.addEventListener(
		"pageshow",
		(e) => {
			if (!e.persisted) return;
			pushed = false;
			ask();
		},
		{ signal: listening.signal },
	);
}
