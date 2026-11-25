/**
 * Sign-in for an agent: tabs_show {"username_ref":"e12","password_ref":"e14"} opens a small extension window that asks
 * the user for them (static/sign-in.html). What they type goes from that window to the service worker and from there
 * into the page's own fields. It is never stored, logged or part of any answer to the agent. The window names the site
 * from the tab, not from what the agent said. src/handback/worker.ts keeps the wait; this file has what the worker, the
 * panel and the window share.
 */

import { HANDBACK_KEY, openHandbacks, type PendingHandback } from "./state.js";

export const SIGN_IN_PAGE = "sign-in.html";
export const SIGN_IN_MESSAGE = "local-studio-sign-in";

/** The fields the agent named, by ref. */
export interface SignInFields {
	username?: string;
	password?: string;
}

/** What the user typed, for the same fields. */
export type SignInValues = SignInFields;

/** The window's message to the worker: the user's answer to one wait. */
export interface SignInMessage {
	type: typeof SIGN_IN_MESSAGE;
	id: string;
	action: "fill" | "cancel";
	values?: SignInValues;
}

/** Refs of the top page only: a field in a frame from another site belongs to that site, which the window wouldn't name. */
const TOP_REF = /^e\d+$/;

/** The agent's field refs, or why it can't be used. */
export function signInFields(value: unknown): { fields: SignInFields } | { error: string } {
	const asked = (value ?? {}) as Record<string, unknown>;
	const fields: SignInFields = {};
	for (const what of ["username", "password"] as const) {
		const ref = asked[what];
		if (ref === undefined || ref === null || ref === "") continue;
		const clean = typeof ref === "string" ? ref.trim().replace(/^@/, "").toLowerCase() : "";
		if (/^f[0-9a-z]{4}e\d+$/.test(clean))
			return {
				error: `The ${what} field is in a frame from another site. Call tabs_show with wait instead, so the user signs in on the page.`,
			};
		if (!TOP_REF.test(clean)) return { error: `${what}_ref takes a ref from read_page, such as "e12".` };
		fields[what] = clean;
	}
	if (!fields.username && !fields.password)
		return {
			error: 'A sign-in needs the ref of a username or password field: {"username_ref":"e12","password_ref":"e14"}.',
		};
	if (fields.username === fields.password) return { error: "username_ref and password_ref name the same field." };
	return { fields };
}

/** Whether a sign-in may be typed into this page: over https, or on this computer. */
export function signInOrigin(origin: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && /^(localhost|.+\.localhost|127(\.\d+){3}|\[::1\])$/.test(url.hostname);
}

/** A message from the sign-in window itself: no page, content script or other extension page may answer for the user. */
export function fromSignInWindow(sender: chrome.runtime.MessageSender): boolean {
	return sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(SIGN_IN_PAGE);
}

/** The window's answer, checked: only strings, and only for the fields that were asked for. */
export function signInValues(message: SignInMessage, fields: SignInFields): SignInValues | undefined {
	const out: SignInValues = {};
	for (const what of ["username", "password"] as const) {
		if (!fields[what]) continue;
		const value = message.values?.[what];
		if (typeof value !== "string" || !value) return undefined;
		out[what] = value;
	}
	return out;
}

/**
 * What a write came to: nothing when all of it went in, else what the agent and the user are told. `done` is what the
 * page code answered (writeSignIn), or undefined when it didn't: then only the page can say what it holds.
 */
export function signInEnd(
	done: { wrote: Array<keyof SignInFields>; why?: string } | undefined,
	agent: string,
): { why?: string; error?: string } {
	if (!done)
		return {
			why: "The page didn't answer in time, so it isn't known what went in.",
			error: `The page didn't answer, so it isn't known what went in. Look at it before ${agent} goes on.`,
		};
	if (done.why === undefined) return {};
	const some = done.wrote.length > 0;
	return {
		why: `${done.why} ${some ? "Only the username was entered." : "Nothing was entered."}`,
		error: `The page changed, so ${some ? "only your username" : "nothing"} was entered. ${agent} was told and can ask again.`,
	};
}

/** Open the window for a wait, or the one already open. It takes the focus only for the user's own click. */
export async function openSignIn(id: string, focused: boolean): Promise<void> {
	const url = `${chrome.runtime.getURL(SIGN_IN_PAGE)}#${id}`;
	const open = (await chrome.tabs.query({})).find((t) => t.url === url);
	if (open) {
		if (focused) await chrome.windows.update(open.windowId, { focused: true });
		return;
	}
	await chrome.windows.create({ url, type: "popup", width: 400, height: 440, focused });
}

/** The wait a window belongs to, while it is open. */
export async function signInWait(id: string): Promise<PendingHandback | undefined> {
	const data = await chrome.storage.session.get(HANDBACK_KEY);
	return openHandbacks(data[HANDBACK_KEY], Date.now()).find((p) => p.id === id && p.signIn);
}
