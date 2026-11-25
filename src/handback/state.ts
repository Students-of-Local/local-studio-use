/**
 * Hand-back with Continue: an agent stops for the user (a sign-in, a 2FA code, a captcha, a payment, a password field it
 * must not fill) with tabs_show {"wait":true,"reason":...}. The tab stays where it is and nothing takes focus. The veil's
 * pill on the tab and every open side panel say "Your turn" with a Continue button, and the toolbar icon gets a badge.
 * One click on Continue answers the agent's call and its run goes on. Pure: src/handback/worker.ts keeps the waits,
 * src/handback/panel.ts draws the cards, cli/src/handback.ts is the MCP half.
 */

export const HANDBACK_KEY = "handback_pending";
/** The panel presses Continue by writing `handback_continue_<id>` (chrome.storage.session, which pages can't reach). */
export const CONTINUE_KEY_PREFIX = "handback_continue_";
export const HANDBACK_TIMEOUT_MS = 10 * 60 * 1000;
export const REASON_MAX = 80;

export interface PendingHandback {
	id: string;
	clientId: string;
	sessionId: string;
	tabId: number;
	/** What the user is asked to do ("Sign in"), one plain line. */
	reason: string;
	/** Who asks, as the veil's pill says it ("Claude", "local-studio-browser"). */
	agent: string;
	detail: string;
	color: string;
	tabTitle: string;
	/** A sign-in the user types in its own window (sign-in.ts): the site, read from the tab, and the fields' refs. */
	signIn?: { origin: string; host: string; fields: { username?: string; password?: string } };
	createdAt: number;
	expiresAt: number;
}

/** How a wait ended. */
export type HandbackEnd =
	| "continued"
	| "signed_in"
	| "declined"
	| "failed"
	| "taken"
	| "closed"
	| "timeout"
	| "disconnected"
	| "aborted";

export interface HandbackOutcome {
	status: HandbackEnd;
	text: string;
}

/** The reason as one short plain line; "Your turn" when the agent gave none. */
export function cleanReason(value: unknown): string {
	if (typeof value !== "string") return "Your turn";
	const visible = Array.from(value, (c) => {
		const code = c.charCodeAt(0);
		return code < 0x20 || code === 0x7f ? " " : c;
	}).join("");
	const line = visible.replace(/\s+/g, " ").trim();
	if (!line) return "Your turn";
	return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 3).trimEnd()}...` : line;
}

/** What the agent reads when its wait ends. */
export function handbackOutcome(
	end: HandbackEnd,
	tabId: number,
	reason: string,
	timeoutMs = HANDBACK_TIMEOUT_MS,
	why = "",
): HandbackOutcome {
	const text: Record<HandbackEnd, string> = {
		continued: `The user pressed Continue on tab ${tabId} (${reason}). The tab is still yours: read_page to see where the page is now, then go on.`,
		signed_in: `The user typed their sign-in and it is in the page's fields on tab ${tabId}. You were not given it: never read the fields back. Submit the form (click its button), then read_page.`,
		declined: `The user chose not to type a sign-in on tab ${tabId} (${reason}). Nothing was entered. Ask them how to go on.`,
		failed: `The sign-in was not completed on tab ${tabId}: ${why} read_page, then ask again with the fields' refs, or call tabs_show with wait so the user signs in on the page.`,
		taken: `The user took tab ${tabId} back instead of pressing Continue (${reason}). It is theirs now and you can't use it; ask them how to go on.`,
		closed: `The user closed tab ${tabId} instead of pressing Continue (${reason}). Ask them how to go on.`,
		timeout: `No Continue after ${Math.round(timeoutMs / 60000)} minutes (${reason}). Tab ${tabId} is still yours; ask the user whether they finished before you go on.`,
		disconnected: `The wait on tab ${tabId} ended: the browser connection closed before the user pressed Continue.`,
		aborted: `You stopped waiting on tab ${tabId} before the user pressed Continue.`,
	};
	return { status: end, text: text[end] };
}

/** The waits still open at `now`, oldest first. */
export function openHandbacks(value: unknown, now: number): PendingHandback[] {
	if (!Array.isArray(value)) return [];
	return (value as PendingHandback[])
		.filter((p) => p && typeof p.id === "string" && Number.isInteger(p.tabId) && p.expiresAt > now)
		.sort((a, b) => a.createdAt - b.createdAt);
}
