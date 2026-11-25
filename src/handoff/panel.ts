/**
 * The side panel's half of "Give this tab to Local Studio" (state.ts): take the worker's note for this window, once.
 */

import { CHANGE_SITE_KEY, freshHandoff, HANDOFF_KEY } from "./state.js";

/** The tab given to this window's panel in the last few seconds, if any. The note is removed, so only one panel acts. */
export async function takeHandoff(windowId: number, key = HANDOFF_KEY): Promise<number | undefined> {
	const data = await chrome.storage.session.get(key).catch(() => ({}) as Record<string, unknown>);
	const note = freshHandoff(data[key], windowId, Date.now());
	if (!note) return undefined;
	await chrome.storage.session.remove(key).catch(() => undefined);
	return note.tabId;
}

/** Call `onTab` each time a tab is given to this window's open panel. */
export function watchHandoff(windowId: number, onTab: (tabId: number) => void): void {
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "session" || !(HANDOFF_KEY in changes)) return;
		if (!freshHandoff(changes[HANDOFF_KEY].newValue, windowId, Date.now())) return;
		void takeHandoff(windowId).then((tabId) => {
			if (tabId !== undefined) onTab(tabId);
		});
	});
}

/** Call `open` when "Change this site" was clicked in this window, just now or while the panel is open. */
export function watchChangeSite(windowId: number, open: () => void): void {
	const take = () =>
		void takeHandoff(windowId, CHANGE_SITE_KEY).then((tabId) => {
			if (tabId !== undefined) open();
		});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "session" && changes[CHANGE_SITE_KEY]?.newValue) take();
	});
	take();
}
