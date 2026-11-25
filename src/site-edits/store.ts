import {
	EDIT_KINDS,
	type EditKind,
	MAX_EDITS,
	MAX_NOTE,
	MAX_SCRIPT,
	onHost,
	type SiteEdit,
	STORAGE_KEY,
} from "./common.js";
import {
	MAX_HANDLES,
	MAX_TERM,
	MAX_TERMS,
	normalizeHandle,
	parseFilterValue,
	regexTerm,
	riskyPattern,
} from "./feed-match.js";
import { PUBLIC_SUFFIX_RULES } from "./public-suffixes.js";
import { checkSelectors, SiteEditError } from "./selectors.js";
import { load, type SiteEditsState } from "./state.js";
import { checkStyle, styleCss } from "./style.js";

export {
	checkSelectors,
	EDIT_KINDS,
	type EditKind,
	load,
	MAX_EDITS,
	onHost,
	type SiteEdit,
	SiteEditError,
	type SiteEditsState,
	STORAGE_KEY,
};

/**
 * Site edits: changes to how a site looks or loads, kept per site and applied on every visit.
 *
 * - hide: CSS selectors whose elements are hidden (a banner, a sidebar, an ad slot).
 * - style: CSS rules that recolor, resize or space what the site shows (site-edits/style.ts), or the ready-made dark look.
 * - block: a request pattern blocked on that site only (a tracker, an ad server, an autoplay video).
 * - script: JavaScript that runs on the site after it loads. It runs with the user's sign-in on every visit, so
 *   an agent can only propose one: it stays off until the person turns it on in Settings > Sites.
 * - filter: feed items to hide by the words in them or who posted them (site-edits/feed-match.ts). The extension's own
 *   content script does the hiding (site-edits/feed-filter.ts), so it is data, not code, and starts on like hide.
 *
 * Ad blocking is one switch for a list of known ad networks (static/ads-rules.json).
 *
 * This file holds the rules and the storage; site-edits/apply.ts makes the browser follow them.
 */

/** Who changed it. Only "person" can turn a script on. */
export type Actor = "person" | "agent";

const MAX_PATTERN = 500;

/** "https://www.X.com/home" or "X.com" -> "x.com". Throws on anything that isn't a plain host. */
let suffixes: { rules: Set<string>; shared: Set<string>; wild: Set<string>; except: Set<string> } | undefined;

/**
 * The Public Suffix List, read once. `shared` holds every rule, every wildcard rule's base ("*.sch.uk" gives sch.uk) and every
 * name above one of them (s3.amazonaws.com gives amazonaws.com): an edit reaches subdomains, so an edit on any of those reaches
 * sites that aren't the same owner's.
 */
function suffixRules() {
	if (suffixes) return suffixes;
	const rules = new Set<string>();
	const shared = new Set<string>();
	const wild = new Set<string>();
	const except = new Set<string>();
	const withParents = (name: string) => {
		const labels = name.split(".");
		for (let i = 0; i < labels.length; i++) shared.add(labels.slice(i).join("."));
	};
	for (const rule of PUBLIC_SUFFIX_RULES.split("\n")) {
		if (rule.startsWith("!")) except.add(rule.slice(1));
		else if (rule.startsWith("*.")) {
			wild.add(rule.slice(2));
			withParents(rule.slice(2));
		} else {
			rules.add(rule);
			withParents(rule);
		}
	}
	suffixes = { rules, shared, wild, except };
	return suffixes;
}

/**
 * Whether an edit on `host` would reach sites many owners share, by the Public Suffix List with its private section: `host`
 * is a suffix (com, co.uk, github.io, uk.com), a wildcard's base or a name under one (kawasaki.jp, anything.kawasaki.jp), or a
 * name above a suffix (amazonaws.com above s3.amazonaws.com). An exception rule (city.kawasaki.jp) is a site.
 */
