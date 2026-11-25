/**
 * "Give this tab to Local Studio": the menu items on a page and on the toolbar icon, and the note the service worker leaves
 * for the side panel. Pure: src/handoff/worker.ts builds the menu from it and src/handoff/panel.ts reads the note.
 *
 * - "Give this tab to Local Studio" opens the window's side panel on a new chat about that tab. The worker opens the panel
 *   in the click's gesture tick and writes `{windowId, tabId, at}` under HANDOFF_KEY; the panel (open already, or just
 *   opening) takes the note once and starts the chat. A note older than HANDOFF_FRESH_MS is ignored, so a panel opened
 *   later never jumps to a tab given long ago.
 * - "Change this site" opens the side panel on Settings > Sites, where the page in front of the person comes first.
 * - One more item per agent working in the browser ("Give this tab to Claude · local-studio-browser"). The tab joins that agent's
 *   tab group, the same as dragging it in, and the agent is told.
 */

import { veilViewFor } from "../browser/veil-state.js";

export const HANDOFF_KEY = "panel_handoff";
/** The same note for "Change this site": open the panel on Settings > Sites. */
export const CHANGE_SITE_KEY = "panel_change_site";
export const HANDOFF_FRESH_MS = 30_000;
/** The panel item's id; an agent's item is AGENT_ITEM_PREFIX + its session id. */
export const PANEL_ITEM_ID = "local-studio-give-panel";
export const CHANGE_SITE_ITEM_ID = "local-studio-change-site";
export const AGENT_ITEM_PREFIX = "local-studio-give-agent:";
/** At most this many agents get an item: the most recently used. */
export const MAX_AGENT_ITEMS = 4;
/** An agent unused for this long is left off the menu. */
export const AGENT_ITEM_MAX_IDLE_MS = 2 * 60 * 60 * 1000;

export interface Handoff {
	windowId: number;
	tabId: number;
	at: number;
}

export interface MenuItem {
	id: string;
	title: string;
	/** Only on a web page itself. */
	pageOnly?: boolean;
}

/** The fields of a stored session the menu reads (src/browser/session.ts PersistedSession). */
export interface MenuSession {
	id: string;
	label: string;
	color: string;
	agent?: string;
	agentLabel?: string;
	lastUsedAt?: number;
	createdAt?: number;
}

/** The note for `windowId`, if it is well formed and fresh. */
export function freshHandoff(value: unknown, windowId: number, now: number): Handoff | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const h = value as Partial<Handoff>;
	if (h.windowId !== windowId || !Number.isInteger(h.tabId) || typeof h.at !== "number") return undefined;
	if (now - h.at > HANDOFF_FRESH_MS || h.at - now > HANDOFF_FRESH_MS) return undefined;
	return { windowId, tabId: h.tabId as number, at: h.at };
}

/** The menu: the panel's items first, then the agents used most recently. */
export function menuItems(sessions: MenuSession[], now: number): MenuItem[] {
	const agents = sessions
		.filter((s) => s.id.startsWith("bridge-"))
		.map((s) => ({ s, used: s.lastUsedAt ?? s.createdAt ?? 0 }))
		.filter(({ used }) => now - used <= AGENT_ITEM_MAX_IDLE_MS)
		.sort((a, b) => b.used - a.used)
		.slice(0, MAX_AGENT_ITEMS);
	return [
		{ id: PANEL_ITEM_ID, title: "Give this tab to Local Studio" },
		{ id: CHANGE_SITE_ITEM_ID, title: "Change this site", pageOnly: true },
		...agents.map(({ s }) => {
			const view = veilViewFor(s);
			const who = [view.agent, view.detail].filter(Boolean).join(" · ");
			return { id: `${AGENT_ITEM_PREFIX}${s.id}`, title: `Give this tab to ${who.slice(0, 60)}` };
		}),
	];
}

/** Whose item was clicked: the panel's, the site's, an agent session's, or nothing of ours. */
export function itemTarget(
	menuItemId: unknown,
): { kind: "panel" } | { kind: "site" } | { kind: "agent"; sessionId: string } | undefined {
	if (menuItemId === PANEL_ITEM_ID) return { kind: "panel" };
	if (menuItemId === CHANGE_SITE_ITEM_ID) return { kind: "site" };
	if (typeof menuItemId === "string" && menuItemId.startsWith(AGENT_ITEM_PREFIX)) {
		const sessionId = menuItemId.slice(AGENT_ITEM_PREFIX.length);
		if (sessionId.startsWith("bridge-")) return { kind: "agent", sessionId };
	}
	return undefined;
}
