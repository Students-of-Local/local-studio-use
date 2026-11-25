/** A site change in a person's words, for the cards and Settings > Sites. */

import { DARK, type EditKind, type SiteEdit } from "./common.js";
import { filterSummary, parseFilterValue } from "./feed-match.js";

export const KIND_WORDS: Record<EditKind, string> = {
	hide: "Hides",
	style: "Restyles",
	block: "Blocks",
	filter: "Filters the feed",
	script: "Script",
};

/** The edit's own value, as a line: selectors, a pattern, or a filter's words and accounts. */
export function changeDetail(e: SiteEdit): string {
	if (e.kind !== "filter") return e.value;
	try {
		return filterSummary(parseFilterValue(e.value));
	} catch {
		return e.value;
	}
}

/** A filter's words and accounts, as one short list. */
function filterWords(value: string): string {
	try {
		const { words, handles } = parseFilterValue(value);
		const accounts = handles.map((h) => (h.includes("/") ? h : `@${h}`));
		return [...words, ...accounts].join(", ").slice(0, 80);
	} catch {
		return value.slice(0, 80);
	}
}

/** Its title: the note it was saved with, else what it does. */
export function changeTitle(e: SiteEdit): string {
	if (e.note) return e.note;
	if (e.kind === "style") return e.value === DARK ? "Dark" : "Restyles the page";
	if (e.kind === "script") return "Runs a script";
	if (e.kind === "filter") return `Hides posts: ${filterWords(e.value)}`;
	return `${KIND_WORDS[e.kind]} ${changeDetail(e).replace(/\s+/g, " ").slice(0, 80)}`;
}

/** Who added it. */
export function addedBy(e: SiteEdit): string {
	return e.addedBy === "you" ? "You" : e.addedBy.replace(/^agent:/, "");
}
