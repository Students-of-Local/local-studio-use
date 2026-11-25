import { PAGE_METHODS } from "./protocol.js";

/**
 * `private: true` beside a page's `url` when its tab is in an incognito window, so nothing is looked up for that page
 * outside the browser. A tab that can't be looked up counts as one.
 */
export async function markPrivate(method: string, result: unknown, currentTab?: number): Promise<unknown> {
	if (!PAGE_METHODS.has(method) || !result || typeof result !== "object" || !("url" in result)) return result;
	const id = "tabId" in result && typeof result.tabId === "number" ? result.tabId : currentTab;
	const tab = id === undefined ? undefined : await chrome.tabs.get(id).catch(() => undefined);
	return tab && !tab.incognito ? result : { ...result, private: true };
}
