/** Names the panel, the worker and the tests share for links (src/links/parse.ts). */

import type { Gesture } from "../connect/types.js";

/** The port a click goes over: only the side panel document may open it (src/connect/gate.ts). */
export const LINKS_PORT = "local-studio-links";
/** runtime message from the panel's own agent: open a settings place. */
export const OPEN_PLACE = "local-studio-open-place";
/** chrome.storage.session: buttons agents offered, newest last. */
export const OFFERS_KEY = "agent_offers";
/** chrome.storage.session: the Settings section an agent asked the panel to show. */
export const SHOW_SETTINGS_KEY = "agent_show_settings";

export interface LinkRequest {
	id: number;
	link: string;
	gesture?: Gesture;
}

export interface LinkReply {
	id: number;
	/** What happened, in a sentence. */
	done?: string;
	error?: { code: string; message: string };
}

export interface Offer {
	clientId: string;
	/** Who offers: the agent's display name; plain text. */
	agentName: string;
	note: string;
	links: string[];
	at: number;
}

/** A card nobody clicked goes after this. */
export const OFFER_MS = 30 * 60_000;
export const OFFER_NOTE_MAX = 200;
export const OFFER_LINKS_MAX = 4;

export interface ShowSettings {
	section: string;
	agentName: string;
	at: number;
}