export function sharedSuffix(host: string): boolean {
	const { shared, wild, except } = suffixRules();
	if (except.has(host)) return false;
	if (shared.has(host)) return true;
	const dot = host.indexOf(".");
	return dot > 0 && wild.has(host.slice(dot + 1));
}

/**
 * The registrable domain of a host by the Public Suffix List with its private section, as Chrome groups sites: the
 * longest matching rule is the suffix, plus one label (mail.web.de and www.web.de give web.de, a.github.io stays itself).
 * A host that is itself a suffix is its own site. With no rule, the last label is the suffix.
 */
export function registrableDomain(host: string): string {
	const { rules, wild, except } = suffixRules();
	const labels = host.split(".");
	for (let i = 0; i < labels.length; i++) {
		const name = labels.slice(i).join(".");
		if (except.has(name)) return name;
		if (rules.has(name) || (i + 1 < labels.length && wild.has(labels.slice(i + 1).join("."))))
			return i > 0 ? labels.slice(i - 1).join(".") : host;
	}
	return labels.slice(-2).join(".");
}

/** A guarded host ("host" or "host:port") that `host` or one of its subdomains is, if any: an edit on `host` would reach it. */
export function guardedUnder(host: string, guarded: readonly string[]): string | undefined {
	for (const entry of guarded) {
		const h = entry
			.toLowerCase()
			.replace(/^\[|\]$/g, "")
			.replace(/:\d+$/, "")
			.replace(/\.$/, "");
		if (h === host || h.endsWith(`.${host}`)) return h;
	}
	return undefined;
}

export function normalizeHost(raw: string): string {
	let host = raw.trim().toLowerCase();
	try {
		if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname;
	} catch {
		throw new SiteEditError(`${raw} isn't a site.`);
	}
	// "*.x.com" names x.com and its subdomains, which is what every edit covers already.
	host = host
		.replace(/^\*\./, "")
		.replace(/^www\./, "")
		.replace(/\.$/, "");
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 253)
		throw new SiteEditError(`${raw} isn't a site. Use one like example.com.`);
	// Part of an address ("0.1", which the browser reads as 0.0.0.1) or one written another way is no site.
	let canonical: string | undefined;
	try {
		canonical = new URL(`https://${host}/`).hostname;
	} catch {
		// "256.1.1.1": no address at all.
	}
	if (canonical !== host) throw new SiteEditError(`${raw} isn't a site. Use one like example.com.`);
	if (sharedSuffix(host))
		throw new SiteEditError(
			`${host} is shared by many sites, so an edit there would reach all of them. Name the site itself.`,
		);
	return host;
}

/** A request pattern in the browser's own syntax (`||ads.example.com^`, `/banner/`), never the page itself. */
export function checkPattern(raw: string): string {
	const pattern = raw.trim();
	if (!pattern) throw new SiteEditError("Give a request pattern to block, like ||ads.example.com^ or /banner/.");
	if (pattern.length > MAX_PATTERN) throw new SiteEditError(`A pattern is limited to ${MAX_PATTERN} characters.`);
	if (/\s/.test(pattern)) throw new SiteEditError("A pattern has no spaces.");
	// The browser refuses the whole list over one rule it can't take, and every block would stop with it.
	if (!/^[\x21-\x7e]+$/.test(pattern))
		throw new SiteEditError("Plain ASCII only in a pattern. Encode other characters as the URL does (%C3%BC).");
	if (pattern.slice(2).includes("||") || (pattern.includes("||") && !pattern.startsWith("||")))
		throw new SiteEditError("|| goes only at the start, for a domain: ||ads.example.com^");
	// A bare "*", "|", "^", a scheme ("https://", "|htt"), wildcards between letters ("h*t*t*p*") or a domain that starts with a
	// wildcard ("||*ads") would block everything the site loads: the pattern must hold a run of three or more letters or digits
	// that isn't part of a scheme name.
	const named = (pattern.match(/[a-z0-9-]+/gi) ?? []).some(
		(run) => run.length >= 3 && !"https".includes(run.toLowerCase()) && !"wss".includes(run.toLowerCase()),
	);
	if (!named || /^\|\|\*/.test(pattern))
		throw new SiteEditError("That pattern would block everything on the site. Name what to block.");
	return pattern;
}

