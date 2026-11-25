/**
 * Where a feed's posts are on the sites people filter most, for the feed filter (site-edits/feed-filter-core.ts). A filter
 * can name its own item selector; then the site's handle reader still applies and the item itself is what gets hidden.
 *
 * Selectors are the sites' own stable hooks (data-testid, custom element names), checked against each site in 2026-11.
 */

import { type Formats, normalizeHandle } from "./feed-match.js";

export interface SiteProfile {
	/** One feed item. */
	items: string;
	/** What to hide for an item, when it isn't the item: X hides the list cell, so no empty row stays behind. */
	target?(item: Element): Element;
	/** Rows that belong to the item and go with it (Hacker News puts the byline in the next table row). */
	also?(item: Element): Element[];
	/** The text a filter's words are matched against. Default: the item's text. */
	text?(item: Element): string;
	/** The accounts an item is from, normalized (feed-match.ts normalizeHandle). */
	handles(item: Element): string[];
	formats?: Formats;
}

/** The account a link names: `pattern`'s first group in its href, normalized; undefined when the link names none. */
function linkHandle(a: Element, pattern: RegExp): string | undefined {
	const m = pattern.exec(a.getAttribute("href") ?? "");
	if (!m) return undefined;
	let h = m[1];
	try {
		h = decodeURIComponent(h);
	} catch {
		/* keep it as written */
	}
	return normalizeHandle(h);
}

/** The accounts the links under `item` that `selector` finds name, when `pattern` matches the link's path. */
function linkHandles(item: Element, selector: string, pattern: RegExp): string[] {
	const out: string[] = [];
	for (const a of item.querySelectorAll(selector)) {
		const h = linkHandle(a, pattern);
		if (h !== undefined) out.push(h);
	}
	return out;
}

/** The account the first link under `item` that `selector` finds and `pattern` matches names, when `keep` allows the link. */
function firstHandle(item: Element, selector: string, pattern: RegExp, keep: (a: Element) => boolean = () => true) {
	for (const a of item.querySelectorAll(selector)) {
		const h = keep(a) ? linkHandle(a, pattern) : undefined;
		if (h) return [h];
	}
	return [];
}

const X: SiteProfile = {
	items: 'article[data-testid="tweet"]',
	target: (item) => item.closest('[data-testid="cellInnerDiv"]') ?? item,
	handles(item) {
		const out = linkHandles(item, '[data-testid="User-Name"] a[href]', /^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/);
		for (const el of item.querySelectorAll('[data-testid^="UserAvatar-Container-"]'))
			out.push(normalizeHandle(el.getAttribute("data-testid")?.slice("UserAvatar-Container-".length) ?? ""));
		return out;
	},
};

