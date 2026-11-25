/**
 * The parts of site edits the page side (the feed filter's content script, site-edits/feed-filter.ts) and the native host
 * (cli/src/sites.ts) need too: the shape of an edit, its limits, the storage key and the host test. Kept apart from store.ts
 * so neither carries the Public Suffix List or Chrome's types.
 */

export const STORAGE_KEY = "tk-site-edits";

export const EDIT_KINDS = ["hide", "style", "block", "filter", "script"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

export interface SiteEdit {
	id: string;
	/** Lowercase host without "www.", like "x.com". The edit applies there and on its subdomains. */
	host: string;
	kind: EditKind;
	/** Selectors for hide, CSS rules for style, a request pattern for block, source code for script, a filter as JSON (feed-match.ts) for filter. */
	value: string;
	note: string;
	/** "agent:<name>" or "you". */
	addedBy: string;
	on: boolean;
	createdAt: number;
}

/** A style edit's value for the ready-made dark look (style.ts). */
export const DARK = "dark";

export const MAX_EDITS = 300;
export const MAX_SCRIPT = 50_000;
export const MAX_NOTE = 200;

/**
 * The feed filter's messages. Its content script asks the service worker for its own page's filters (GET), and the worker
 * sends each tab its filters again after every change (SET). The content script never reads extension storage itself, so
 * a page's renderer never receives the other settings kept there.
 */
export const FEED_FILTER_GET = "tk-feed-filter:get";
export const FEED_FILTER_SET = "tk-feed-filter:set";

/** Whether `url` is on `host` or one of its subdomains. An IP address has no subdomains: 127.0.0.1 isn't under 0.1. */
export function onHost(url: string | undefined, host: string): boolean {
	if (!url) return false;
	let h: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		h = parsed.hostname.toLowerCase();
	} catch {
		return false;
	}
	return h === host || (!/^[\d.]+$/.test(h) && h.endsWith(`.${host}`));
}
