import { html, nothing, type TemplateResult } from "lit";
import type { TabInfo } from "../tools/navigate.js";

export function TabPill(tab: TabInfo, clickable = true): TemplateResult {
	const handleClick = async () => {
		if (!clickable) return;
		try {
			// Activate the tab
			await chrome.tabs.update(tab.id, { active: true });
			// Focus the window containing the tab
			if (tab.active === false) {
				const tabs = await chrome.tabs.query({});
				const foundTab = tabs.find((t: chrome.tabs.Tab) => t.id === tab.id);
				if (foundTab?.windowId) {
					await chrome.windows.update(foundTab.windowId, { focused: true });
				}
			}
		} catch (err) {
			console.error("Failed to switch to tab:", err);
		}
	};

	return html`
		<div
			class="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-card border border-border rounded-lg ${
				clickable ? "cursor-pointer hover:bg-accent/50 transition-colors" : ""
			}"
			@click=${clickable ? handleClick : null}
			title="${tab.url}"
		>
			${
				// The tab's own icon or none: no favicon service ever sees the host.
				tab.favicon ? html`<img src="${tab.favicon}" alt="" class="w-4 h-4 flex-shrink-0" />` : nothing
			}
			<span class="text-foreground truncate max-w-[200px]">${tab.title}</span>
			${tab.active ? html`<span class="text-green-600 dark:text-green-500 text-[10px] font-medium">●</span>` : ""}
		</div>
	`;
}