const YT_SHELF = "ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], ytm-reel-shelf-renderer";
const YOUTUBE: SiteProfile = {
	items: [
		"ytd-rich-item-renderer",
		"ytd-video-renderer",
		"ytd-compact-video-renderer",
		"ytd-grid-video-renderer",
		"ytd-playlist-renderer",
		"ytd-radio-renderer",
		"ytd-reel-item-renderer",
		YT_SHELF,
		"ytm-rich-item-renderer",
		"ytm-video-with-context-renderer",
		"ytm-compact-video-renderer",
		"ytm-shorts-lockup-view-model",
	].join(", "),
	// A shelf is matched by its title, never by the videos in it: one title in a row of ten mustn't hide all ten.
	text: (item) =>
		item.matches(YT_SHELF) ? (item.querySelector("#title, h2")?.textContent ?? "") : (item.textContent ?? ""),
	handles: (item) => linkHandles(item, 'a[href^="/@"], a[href^="/channel/"]', /^\/(?:@|channel\/)([^/?#]+)/),
	formats: {
		// "Shorts" means the format on YouTube: the Shorts shelves and Shorts tiles, not every title with the word.
		shorts: (item) =>
			item.matches(`${YT_SHELF}, ytd-reel-item-renderer, ytm-shorts-lockup-view-model`) ||
			item.querySelector('a[href^="/shorts/"]') !== null,
	},
};

const REDDIT: SiteProfile = {
	// Posts only: a comment's text holds its replies, so a reply's word would hide the thread above it.
	items: "shreddit-post, shreddit-ad-post, div.thing.link",
	target: (item) => (item.parentElement?.tagName === "ARTICLE" ? item.parentElement : item),
	handles(item) {
		const out: string[] = [];
		const author = item.getAttribute("author") ?? item.getAttribute("data-author");
		if (author) out.push(normalizeHandle(author));
		const sub = item.getAttribute("subreddit-prefixed-name") ?? item.getAttribute("data-subreddit-prefixed");
		const bare = item.getAttribute("data-subreddit");
		if (sub) out.push(normalizeHandle(sub));
		else if (bare) out.push(normalizeHandle(`r/${bare}`));
		if (!out.length) out.push(...linkHandles(item, 'a[href*="/user/"], a[href*="/u/"]', /\/(?:user|u)\/([^/?#]+)/));
		return out;
	},
};

const HACKER_NEWS: SiteProfile = {
	items: "tr.athing",
	also(item) {
		if (item.classList.contains("comtr")) return [];
		const sub = item.nextElementSibling;
		const spacer = sub?.nextElementSibling;
		return [sub, spacer?.classList.contains("spacer") ? spacer : null].filter((e): e is Element => !!e);
	},
	handles(item) {
		const row = item.classList.contains("comtr") ? item : item.nextElementSibling;
		const user = row?.querySelector(".hnuser")?.textContent;
		return user ? [normalizeHandle(user)] : [];
	},
};

const BLUESKY: SiteProfile = {
	items: '[data-testid^="feedItem-by-"]',
	// The author only: a post's body links the accounts it mentions, replies to and quotes, and a filter on one of them
	// mustn't hide everyone who talks to it. Bluesky names the author on the item; without that (a filter's own selector),
	// the first profile link, which is the post header's avatar or name.
	handles(item) {
		const testid = item.getAttribute("data-testid") ?? "";
		if (testid.startsWith("feedItem-by-")) return [normalizeHandle(testid.slice("feedItem-by-".length))];
		return firstHandle(item, 'a[href^="/profile/"]', /^\/profile\/([^/?#]+)/);
	},
};

const LINKEDIN: SiteProfile = {
	items: 'div.feed-shared-update-v2, div[data-urn^="urn:li:activity"]',
	handles: (item) => linkHandles(item, 'a[href*="/in/"], a[href*="/company/"]', /\/(?:in|company)\/([^/?#]+)/),
};

const AUTHOR_LINK = /\/(?:@|users?\/|u\/)([^/?#]+)/;
const ARTICLE = '[role="article"], article';

/**
 * Any other site: articles, and their author, read from an author-shaped link (/@name, /user/name, /u/name). Only one
 * link counts, so a mention or a quoted post in the body never makes its account the author: the first author-shaped
 * link in a `header` inside the item or with rel=author, else the first author-shaped link at all (Mastodon puts the
 * display name before the post's text). Links inside an article nested in this one belong to that article: it is an item
 * of its own. Mastodon's "Alice boosted" line names who shared the post, not who wrote it, so its link never counts.
 */
export const GENERIC: SiteProfile = {
	items: ARTICLE,
	handles(item) {
		const own = (a: Element) => {
			if (a.closest(".status__prepend")) return false;
			const article = a.closest(ARTICLE);
			return !article || article.contains(item);
		};
		const byline = firstHandle(item, ':scope header a[href], a[rel~="author"][href]', AUTHOR_LINK, own);
		return byline.length ? byline : firstHandle(item, "a[href]", AUTHOR_LINK, own);
	},
};

const SITES: Array<[string, SiteProfile]> = [
	["x.com", X],
	["twitter.com", X],
	["youtube.com", YOUTUBE],
	["reddit.com", REDDIT],
	["news.ycombinator.com", HACKER_NEWS],
	["bsky.app", BLUESKY],
	["linkedin.com", LINKEDIN],
];

/** The profile for a page's host name: its own site's, or the generic one. */
export function siteProfile(hostname: string): SiteProfile {
	const h = hostname.toLowerCase();
	for (const [host, profile] of SITES) if (h === host || h.endsWith(`.${host}`)) return profile;
	return GENERIC;
}
