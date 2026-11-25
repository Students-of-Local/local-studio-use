/**
 * What agents changed on sites and the person hasn't looked at yet: the list behind the cards in the side panel
 * (site-edits/panel.ts). Kept for the browser's run only; the edits themselves are in store.ts.
 */

import type { EditKind, SiteEdit } from "./common.js";

export const CHANGES_KEY = "tk-site-changes";
/** A card without a script closes by itself after this long. */
export const CARD_MS = 60_000;
const MAX_CHANGES = 50;

export interface SiteChange {
	/** The edit's id. */
	id: string;
	host: string;
	kind: EditKind;
	who: string;
	/** For an update: what Undo puts back. */
	before?: { value: string; note: string };
	at: number;
}

/** The changes still shown, oldest first. A script waits for an answer; the rest age out. */
export function openChanges(raw: unknown, now: number): SiteChange[] {
	if (!Array.isArray(raw)) return [];
	return (raw as SiteChange[]).filter(
		(c) => c && typeof c.id === "string" && typeof c.at === "number" && (c.kind === "script" || now - c.at < CARD_MS),
	);
}

async function write(fn: (now: SiteChange[]) => SiteChange[]): Promise<void> {
	await navigator.locks.request(CHANGES_KEY, async () => {
		const data = await chrome.storage.session.get(CHANGES_KEY);
		await chrome.storage.session.set({ [CHANGES_KEY]: fn(openChanges(data[CHANGES_KEY], Date.now())) });
	});
}

/** An agent saved or changed an edit. A second change to the same edit keeps the first one's `before`. */
export function noteChange(edit: SiteEdit, who: string, before?: SiteChange["before"]): Promise<void> {
	return write((list) => {
		const had = list.find((c) => c.id === edit.id);
		const entry: SiteChange = {
			id: edit.id,
			host: edit.host,
			kind: edit.kind,
			who: who.slice(0, 60),
			...(had ? (had.before ? { before: had.before } : {}) : before ? { before } : {}),
			at: Date.now(),
		};
		return [...list.filter((c) => c.id !== edit.id), entry].slice(-MAX_CHANGES);
	});
}

/** The person answered these, or the edits are gone. */
export function clearChanges(ids: readonly string[]): Promise<void> {
	return write((list) => list.filter((c) => !ids.includes(c.id)));
}
