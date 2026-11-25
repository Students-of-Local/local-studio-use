/**
 * The feed filter on a page: finds feed items (site-edits/feed-sites.ts), hides the ones a filter matches
 * (site-edits/feed-match.ts) and shows how many it hid. Runs in the extension's content script (site-edits/feed-filter.ts);
 * takes the document and the filters as arguments, so tests run it on a fixture page.
 *
 * - Hiding is a class and one stylesheet: nodes are never removed, so the site's own code keeps working and a reveal is
 *   one class on <html>.
 * - New items (infinite scroll) come through a MutationObserver. Changes are gathered and handled once per frame, before
 *   the frame is drawn, so a matched post is never painted.
 * - A small badge says how many are hidden. Clicking it shows them, outlined; the x closes it for this page. Its shadow
 *   root is open: the page could count the hidden posts anyway, and an agent reads the count there.
 */

import { type CompiledFilter, compileFilter, type FeedFilterSpec } from "./feed-match.js";
import { type SiteProfile, siteProfile } from "./feed-sites.js";

export const HIDDEN_CLASS = "tk-feed-hidden";
export const REVEAL_CLASS = "tk-feed-reveal";
const STYLE_ID = "tk-feed-filter-style";
/** A post's text past this is not read: feed items are short, and a long one costs no more than this. */
const MAX_TEXT = 10_000;
/** Never hidden, whatever selector a filter names: hiding one would blank the page. */
const PAGE_ROOTS = "html, body, main, [role=main]";

const CSS = `html:not(.${REVEAL_CLASS}) .${HIDDEN_CLASS} { display: none !important; }
html.${REVEAL_CLASS} .${HIDDEN_CLASS} { outline: 2px dashed currentColor !important; outline-offset: -2px; opacity: 0.6; }`;

const BADGE_CSS = `
.b { display: flex; align-items: center; gap: 2px; padding: 2px 4px 2px 6px; border: 1px solid GrayText; border-radius: 999px;
	color-scheme: light dark; background: Canvas; color: CanvasText; font: 13px/1.3 system-ui, sans-serif; }
button { all: unset; cursor: pointer; padding: 4px 6px; border-radius: 999px; }
button:hover { text-decoration: underline; }
button:focus-visible { outline: 2px solid Highlight; }
.x { font-size: 15px; line-height: 1; }`;

/** Elements that sit inside a line of text. Text in two different non-inline elements is two lines, never one word. */
const INLINE = new Set(
	"A ABBR B BDI BDO CITE CODE DATA DEL DFN EM FONT I INS KBD LABEL MARK Q S SAMP SMALL SPAN STRONG SUB SUP TIME U VAR".split(
		" ",
	),
);
const NO_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
/** Elements with no text of their own that part what is on either side: a line break, or something drawn in the line. */
const BREAKS = new Map([
	["BR", "\n"],
	["HR", "\n"],
	...["IMG", "SVG", "VIDEO", "CANVAS", "INPUT", "OBJECT", "IFRAME"].map((tag): [string, string] => [tag, " "]),
]);

/**
 * An element's text as a person reads it, without layout: textContent runs a name, a time and the post together
 * ("1hcrypto"), so a word at the edge of one would miss. Text in different blocks is joined with a line break; text split
 * across inline elements (<b>cry</b>pto) stays one word.
 */
export function itemText(root: Element, max = MAX_TEXT): string {
	const walker = root.ownerDocument.createTreeWalker(root, 5 /* NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT */);
	let out = "";
	let lastBlock: Node | null = null;
	for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) {
		if (n.nodeType === 1) {
			out += BREAKS.get((n as Element).tagName.toUpperCase()) ?? "";
			continue;
		}
		const text = n.nodeValue;
		const parent = n.parentNode as Element | null;
		if (!text || (parent && NO_TEXT.has(parent.tagName))) continue;
		let block: Node | null = parent;
		while (block && block !== root && INLINE.has((block as Element).tagName)) block = block.parentNode;
		if (lastBlock && block !== lastBlock) out += "\n";
		out += text;
		lastBlock = block;
	}
	return out.slice(0, max);
}

interface Group {
	selector: string;
	profile: SiteProfile;
	/** The filter named its own selector: the item is what gets hidden, with no rows of the site's added. */
	custom: boolean;
	filters: CompiledFilter[];
}

