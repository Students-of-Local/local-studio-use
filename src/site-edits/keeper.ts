/**
 * Keeps the site changes with Local Studio (service worker side). After each change, and when the native host connects,
 * the whole list goes to the host, which writes ~/.local-studio/browser/sites.json. A browser that has never had a change
 * of its own takes the ones kept there, so a reinstall or a second browser starts with them; scripts arrive off.
 */

import type { ExtSites, HostSites } from "../bridge/protocol.js";
import { withDocument } from "./saved.js";
import { change, load, newId, STORAGE_KEY } from "./store.js";

/** Hosts no edit may reach (cli/src/guarded-hosts.ts), as the host last named them. */
export const GUARDED_KEY = "tk-guarded-hosts";
const DEBOUNCE_MS = 500;

type Send = (message: ExtSites) => boolean;

let send: Send = () => false;
let timer: ReturnType<typeof setTimeout> | undefined;

export async function guardedHosts(): Promise<string[]> {
	const data = await chrome.storage.local.get(GUARDED_KEY);
	const hosts: unknown = data[GUARDED_KEY];
	return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
}

async function sendSites(): Promise<void> {
	if (!(STORAGE_KEY in (await chrome.storage.local.get(STORAGE_KEY)))) return;
	const { edits, adBlock } = await load();
	send({ type: "sites", edits, adBlock });
}

/** What the host keeps, sent as it connects. */
export async function onHostSites(message: HostSites): Promise<void> {
	const guarded = Array.isArray(message.guardedHosts)
		? message.guardedHosts.filter((h): h is string => typeof h === "string")
		: [];
	await chrome.storage.local.set({ [GUARDED_KEY]: guarded });
	if (message.saved && !(STORAGE_KEY in (await chrome.storage.local.get(STORAGE_KEY))))
		await change((state) => {
			// A change made while this one waited its turn is the person's: theirs stays, and the file isn't taken.
			if (state.edits.length) return { state, result: undefined };
			const taken = withDocument(state, message.saved, guarded, newId, Date.now());
			return {
				state: taken ? { ...taken.state, adBlock: message.saved?.adBlock === true } : state,
				result: undefined,
			};
		});
	await sendSites();
}

/** Wire it into the worker. `sender` posts to the native host (false when there is none). */
export function startSiteKeeper(sender: Send): void {
	send = sender;
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local" || !(STORAGE_KEY in changes)) return;
		clearTimeout(timer);
		timer = setTimeout(() => void sendSites().catch(() => undefined), DEBOUNCE_MS);
	});
}