/**
 * A filter's value, from what an agent sent: JSON with words, handles and an optional item selector. Returns it in one
 * canonical form (trimmed, duplicates dropped, handles as "name" or "r/name"), so the same filter saved twice is one edit.
 */
export function checkFilter(raw: string): string {
	let spec: ReturnType<typeof parseFilterValue>;
	try {
		spec = parseFilterValue(raw);
	} catch {
		throw new SiteEditError('A filter is JSON: {"words":["crypto"],"handles":["@name"]}.');
	}
	const words: string[] = [];
	const seen = new Set<string>();
	for (const w of spec.words) {
		const term = w.trim();
		if (!term || seen.has(term.toLowerCase())) continue;
		if (term.length > MAX_TERM) throw new SiteEditError(`A word or pattern is limited to ${MAX_TERM} characters.`);
		const re = regexTerm(term);
		if (re) {
			try {
				new RegExp(re.source, re.flags);
			} catch {
				throw new SiteEditError(`${term} isn't a pattern the browser can read.`);
			}
			const risky = riskyPattern(re.source);
			if (risky) throw new SiteEditError(`${term} ${risky}, which could freeze the page. Write it more simply.`);
		}
		seen.add(term.toLowerCase());
		words.push(term);
	}
	const handles = [...new Set(spec.handles.map(normalizeHandle).filter(Boolean))];
	for (const h of handles)
		if (!/^(r\/)?[\p{L}\p{N}_.-]{1,100}$/u.test(h))
			throw new SiteEditError(`${h} isn't an account name. Use @name, u/name or r/subreddit.`);
	if (words.length > MAX_TERMS) throw new SiteEditError(`A filter takes up to ${MAX_TERMS} words.`);
	if (handles.length > MAX_HANDLES) throw new SiteEditError(`A filter takes up to ${MAX_HANDLES} accounts.`);
	if (!words.length && !handles.length) throw new SiteEditError("Give words or handles to filter.");
	const items = spec.items ? checkSelectors(spec.items) : undefined;
	return JSON.stringify({ words, handles, ...(items ? { items } : {}) });
}

function checkScript(raw: string): string {
	if (!raw.trim()) throw new SiteEditError("The script is empty.");
	if (raw.length > MAX_SCRIPT) throw new SiteEditError(`A script is limited to ${MAX_SCRIPT} characters.`);
	return raw;
}

export function checkValue(kind: EditKind, value: string): string {
	if (kind === "hide") return checkSelectors(value);
	if (kind === "style") return checkStyle(value);
	if (kind === "block") return checkPattern(value);
	if (kind === "filter") return checkFilter(value);
	return checkScript(value);
}

/** The state after an addition. A script from an agent starts off; the rest start on (each is one click to undo). */
export function added(
	state: SiteEditsState,
	input: { host: string; kind: EditKind; value: string; note?: string; actor: Actor; who: string },
	id: string,
	now: number,
): { state: SiteEditsState; edit: SiteEdit } {
	if (!EDIT_KINDS.includes(input.kind))
		throw new SiteEditError(`Unknown kind ${input.kind}: ${EDIT_KINDS.join(", ")}.`);
	if (state.edits.length >= MAX_EDITS)
		throw new SiteEditError(`There are already ${MAX_EDITS} site edits. Remove some in Settings > Sites.`);
	const host = normalizeHost(input.host);
	const value = checkValue(input.kind, input.value);
	const duplicate = state.edits.find((e) => e.host === host && e.kind === input.kind && e.value === value);
	if (duplicate) return { state, edit: duplicate };
	const edit: SiteEdit = {
		id,
		host,
		kind: input.kind,
		value,
		note: (input.note ?? "").trim().slice(0, MAX_NOTE),
		addedBy: input.actor === "person" ? "you" : `agent:${input.who.slice(0, 60)}`,
		on: input.kind !== "script" || input.actor === "person",
		createdAt: now,
	};
	return { state: { ...state, edits: [...state.edits, edit] }, edit };
}

