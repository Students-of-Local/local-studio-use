/**
 * "Give this tab to Local Studio" in the service worker: the menu on a page and on the toolbar icon (state.ts says what
 * each item does). The menu follows the session table, so a new agent gets its item and one long gone loses it.
 */

import { BrowserSession, listSessions, SESSIONS_KEY } from "../browser/session.js";
import { CHANGE_SITE_KEY, HANDOFF_KEY, type Handoff, itemTarget, menuItems } from "./state.js";

/** Opens the window's side panel. Must run in the click's tick: Chrome opens it only inside a user gesture. */
type OpenPanel = (windowId: number, source: string) => void;

let openPanel: OpenPanel = () => undefined;
let log: (line: string) => void = () => undefined;
let building: Promise<void> = Promise.resolve();
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

/** Replace the menu with the items for the sessions stored now. */
function rebuild(): Promise<void> {
	building = building.then(async () => {
		const sessions = await listSessions().catch(() => []);
		const items = menuItems(sessions, Date.now());
		await chrome.contextMenus.removeAll();
		for (const item of items)
			await new Promise<void>((resolve) => {
				chrome.contextMenus.create(
					{
						id: item.id,
						title: item.title,
						contexts: item.pageOnly ? ["page", "frame"] : ["page", "frame", "action"],
						documentUrlPatterns: ["http://*/*", "https://*/*", ...(item.pageOnly ? [] : ["file:///*"])],
					},
					() => {
						// A duplicate id from a rebuild that overlapped this one is harmless.
						void chrome.runtime.lastError;
						resolve();
					},
				);
			});
	});
	building = building.catch(() => undefined);
	return building;
}

function rebuildSoon(): void {
	if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(() => {
		rebuildTimer = undefined;
		void rebuild();
	}, 250);
}

/**
 * A menu item was clicked on `tab`. The panel opens first, with nothing awaited before it, and the note for it follows.
 * Exported (and reachable as the worker's `__localStudioGiveTab`) so the panel e2e test can click without a real menu.
 */
export function onMenuClick(info: { menuItemId: string | number }, tab: chrome.tabs.Tab | undefined): void {
	const target = itemTarget(info.menuItemId);
	if (!target || tab?.id === undefined || tab.windowId === undefined) return;
	const tabId = tab.id;
	if (target.kind === "panel") {
		openPanel(tab.windowId, "give-tab");
		const note: Handoff = { windowId: tab.windowId, tabId, at: Date.now() };
		chrome.storage.session.set({ [HANDOFF_KEY]: note }).catch(() => undefined);
		log(`handoff: tab=${tabId} to the side panel`);
		return;
	}
	if (target.kind === "site") {
		openPanel(tab.windowId, "change-site");
		const note: Handoff = { windowId: tab.windowId, tabId, at: Date.now() };
		chrome.storage.session.set({ [CHANGE_SITE_KEY]: note }).catch(() => undefined);
		return;
	}
	void (async () => {
		const session = await BrowserSession.existing(target.sessionId);
		if (!session || session.ended) return;
		await session.userGave(tabId, tab, "menu");
		log(`handoff: tab=${tabId} to ${target.sessionId}`);
	})().catch((err) => log(`handoff: tab=${tabId} failed: ${err instanceof Error ? err.message : String(err)}`));
}

/** Build the menu and listen for clicks. Call once per worker start. */
export function startHandoff(open: OpenPanel, logger?: (line: string) => void): void {
	openPanel = open;
	if (logger) log = logger;
	if (!chrome.contextMenus) return;
	chrome.contextMenus.onClicked.addListener((info, tab) => onMenuClick(info, tab));
	chrome.runtime.onInstalled.addListener(() => void rebuild());
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && SESSIONS_KEY in changes) rebuildSoon();
	});
	void rebuild();
	(globalThis as { __localStudioGiveTab?: typeof onMenuClick }).__localStudioGiveTab = onMenuClick;
}
