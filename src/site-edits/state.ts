/** The saved list, as the panel reads it: no checks, so nothing here carries the Public Suffix List (store.ts). */

import { type SiteEdit, STORAGE_KEY } from "./common.js";

export interface SiteEditsState {
	edits: SiteEdit[];
	adBlock: boolean;
}

/** Storage, through the one key. */
export async function load(): Promise<SiteEditsState> {
	const data = await chrome.storage.local.get(STORAGE_KEY);
	const raw = data[STORAGE_KEY] as Partial<SiteEditsState> | undefined;
	return { edits: Array.isArray(raw?.edits) ? raw.edits : [], adBlock: raw?.adBlock === true };
}