export interface FeedFilterStats {
	/** Items hidden on the page now. */
	hidden: number;
	batches: number;
	/** Items checked in the last batch. */
	lastBatchItems: number;
	lastBatchMs: number;
	maxBatchMs: number;
}

export interface FeedFilter {
	/** New filters (the person changed them): everything is checked again at once, with no frame between. */
	update(specs: FeedFilterSpec[]): void;
	/** Handle what is waiting now instead of on the next frame. */
	flush(): void;
	stats(): FeedFilterStats;
	/** Show everything, take the sheet and badge out, stop watching. */
	stop(): void;
}

export function startFeedFilter(
	doc: Document,
	specs: FeedFilterSpec[],
	opts: { hostname: string; badge?: boolean },
): FeedFilter {
	const win = doc.defaultView;
	const now = () => win?.performance?.now() ?? Date.now();
	const profile = siteProfile(opts.hostname);
	let groups: Group[] = [];
	const pending = new Set<Element>();
	let scheduled = false;
	/** Who hid each hidden element, so an item that no longer matches shows only what it hid. */
	const owner = new WeakMap<Element, Element>();
	const hiddenItems = new Set<Element>();
	const stats: FeedFilterStats = { hidden: 0, batches: 0, lastBatchItems: 0, lastBatchMs: 0, maxBatchMs: 0 };
	let style: HTMLStyleElement | undefined;
	let revealed = false;
	let dismissed = false;
	let badge: { host: HTMLElement; label: HTMLButtonElement } | undefined;

	function compile(list: FeedFilterSpec[]): Group[] {
		const bySelector = new Map<string, Group>();
		for (const spec of list) {
			const selector = spec.items ?? profile.items;
			try {
				doc.querySelector(selector);
			} catch {
				continue; // a selector this browser can't read hides nothing, and never stops the other filters
			}
			let group = bySelector.get(selector);
			if (!group) {
				group = { selector, profile, custom: !!spec.items, filters: [] };
				bySelector.set(selector, group);
			}
			group.filters.push(compileFilter(spec, profile.formats));
		}
		return [...bySelector.values()];
	}

	function ensureStyle() {
		if (style?.isConnected) return;
		style = doc.createElement("style");
		style.id = STYLE_ID;
		style.textContent = CSS;
		(doc.head ?? doc.documentElement).append(style);
	}

	function hide(item: Element, targets: Element[]) {
		for (const t of targets) {
			t.classList.add(HIDDEN_CLASS);
			owner.set(t, item);
		}
		hiddenItems.add(item);
	}

	function show(item: Element, targets: Element[]) {
		hiddenItems.delete(item);
		for (const t of targets) {
			if (!t.classList.contains(HIDDEN_CLASS)) continue;
			const by = owner.get(t);
			// A list that reuses its rows (X) puts a new post in a hidden row: the old post is gone, so the row is free.
			if (by === item || !by?.isConnected) t.classList.remove(HIDDEN_CLASS);
		}
	}

	/** An item every group whose selector it matches has a say on: hidden when any of them hits. */
	function check(item: Element, matched: Group[]) {
		if (item.matches(PAGE_ROOTS)) return;
		const all: Element[] = [];
		for (const group of matched) {
			const text = group.profile.text?.(item) ?? itemText(item);
			let handles: string[] | undefined;
			const itemHandles = () => {
				handles ??= group.profile.handles(item).filter(Boolean);
				return handles;
			};
			const targets = [
				group.profile.target?.(item) ?? item,
				...(group.custom ? [] : (group.profile.also?.(item) ?? [])),
			].filter((t) => !t.matches(PAGE_ROOTS));
			if (group.filters.some((f) => f.test(text, itemHandles, item))) {
				hide(item, targets);
				return;
			}
			all.push(...targets);
		}
		show(item, all);
	}

	function batch() {
		scheduled = false;
		if (!groups.length || !pending.size) {
			pending.clear();
			return;
		}
		const start = now();
		const roots = [...pending];
		pending.clear();
		const found = new Map<Element, Group[]>();
		const add = (el: Element, group: Group) => {
			const list = found.get(el);
			if (!list) found.set(el, [group]);
			else if (!list.includes(group)) list.push(group);
		};
		for (const root of roots) {
			if (!root.isConnected) continue;
			for (const group of groups) {
				// Text that arrived inside a post already on the page: check the post again.
				const up = root.closest(group.selector);
				if (up) add(up, group);
				for (const el of root.querySelectorAll(group.selector)) add(el, group);
			}
		}
		if (found.size) ensureStyle();
		for (const [item, matched] of found) check(item, matched);
		for (const item of hiddenItems) if (!item.isConnected) hiddenItems.delete(item);
		const ms = now() - start;
		stats.batches++;
		stats.lastBatchItems = found.size;
		stats.lastBatchMs = ms;
		stats.maxBatchMs = Math.max(stats.maxBatchMs, ms);
		if (stats.hidden !== hiddenItems.size || (hiddenItems.size && !badge?.host.isConnected)) {
			stats.hidden = hiddenItems.size;
			renderBadge();
		}
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		// Before the next frame is drawn. A background tab draws no frames, but an agent may read it, so it gets a timer.
		if (win?.requestAnimationFrame && doc.visibilityState !== "hidden") win.requestAnimationFrame(batch);
		else setTimeout(batch, 0);
	}

	const observer = new (win?.MutationObserver ?? MutationObserver)((records) => {
		for (const r of records) {
			for (const n of r.addedNodes) {
				if (n.nodeType === 1) pending.add(n as Element);
				else if (n.parentElement) pending.add(n.parentElement);
			}
		}
		if (pending.size) schedule();
	});
	let observing = false;
	// A frame asked for just before the tab went to the background never comes while it stays there.
	const onVisibility = () => {
		if (pending.size) batch();
	};
	doc.addEventListener("visibilitychange", onVisibility);

	function setReveal(on: boolean) {
		revealed = on;
		doc.documentElement.classList.toggle(REVEAL_CLASS, on);
		renderBadge();
	}

	function makeBadge() {
		const host = doc.createElement("div");
		host.setAttribute("data-local-studio", "feed-filter");
		host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; left: 16px; bottom: 16px;";
		const root = host.attachShadow({ mode: "open" });
		const css = doc.createElement("style");
		css.textContent = BADGE_CSS;
		const box = doc.createElement("div");
		box.className = "b";
		box.setAttribute("role", "region");
		box.setAttribute("aria-label", "Local Studio feed filter");
		const label = doc.createElement("button");
		label.type = "button";
		label.className = "show";
		label.addEventListener("click", () => setReveal(!revealed));
		const close = doc.createElement("button");
		close.type = "button";
		close.className = "x";
		close.textContent = "×";
		close.title = "Dismiss";
		close.setAttribute("aria-label", "Dismiss");
		close.addEventListener("click", () => {
			dismissed = true;
			setReveal(false);
			host.remove();
		});
		box.append(label, close);
		root.append(css, box);
		return { host, label };
	}

	function renderBadge() {
		if (opts.badge === false || dismissed) return;
		const n = stats.hidden;
		if (!n && !revealed) {
			badge?.host.remove();
			return;
		}
		badge ??= makeBadge();
		if (!badge.host.isConnected) doc.documentElement.append(badge.host);
		badge.label.textContent = revealed ? `Showing ${n} filtered. Hide them` : `${n} hidden by your filter`;
		badge.label.title = revealed ? "Hide them again" : "Show what your filter hid";
		badge.label.setAttribute("aria-pressed", String(revealed));
	}

	function showAll() {
		for (const el of doc.querySelectorAll(`.${HIDDEN_CLASS}`)) el.classList.remove(HIDDEN_CLASS);
		hiddenItems.clear();
	}

	function update(next: FeedFilterSpec[]) {
		groups = compile(next);
		showAll();
		if (!groups.length) {
			observer.disconnect();
			observing = false;
			pending.clear();
			stats.hidden = 0;
			setReveal(false);
			return;
		}
		if (!observing) {
			observer.observe(doc.documentElement, { childList: true, subtree: true });
			observing = true;
		}
		pending.add(doc.documentElement);
		batch();
	}

	update(specs);

	return {
		update,
		flush() {
			for (const r of observer.takeRecords()) {
				for (const n of r.addedNodes) {
					if (n.nodeType === 1) pending.add(n as Element);
					else if (n.parentElement) pending.add(n.parentElement);
				}
			}
			if (pending.size) batch();
		},
		stats: () => ({ ...stats }),
		stop() {
			doc.removeEventListener("visibilitychange", onVisibility);
			groups = [];
			observer.disconnect();
			observing = false;
			pending.clear();
			showAll();
			doc.documentElement.classList.remove(REVEAL_CLASS);
			style?.remove();
			badge?.host.remove();
		},
	};
}
