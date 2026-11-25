/**
 * Links in the service worker (src/links/parse.ts). Two ways in, and they differ:
 *  - a click in the side panel runs any link. It comes over a port only the side panel document may open, with a fresh
 *    one-use token (src/connect/gate.ts). Nothing an agent or a page can call reaches this.
 *  - an agent may open a settings place (its own section, a browser page, the computer's settings) by itself, at most 6 a
 *    minute, and may offer buttons the person clicks. Neither changes anything.
 * The browser's pages open here; what belongs to the computer goes to the native host, which parses the link again.
 */

import { agentDisplayName } from "../ask/core.js";
import { showWaiting } from "../attention/badge.js";
import { ERR, type ExtOpen, type HostOpen, type RpcError } from "../bridge/protocol.js";
import { GestureGate, isSidePanelPort } from "../connect/gate.js";
import { isExtensionPage } from "../subscriptions/relay-protocol.js";
import { BROWSER_PAGES, type Link, linkText, PANES, parseLink, parsePlace, SECTIONS } from "./parse.js";
import {
	LINKS_PORT,
	type LinkReply,
	OFFER_LINKS_MAX,
	OFFER_MS,
	OFFER_NOTE_MAX,
	OFFERS_KEY,
	type Offer,
	OPEN_PLACE,
	SHOW_SETTINGS_KEY,
	type ShowSettings,
} from "./types.js";

const ANSWER_MS = 10_000;
/** Settings places one agent may open in a minute. */
export const PLACES_A_MINUTE = 6;
const MINUTE = 60_000;
/** A section nobody saw is not sprung on the person much later. */
export const SHOW_MS = 10 * 60_000;

type Done = { done: string } | { error: RpcError };
const refused = (code: string, message: string): Done => ({ error: { code, message } as RpcError });

let send: (message: ExtOpen) => boolean = () => false;
let seq = 0;
const waiting = new Map<number, (answer: Done) => void>();
const opened = new Map<string, number[]>();

export function onOpen(message: HostOpen | "disconnected"): void {
	if (message === "disconnected") {
		for (const done of [...waiting.values()])
			done(refused(ERR.INTERNAL, "Local Studio's helper went away. Try again."));
		return;
	}
	const { result, error } = message;
	waiting.get(message.id)?.(error ? { error } : { done: typeof result?.done === "string" ? result.done : "Done." });
}

function askHost(link: Link): Promise<Done> {
	const id = ++seq;
	return new Promise((resolve) => {
		const finish = (answer: Done) => {
			clearTimeout(timer);
			waiting.delete(id);
			resolve(answer);
		};
		const timer = setTimeout(
			() => finish(refused(ERR.INTERNAL, "Local Studio's helper didn't answer. It may need an update.")),
			ANSWER_MS,
		);
		waiting.set(id, finish);
		if (!send({ type: "open", id, link: linkText(link) }))
			finish(refused(ERR.INTERNAL, "Local Studio's helper isn't running, and only it can open that."));
	});
}

async function run(link: Link): Promise<Done> {
	if (link.kind === "browser") {
		await chrome.tabs.create({ url: BROWSER_PAGES[link.page].url, active: true });
		return { done: `Opened the browser's ${BROWSER_PAGES[link.page].label}.` };
	}
	return askHost(link);
}

// ---- what agents may do

async function panelIsOpen(): Promise<boolean> {
	const found = await chrome.runtime.getContexts?.({ contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType] });
	return (found?.length ?? 0) > 0;
}

/** At most PLACES_A_MINUTE for one agent. */
function mayOpen(clientId: string, now = Date.now()): boolean {
	const recent = (opened.get(clientId) ?? []).filter((at) => now - at < MINUTE);
	opened.set(clientId, recent);
	if (recent.length >= PLACES_A_MINUTE) return false;
	recent.push(now);
	return true;
}

export async function openPlace(client: { clientId: string; name: string }, place: unknown): Promise<Done> {
	const link = parsePlace(place);
	if (!link)
		return refused(
			ERR.BAD_PARAMS,
			`place is settings/<${Object.values(SECTIONS).join("|")}>, browser/<${Object.keys(BROWSER_PAGES).join("|")}> or system/<${Object.keys(PANES).join("|")}>.`,
		);
	if (!mayOpen(client.clientId))
		return refused(
			ERR.PERMISSION_DENIED,
			`That is ${PLACES_A_MINUTE} settings places in a minute. Wait, or use offer_buttons.`,
		);
	if (link.kind !== "settings") return run(link);
	const show: ShowSettings = {
		section: SECTIONS[link.section],
		agentName: agentDisplayName(client.name),
		at: Date.now(),
	};
	await chrome.storage.session.set({ [SHOW_SETTINGS_KEY]: show });
	if (await panelIsOpen()) return { done: `Local Studio's settings now show ${show.section}.` };
	await showWaiting("settings", [show]);
	return { done: `The side panel is closed. ${show.section} shows when the person opens it; its icon has a badge.` };
}

