/**
 * The one-switch changes Settings > Sites offers on a site: each is an ordinary edit the person adds by switching it on,
 * so it lists, undoes and exports like any other.
 */

import { DARK, onHost } from "./common.js";
import { checkValue, type EditKind, type SiteEdit, type SiteEditsState } from "./store.js";

export interface ReadyMade {
	name: string;
	/** The site it is for; none means any site. */
	host?: string;
	kind: EditKind;
	value: string;
}

const READY_MADE: readonly ReadyMade[] = [
	{ name: "Dark", kind: "style", value: DARK },
	{
		name: "Hide Shorts",
		host: "youtube.com",
		kind: "filter",
		value: checkValue("filter", JSON.stringify({ words: ["Shorts"], handles: [] })),
	},
	{ name: "Hide comments", host: "youtube.com", kind: "hide", value: "#comments" },
	{ name: "Hide related videos", host: "youtube.com", kind: "hide", value: "#related" },
	{ name: "Hide the right column", host: "x.com", kind: "hide", value: '[data-testid="sidebarColumn"]' },
	{ name: "Hide the right column", host: "reddit.com", kind: "hide", value: "#right-sidebar-container" },
];

/** What a page at `url` can be switched to. */
export function readyMadeFor(url: string): ReadyMade[] {
	return READY_MADE.filter((r) => !r.host || onHost(url, r.host));
}

/** The edit a ready-made switch stands for, on `host` (its own site where it names one). */
export function readyMadeEdit(state: SiteEditsState, ready: ReadyMade, host: string): SiteEdit | undefined {
	return state.edits.find((e) => e.host === (ready.host ?? host) && e.kind === ready.kind && e.value === ready.value);
}