/** Turning an edit on or off. Only the person turns a script on. */
export function switched(state: SiteEditsState, id: string, on: boolean, actor: Actor): SiteEditsState {
	const edit = state.edits.find((e) => e.id === id);
	if (!edit) throw new SiteEditError(`No site edit ${id}.`);
	if (on && edit.kind === "script" && actor !== "person") {
		throw new SiteEditError(
			"Only the person turns a script on, in Settings > Sites. It runs with their sign-in on every visit.",
		);
	}
	return { ...state, edits: state.edits.map((e) => (e.id === id ? { ...e, on } : e)) };
}

/** A new value for an edit, so a look is tuned in place instead of stacked. A script is never changed under its switch. */
export function updated(state: SiteEditsState, id: string, value: string, note?: string): SiteEditsState {
	const edit = state.edits.find((e) => e.id === id);
	if (!edit) throw new SiteEditError(`No site edit ${id}.`);
	if (edit.kind === "script")
		throw new SiteEditError("A script can't be changed in place: propose a new one, and remove this one.");
	const next = {
		...edit,
		value: checkValue(edit.kind, value),
		...(note?.trim() ? { note: note.trim().slice(0, MAX_NOTE) } : {}),
	};
	return { ...state, edits: state.edits.map((e) => (e.id === id ? next : e)) };
}

export function removed(state: SiteEditsState, id: string): SiteEditsState {
	if (!state.edits.some((e) => e.id === id)) throw new SiteEditError(`No site edit ${id}.`);
	return { ...state, edits: state.edits.filter((e) => e.id !== id) };
}

/**
 * One stylesheet for a document on `url`: every hide and style edit that is on and covers it, each its own rules. One
 * selector the browser can't read drops only its own rule, never the other edits on the site. Hides come last: what is
 * hidden stays hidden whatever a style sets.
 */
export function pageCss(state: SiteEditsState, url: string | undefined): string {
	const here = state.edits.filter((e) => e.on && onHost(url, e.host));
	return [
		...here.filter((e) => e.kind === "style").map((e) => styleCss(e.value)),
		...here.filter((e) => e.kind === "hide").map((e) => `${e.value} { display: none !important; }`),
	].join("\n");
}

/** Whether an edit puts CSS into pages. */
export function putsCss(edit: SiteEdit): boolean {
	return edit.kind === "hide" || edit.kind === "style";
}

/** The rule list the browser's network blocker takes for the block edits that are on. Ids come from `base`. */
export function blockRules(
	state: SiteEditsState,
	base: number,
): Array<{ id: number; priority: number; action: { type: "block" }; condition: Record<string, unknown> }> {
	return state.edits
		.filter((e) => e.on && e.kind === "block")
		.map((e, i) => ({
			id: base + i,
			priority: 1,
			action: { type: "block" as const },
			// Only on that site, and never the page itself: a bad pattern can break a page but not stop it opening.
			condition: { urlFilter: e.value, initiatorDomains: [e.host], resourceTypes: SUB_RESOURCES },
		}));
}

export const SUB_RESOURCES = [
	"sub_frame",
	"stylesheet",
	"script",
	"image",
	"font",
	"object",
	"xmlhttprequest",
	"ping",
	"media",
	"websocket",
	"other",
];

async function save(state: SiteEditsState): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

/** Every change goes through here, one at a time, so two changes can't overwrite each other. */
export async function change<T>(fn: (state: SiteEditsState) => { state: SiteEditsState; result: T }): Promise<T> {
	return navigator.locks.request(STORAGE_KEY, async () => {
		const { state, result } = fn(await load());
		await save(state);
		return result;
	});
}

export function newId(): string {
	return crypto.randomUUID().slice(0, 8);
}