let offerOps: Promise<unknown> = Promise.resolve();
function editOffers(edit: (list: Offer[]) => Offer[]): Promise<void> {
	const run = offerOps.then(async () => {
		const data = await chrome.storage.session.get(OFFERS_KEY);
		const list = (data[OFFERS_KEY] as Offer[] | undefined) ?? [];
		const now = Date.now();
		await chrome.storage.session.set({ [OFFERS_KEY]: edit(list.filter((o) => now - o.at < OFFER_MS)) });
	});
	offerOps = run.catch(() => undefined);
	return run;
}

/** One card of buttons above the chat, in place of the agent's last one. */
export async function offerButtons(
	client: { clientId: string; name: string },
	params: Record<string, unknown>,
): Promise<Done> {
	const { note = "", links, ...more } = params;
	if (Object.keys(more).length > 0) return refused(ERR.BAD_PARAMS, "offer_buttons takes note and links.");
	if (typeof note !== "string" || note.length > OFFER_NOTE_MAX)
		return refused(ERR.BAD_PARAMS, `note is text of at most ${OFFER_NOTE_MAX} characters.`);
	if (!Array.isArray(links) || links.length < 1 || links.length > OFFER_LINKS_MAX)
		return refused(ERR.BAD_PARAMS, `links holds 1 to ${OFFER_LINKS_MAX} localstudio: links.`);
	const parsed = links.map(parseLink);
	const bad = parsed.indexOf(undefined);
	if (bad >= 0) return refused(ERR.BAD_PARAMS, `links[${bad}] is not a localstudio: link.`);
	const offer: Offer = {
		clientId: client.clientId,
		agentName: agentDisplayName(client.name),
		note,
		links: (parsed as Link[]).map(linkText),
		at: Date.now(),
	};
	await editOffers((list) => [...list.filter((o) => o.clientId !== client.clientId), offer].slice(-4));
	if (await panelIsOpen()) return { done: "Shown." };
	await showWaiting("offers", [offer]);
	return { done: "Shown when the person opens the side panel; its icon has a badge." };
}

/** Wire the panel's port and its own agent's message. `sender` posts to the native host (false when there is none). */
export function startLinks(sender: (message: ExtOpen) => boolean): void {
	send = sender;
	const origin = chrome.runtime.getURL("");
	const gate = new GestureGate();
	chrome.runtime.onConnect?.addListener((port) => {
		if (port.name !== LINKS_PORT) return;
		if (!isSidePanelPort(port.sender, origin)) return port.disconnect();
		// The panel is open now: what waited behind the badge shows there.
		void showWaiting("settings", []);
		void showWaiting("offers", []);
		port.onMessage.addListener((raw: unknown) => {
			const { id, link: text, gesture } = (raw ?? {}) as { id?: unknown; link?: unknown; gesture?: unknown };
			if (typeof id !== "number") return;
			const reply = (answer: Done) => port.postMessage({ id, ...answer } satisfies LinkReply);
			const link = parseLink(text);
			const token = gesture as { token?: unknown; at?: unknown } | undefined;
			if (!link || link.kind === "settings") return reply(refused(ERR.BAD_PARAMS, "That is not a link."));
			if (
				typeof token?.token !== "string" ||
				typeof token.at !== "number" ||
				!gate.spend({ token: token.token, at: token.at })
			)
				return reply(refused("no_gesture", "Click the button again."));
			run(link).then(reply, (err) => reply(refused(ERR.INTERNAL, err instanceof Error ? err.message : String(err))));
		});
	});
	chrome.runtime.onMessage?.addListener((message, from, answer) => {
		if (message?.type !== OPEN_PLACE || !isExtensionPage(from, origin)) return undefined;
		openPlace({ clientId: "panel", name: "Local Studio" }, message.place).then(answer, (err) =>
			answer(refused(ERR.INTERNAL, String(err))),
		);
		return true;
	});
}
